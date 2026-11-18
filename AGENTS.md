# gentle-emote

Fork of pi-emote: animated pixel-art Gentleman avatar for the Pi / Gentle Shell TUI. Displays a reactive avatar that changes expression based on agent activity (thinking, talking, reading, writing, tool use, etc.).

## Output commands and defaults

All four output groups default to off independently; keep the extension's `enabled: true` to make commands available.

| Output | Commands | Scope |
|--------|----------|-------|
| Terminal avatar | `/emote internalOn`, `/emote internalOff` | Terminal graphics/ASCII only |
| Local simulators | `/emote localOn`, `/emote localOff` | Configured loopback targets; existing `debug.json` preference key is unchanged |
| Ulanzi D200 key | `/emote d200On`, `/emote d200On <port>`, `/emote d200Off` | Dedicated mirror at `127.0.0.1:8003`; the port is session-local |
| LED/ESP32 display | `/emote displayOn`, `/emote displayOn <address>`, `/emote displayOff` | Configured non-loopback targets, or the named board |
| USB serial display | `/emote usbOn`, `/emote usbOn <port>`, `/emote usbOff` | One CDC display at most; the port is session-local |

The USB serial output speaks the firmware wire protocol v1 (`src/serial_protocol.ts`) through an optional, lazily imported `serialport`, is success-gated (a failed open or refused port persists nothing), and never keeps more than one frame in flight. Each command persists its boolean globally under `<agent dir>/extensions/gentle-emote/output-states/<output>.json`, independent of project configuration. The agent dir is `PI_CODING_AGENT_DIR`, or `~/.pi/agent`. Saved choices survive project changes, restarts and reloads; running sessions restore changes from other sessions at their next start/reload. Commands affect their current session immediately. They never rewrite `config.json` — with two documented exceptions: `/emote displayOn <address>` rewrites the `externalDisplay` LED destination in the **user-global** config, because a named board has to survive `/reload`; it replaces non-loopback targets, keeps loopback targets and every unrelated key, writes atomically and fails closed on an unreadable or non-object file. `d200On <port>` writes nothing: the port is this session's only and returns to `GENTLE_EMOTE_D200_PORT`/`8003` at the next start. Debug/display delivery still requires valid enabled configured destinations. Tests must use temporary agent directories, never the real user profile. Malformed preferences fail closed with a warning; failed saves leave the current output unchanged.

## Persistent avatar selection

`/emote avatar <folder>` immediately selects a direct child of an `emotes` directory;
`/emote avatar` shows usage/current choice, and `/emote avatar auto` restores automatic
model/thinking-level mappings using current event identity. Save globally as a name string
or `null` at `<agent dir>/extensions/gentle-emote/avatar.json`, separate from config and outputs.
Save before live mutation. Manual choices survive restart/project changes and model/thinking
changes; missing saved sets warn and fall back without overwriting the preference.

Use `src/avatar_selection.ts` for bounded manual selection, restoration, completion and YOLO
twin validation, not the legacy fallback resolver. Project/user/extension precedence applies;
only usable direct layouts are offered, with deduplicated deterministic full argument completions.
Reject path syntax/control characters and realpath escapes through roots, sets, configuration,
state directories or frames before loading. Checks do not lock against concurrent replacement.
Tests use isolated temporary agent directories; never alter user avatar assets to normalize layouts.
PNG selections must remain selected for external delivery when the terminal is hidden or ASCII.

## Control panel

`/emote` with no argument (or `/emote panel`) opens an interactive panel built with `ctx.ui.custom()`. It stays inside this package on purpose: `gentle-shell` is a separate package installed from a pinned tag, so owning the panel here keeps upstream updates conflict-free and needs no cross-package protocol.

The panel holds no state of its own. Every row is rebuilt from the extension's live truth (`src/panel.ts` is a pure view model with its own tests), every switch runs the command entry point instead of duplicating persistence or ownership logic, and nothing renders a destination, route or credential. Persistence follows one rule: what only makes sense for the current session stays session-local (the per-destination clock mode, which never writes anything), while what shapes every avatar is written to the user-global config (size, placement, frame, accent) through `src/config_write.ts`, the panel's second documented exception to "commands never rewrite `config.json`". That writer accepts only those four keys, validates every value, writes atomically through a temporary sibling and a rename, preserves unrelated keys, fails closed on an unreadable or non-object file, and never touches a project layer or enables an output. LED layout keys (`outline`, `background`, `backgroundCoverage`) and the D200 key stay out of the panel: the panel layout cannot be altered and the key only mirrors the avatar.

## Configuration

pi-emote uses layered configuration with deep merge. Higher-priority layers override lower ones field-by-field.

### Priority (lowest → highest)

| Layer | Path | Purpose |
|-------|------|---------|
| Extension defaults | `<ext-dir>/config.json` | Shipped defaults |
| User global | `~/.pi/agent/extensions/gentle-emote/config.json` | Personal preferences |
| Project local | `.pi/extensions/gentle-emote/config.json` | Project-specific overrides |

### Config Fields

```json
{
  "enabled": true,
  "debug": false,
  "size": 8,
  "readingSpeed": 4,
  "hideBelow": 80,
  "holdDuration": {
    "hi": 2000,
    "success": 1200,
    "failure": 1200
  },
  "blinkInterval": [3000, 6000],
  "talkTickMs": 120,
  "cycleMs": 500,
  "emotes": [
    { "model": "*", "emote-set": "default" }
  ],
  "terminals": [
    { "match": "zellij", "render": "ascii" },
    { "match": "tmux", "render": "auto" },
    { "match": "screen", "render": "ascii" },
    { "match": "wezterm", "render": "iterm2" },
    { "match": "ghostty", "render": "kitty" }
  ]
}
```

- **enabled** — Toggle the widget on/off.
- **debug** — Enable debug logging to `debug.log` in the extension directory.
- **size** — Avatar width in terminal cells.
- **readingSpeed** — Words per second used to pace talk animation duration.
- **hideBelow** — Hide widget when terminal is narrower than this (columns).
- **holdDuration** — How long (ms) to display hi/success/failure before transitioning.
- **blinkInterval** — Random range `[min, max]` (ms) between idle blinks and think swaps.
- **talkTickMs** — Interval (ms) between mouth frame changes during talk.
- **cycleMs** — Frame cycle interval (ms) for read/write/tool animations.
- **emotes** — Model-to-emote-set mapping (see below).
- **terminals** — Terminal-to-renderer mapping (see below).

You only need to include fields you want to override. Unspecified fields inherit from lower-priority layers.

### Minimal Override Example

```json
{
  "size": 12,
  "holdDuration": { "hi": 3000 }
}
```

This changes only `size` and `holdDuration.hi`; all other settings keep their defaults.

## Emote Sets

Emote sets are directories containing frame images organized by state.

### Model-Based Selection

The `emotes` array maps model IDs to emote sets using glob patterns:

```json
{
  "emotes": [
    { "model": "*", "emote-set": "default" },
    { "model": "*opus*", "emote-set": "serious-avatar" },
    { "model": "*flash*", "emote-set": "speedy" }
  ]
}
```

- Patterns use glob syntax (`*` = any characters, `?` = single character).
- Matching is case-insensitive against the model `id` (e.g. `claude-opus-4.6`).
- **Last match wins** — order matters.
- If multiple non-catch-all patterns match, a warning is logged.
- The `emotes` array uses **append** semantics: entries from all config layers are concatenated (extension → user → project). Since last match wins, higher-priority layers naturally override lower ones. An empty array `[]` is treated as "not set" and skipped.

## Terminal Renderer Overrides

The `terminals` array maps detected terminal/multiplexer names to specific image renderers. This patches cases where pi-tui's auto-detection is incorrect.

### How It Works

1. **Multiplexer detection** (checked first): env vars like `ZELLIJ`, `TMUX`, `TERM=screen*` identify multiplexers.
2. **Terminal detection**: `TERM_PROGRAM`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, etc. identify the terminal emulator.
3. **Whitelist lookup**: the detected name is matched against the `terminals` array — first match wins.
4. **Fallback**: if no match, pi-tui's `getCapabilities().images` is used.

### Detected Names

| Name | Detected via |
|------|-------------|
| `zellij` | `$ZELLIJ_SESSION_NAME` or `$ZELLIJ` |
| `tmux` | `$TMUX` or `$TERM` starts with `tmux` |
| `screen` | `$TERM` starts with `screen` |
| `kitty` | `$KITTY_WINDOW_ID` or `$TERM_PROGRAM=kitty` |
| `ghostty` | `$GHOSTTY_RESOURCES_DIR` or `$TERM_PROGRAM=ghostty` |
| `wezterm` | `$WEZTERM_PANE` or `$TERM_PROGRAM=WezTerm` |
| `iterm2` | `$ITERM_SESSION_ID` or `$TERM_PROGRAM=iTerm.app` |
| `vscode` | `$TERM_PROGRAM=vscode` |
| `alacritty` | `$TERM_PROGRAM=alacritty` |
| `unknown` | Nothing matched |

### Render Values

- `"kitty"` — Kitty graphics protocol (direct passthrough, experimental in tmux)
- `"kitty-unicode"` — Kitty Unicode placeholders (pane-safe, experimental in tmux)
- `"iterm2"` — iTerm2 inline image protocol (experimental in tmux)
- `"ascii"` — Text-only fallback
- `"auto"` — Auto-detect: checks passthrough support and detects outer terminal

### Shipped Defaults

```json
{
  "terminals": [
    { "match": "zellij", "render": "ascii" },
    { "match": "tmux", "render": "auto" },
    { "match": "screen", "render": "ascii" },
    { "match": "wezterm", "render": "iterm2" },
    { "match": "ghostty", "render": "kitty" }
  ]
}
```

tmux defaults to `"auto"` — auto-detects the outer terminal. Ghostty and kitty get `kitty-unicode` (pane-safe image rendering); other outer terminals fall back to ASCII with a helpful message. Other multiplexers (zellij, screen) default to `"ascii"`. WezTerm uses iTerm2 protocol (more reliable than Kitty on WezTerm). Terminals not listed (e.g., kitty, iterm2) fall through to pi-tui auto-detection.

### tmux Requirements

For image rendering through tmux (experimental), users need these settings in `tmux.conf`:

```bash
# Required — allow image sequences to pass through to the outer terminal
set -g allow-passthrough on

# Required — detect outer terminal when attaching from a different terminal
set -ga update-environment TERM
set -ga update-environment TERM_PROGRAM

# Recommended — reduces flicker during animation
set -sg escape-time 0
```

After changes, tmux must be fully restarted (`tmux kill-server && tmux`).

The auto-detection flow for tmux (when render is `"auto"`):
1. Check `allow-passthrough` is `on` or `all` via `tmux show-options -g`
2. Detect outer terminal via `tmux show-environment TERM_PROGRAM` (session-level, falls back to global)
3. Map outer terminal to protocol: ghostty/kitty → kitty-unicode (pane-safe), iTerm.app/WezTerm → ascii (no pane-safe renderer available)
4. Use `TmuxKittyUnicodeRenderer` for Ghostty/kitty; all others fall back to ASCII

If the user explicitly configures a concrete render value (`"kitty"`, `"kitty-unicode"`, `"iterm2"`, `"ascii"`) for tmux, all auto-detection and warnings are skipped.

### Override Example

To force ASCII for tmux (disable image auto-detection):

```json
{
  "terminals": [
    { "match": "tmux", "render": "ascii" }
  ]
}
```

Or force a specific renderer:

```json
{
  "terminals": [
    { "match": "tmux", "render": "kitty-unicode" }
  ]
}
```

Setting a concrete value skips auto-detection and suppresses warnings.

The `terminals` array uses **merge-by-key** semantics: entries are merged by `match` key across all config layers (extension → user → project). Higher-priority layers replace entries with the same key, or append new ones. You only need to include the entries you want to override or add.

### Emote Set Lookup

When resolving an emote set name, pi-emote searches these locations in order:

1. **Project:** `.pi/extensions/gentle-emote/emotes/<set-name>/`
2. **User:** `~/.pi/agent/extensions/gentle-emote/emotes/<set-name>/`
3. **Extension:** `<ext-dir>/emotes/<set-name>/`
4. **Fallback:** `<ext-dir>/emotes/default/`

### Directory Structure

Each emote set directory contains state subdirectories with PNG frames:

```
emotes/<set-name>/
├── emotes.json          # Frame configuration (optional)
├── hi/
│   └── *.png
├── idle/
│   ├── idle.png
│   └── idle_blink.png
├── think/
│   └── *.png              # cycles in filename order
├── talk/
│   ├── close.png
│   ├── open_small.png
│   └── open_wide.png
├── read/
│   └── *.png
├── write/
│   └── *.png
├── tool/
│   └── *.png
├── success/
│   └── *.png
├── failure/
│   └── *.png
└── compact/
    └── *.png
```

### emotes.json (per set)

Optional file inside each emote set to configure frame behavior:

```json
{
  "idle": {
    "default": "idle.png",
    "blink": "idle_blink.png"
  },
  "talk": {
    "weights": {
      "close.png": 1,
      "open_small.png": 3,
      "open_wide.png": 1
    }
  }
}
```

### Creating a Custom Emote Set

1. Create the directory in the appropriate location:
   ```bash
   mkdir -p ~/.pi/agent/extensions/gentle-emote/emotes/my-avatar/{idle,think,talk,read,write,tool,hi,success,failure,compact}
   ```

2. Add PNG frames to each state directory. Not all states are required — missing states will have no animation for that action.

3. Optionally add `emotes.json` for frame configuration.

4. Map a model to your set in config:
   ```json
   {
     "emotes": [
       { "model": "*", "emote-set": "default" },
       { "model": "*opus*", "emote-set": "my-avatar" }
     ]
   }
   ```

### Project-Wide Override

To use a single custom emote for all models in a project:

`.pi/extensions/gentle-emote/config.json`:
```json
{
  "emotes": [
    { "model": "*", "emote-set": "project-mascot" }
  ]
}
```

Place the frames in `.pi/extensions/gentle-emote/emotes/project-mascot/`.
