# Changelog

All notable changes to gentle-emote will be documented in this file. Entries before v0.1.0 belong to [pi-emote](https://github.com/cgxeiji/pi-emote), the upstream project.

## gentle-emote v0.2.0

### Changed
- **Display status copy for busy work** — the avatar PNG's status row spells busy activity as `WORKING` instead of `BUSY`: same amber ink, same yellow subagent count and `999+` cap, and every label priority (published ODD phase, subagent and error handling) unchanged. This is display copy only — internal status, the phase row, timers and the `X-Emote-Status: busy` protocol header stay `busy`, and Gentle Shell's own Working/exploring indicators are untouched.
- **The D200 mirror is fully session-local (enabled state and port)** — `/emote d200On`, `/emote d200On <port>` and `/emote d200Off` persist nothing, so every new session and `/reload` starts the mirror **off**, and `d200Off` → bare `d200On` keeps the session's port choice. A legacy `output-states/d200.json` left by an older version is ignored silently — never read, never warned about and never rewritten. Repeated `d200On` on the same port stays idempotent, a new port replaces the live sender, at most one sender exists per session, and a refused port changes nothing. The panel and `/emote status` keep showing the live D200 truth (never stored state) through the same command entry point.
- **Default output states** — the local simulators output (`/emote localOn`, saved under the legacy `debug` preference key) is **on by default when no preference exists**; the `internal`, `display` and `usb` outputs are **off by default** and each On/Off command saves its own global boolean under `<agent dir>/extensions/gentle-emote/output-states/<output>.json`, surviving restarts, `/reload` and project changes, with running sessions restoring changes from other sessions at their next start/reload. Saved booleans always win and malformed preferences fail closed with a warning. The diagnostic `/emote debugOn` / `/emote debugOff` is a different, session-local switch: written nowhere, it never enables or disables any output.
- **Global PNG appearance ownership** — `externalDisplay.transparentBackground`, `background` and `backgroundCoverage` (including their per-target equivalents) belong to extension defaults plus user-global `config.json` only: project layers may replace destinations but cannot override these appearance keys, and global per-target appearance is reapplied by canonical URL after project routes are resolved (invalid global appearance stays fail-closed). Physical non-loopback HTTP LED and USB CDC outputs always composite opaque PNGs, even when global transparency is true; loopback/simulator alpha stays configurable and the D200 plugin retains ownership of its appearance. These PNG fields are not native desktop window opacity settings.
- **Idle error display label** — with status `error` and phase `idle` and no active subagent, external displays show `IDLE` in the same red instead of `ERROR`; active subagents still show red `SUBAGENTS (n)` / `RUNNING`, and non-idle errors keep red `ERROR`. Internal activity, protocol headers and terminal rendering are unchanged.
- **Selected-state phase label** — the external display PNG's phase row now describes every registered selected state from `/emote demo` under any coarse activity or published work phase, with uppercase -ing action labels (`THINKING`, `TALKING`, `READING`, `WRITING`, `COMPACTING`, `ASKING`, `DELEGATING`, `REMEMBERING`, `EXPLORING`, `BUILDING`, `VERIFYING`, `JUDGING`, `REVIEWING`); the eight ODD phase labels (for example `PLANNING`) and nonverbs (including `SUPER-YOLO`) stay unchanged. Display-only: internal state names, `/emote` command names and protocol headers are not renamed, and the `SUBAGENTS (n)` / `RUNNING` idle exception still wins.
- **Complete demo sequence** — `/emote demo` keeps the original scenes and now includes all eight ODD work phases; the previews publish no work phase and change no agent activity.

### Added
- **USB serial output** — `/emote usbOn` (and `usbOn <port>`) sends avatar frames to the LED panel over USB CDC using the firmware's wire protocol v1: `EMOTE`/`EMOTE_READY`, 18-byte `EMTS` frames with reflected CRC-32 and raw PNG payloads, correlated `EMTR` replies scanned past interleaved console lines, and a clean `EMTE`/`EMOTE_EXIT`. Delivery is stop-and-wait — one frame in flight, one resend on a NACK or a missing reply — and intermediate animation frames are dropped so only the newest reaches the panel. Bare `usbOn` connects directly with exactly one visible serial port, warns and stays off with none, and offers an interactive picker (OS path plus reported metadata) with several; a failed open or a refused port persists nothing, the port stays session-local, and `serialport` remains an optional lazily imported dependency: without it the command warns and every other output keeps working.
- **Interactive control panel** — `/emote` with no argument (or `/emote panel`) opens a modal panel: one switch per output (terminal avatar, local simulators/desktop, D200 with its port, LED/ESP32 with its destination count), each destination's idle-clock mode and deadline, the live activity/phase/PNG truth and the effective appearance, plus avatar cycling, the demo and the status line. Rows rebuild from live state on every draw; arrows or `j`/`k` move, Enter or Space applies, and every switch runs the same command entry point as typing it, so persistence, LED ownership claims and failure paths are identical. Nothing is sent from the panel and a panel failure never reaches the avatar, delivery or the prompt; it is plugin-owned (`ctx.ui.custom()`), so `gentle-shell` is untouched.
- **Panel persistence and a session-local clock switch** — `size`, `placement`, `frame` and `accent` are now editable in the panel and write atomically (validated value, temporary sibling plus rename, unrelated keys preserved, unreadable or non-object files refused untouched, and a failed write changes neither file nor live appearance) to the user-global config of the running agent directory. Every configured destination appears in the CLOCK section with its real mode and can be switched `off` → `receiver` → `silence` for the current session only: nothing is written, and `/reload` returns the configured mode. LED layout keys (`outline`, `background`, `backgroundCoverage`) and the D200 key stay out of the panel by decision.
- **Persistent manual avatar selection and new emote sets** — `/emote avatar <folder>` selects a direct child of an `emotes` directory immediately and saves the choice globally (name or `null`) at `<agent dir>/extensions/gentle-emote/avatar.json`, saved before live mutation; `/emote avatar` shows usage and current choice, and `/emote avatar auto` returns to model/thinking-level mappings. Manual choices survive restarts, project changes and model/thinking changes, are bounded (path syntax, control characters and realpath escapes through roots, sets, configuration, state directories or frames are refused, and the choice stays YOLO-twin validated), and PNG selections remain available when the terminal hides images or renders ASCII. This release ships the new `gentleled` and `gentleemotex` emote sets.
- **`/emote displayOn <address>`** — names the LED/ESP32 board from the command instead of configuration: a host token only (IPv4, bracketed IPv6 or DNS name, optional `:port`) normalized to exactly `http://<address>/emote`, written atomically to the user-global config as the only non-loopback LED destination — other non-loopback targets replaced, loopback targets and unrelated keys preserved, a legacy loopback `url` migrated into `targets`, and unreadable or non-object files failing closed. Scheme, path, credentials, query, fragment, whitespace and loopback addresses are refused without writing or sending anything; a named board survives `/reload`, wins over a project layer pointing elsewhere, and is claimed before its first image. Bare `/emote displayOn` behaves byte for byte as before.
- **`/emote d200On <port>`** — points the D200 key mirror at another TCP port for the current session: a bare decimal port in `1`–`65535`, with `GENTLE_EMOTE_D200_PORT`/`8003` as default and a second explicit port replacing the live sender. Invalid values are refused (`invalid D200 port (1-65535); D200 mirror unchanged`) with nothing sent, and `/emote d200Off` still stops every D200 port.
- **`/emote debugOn` / `/emote debugOff`** — a session-local diagnostic that reveals the otherwise silent `externalDisplay: unsupported frame identifier; skipped` reports at their single producer, so restricted avatar names can be tracked deliberately. Off by default at every startup, session start and `/reload`, written nowhere (no output state, no config), never enabling or disabling any output, and sharing nothing with the saved `debug` preference that `localOn`/`localOff` control or with `config.debug` file logging.
- **`/emote status`** — a read-only diagnostic reporting the truth instead of guessing: the last PNG the renderer actually selected (`state`, `frame` and `set`, honest `PNG none selected yet` before any frame), the effective ODD work phase and its source (`native` bus, `direct` `gentle_odd_phase` fallback or `none`), the coarse activity snapshot (`status`, `phase`, `activeSubagents`), and each destination's idle-clock state anonymously (`; idleClock #1 mode=receiver session=yes remaining=142s carrier=no`, or `; idleClock off` / `; idleClock no destination` when stated). The PNG and the phase are reported side by side, never equated; it changes no animator state or preference, writes nothing, performs no network calls and exposes no base64, destinations, paths or credentials.
- **Native subagent task count** — Gentle Shell publishes every subagent task transition on its native notification bus, and the PNG label and `X-Emote-Active-Subagents` header track that lifecycle: queued/running/waiting count once, terminal states clear it, concurrency counts (2 tasks count 2), session change clears, and the count survives `agent_start`/`agent_end` and compaction. Strictly validated content-free events only: malformed, out-of-order, duplicate or foreign-session events never inflate, go negative or resurrect a finished task; on hosts without the bus the historical call-based counter stays byte-for-byte.
- **Detailed ODD work phase — native bus plus an explicit tool fallback** — when Gentle Shell publishes its session work phase on the shared event bus, the PNG phase row and an optional `X-Emote-Work-Phase` header carry the detailed phase in place of the coarse label; malformed or foreign-session payloads are ignored and the detail clears at agent boundaries. Without the bus, a successful `gentle_odd_phase` tool call adopts its `phase` argument (`authorizing` … `closing`; `clear` drops it) as a direct fallback that never overrides the native phase and clears at turn and session boundaries; start events and failed or malformed calls are no-ops, and **nothing is inferred automatically** — no automatic phase synchronization exists.
- **Work-phase visuals** — the eight detailed ODD work phases (`authorizing`, `exploring`, `researching`, `deciding`, `planning`, `implementing`, `checking`, `closing`) have native 48×40 transparent frames in both built-in sets (two animation frames each, drawn on the same Gentleman bust), re-skinning only the generic `think`/`read`/`write`/`tool` scenes while a phase is published; prompts, failures, compaction, talk, idle and delegation keep their own visuals, a phase clear restores the coarse scene, and sets without phase frames fall back truthfully. `/emote <phase>` previews a phase.
- **Phase elapsed clock** — a visible external-display phase that stays on screen for more than five seconds gains a ticking `MM:SS` clock fed by the existing 1 Hz tick: it follows the resolved visible label, is preserved across new frames of the same phase, resets on every visible phase change and pause/resume, and is never attached to `IDLE`; deduplication and the bounded PNG cache key on the exact phase second. Headers, protocol and terminal rendering are unchanged.
- **Experimental idle clock for external screens** — after more than five uninterrupted idle minutes, enabled simulator, LED/ESP32 and D200 outputs show a native 64×64 `DD/MM/YYYY` / 24-hour clock with larger seconds and original bottom-edge pixel walkers; active subagents, detailed work, busy activity, non-idle errors and explicit non-idle previews reset the deadline, and the terminal avatar and saved preferences are untouched. Receiver metadata truthfully identifies `clock` / `clock.png` / `idle-clock`.
- **Project name metadata and captioned layout** — external-display image requests carry an optional `X-Emote-Project-Name` header (loopback/local destinations, and now every image request — LAN/ESP32 included) with the sending project's working-directory folder basename, and avatar PNGs on every image destination switch to a compact captioned layout whenever a valid name was captured: a green uppercase 3×5 caption above the 48×40 sprite viewport, with the status and phase rows moved down. The name is captured once per sender at session start (and by runtime `/emote d200On`), is never the full path, and is omitted safely — never failing delivery, keeping the legacy layout — when the directory is a filesystem root, the name is empty/blank/oversized, path-like, carries control characters or is malformed Unicode. Heartbeats stay unchanged.

### Fixed
- **Idle clock blocked by a settled error** — a turn whose last tool failed left the host reporting status `error` with phase `idle`, which blocked the idle clock for the rest of the session while every destination went on labelling it red `IDLE`. A settled error now starts the clock exactly like idle: same strict five-minute boundary and shared `idle`/`grandma` budget, `X-Emote-Status: error` still reported truthfully, and running work still cancels the deadline (busy activity, non-idle phase, published work phase, active subagents or an explicit non-idle preview). Red `IDLE` ink in avatar mode is unchanged.
- **Startup greeting ownership** — previews (including explicit idle), agent activity, compaction, blocking prompts, farewells and tool errors cancel the pending 500 ms greeting; returning to idle before the deadline no longer lets a stale greeting take over, and untouched idle startup still greets.
- **Subagent display spelling** — corrected `SUBAGETNS` to `SUBAGENTS` in the external display status label; `RUNNING`, count colors, the `999+` cap and protocol headers are unchanged.

### Docs
- **README** — documents `/reload` restarting the installed version without updating it (what to do when `/emote` does not list a new command), the USB serial output, the interactive panel, persistent manual avatar selection and the global PNG appearance ownership contract.

## gentle-emote v0.1.4

### Fixed
- **Super YOLO** — Gentle Shell's `super-yolo` mode rests on the sun. `yolo` mode keeps the rocket. `read()` reports ON for both, so the mode is what picks the picture.
- **Yes/No** — a confirm such as `Allow guarded git push?` keeps the ask picture on top of whatever execution is running, and returns to that execution when the prompt closes.
- **Grandma wake** — coming back from the grandma waves. The propeller beanie plays only when the session starts.

## gentle-emote v0.1.3

### Changed
- **Mouths** — smiles and open mouths are a dark curve with a tongue. The mustache used to hide every tooth except one pixel in the middle.
- **Hi** — he flies in under a propeller beanie, lands, takes it off and waves.
- **Think** — a light bulb above his head switches on.
- **Talk** — the streamer scene (headphones, podcast mic, ON AIR). A copy is kept in `docs/archive/talk-streamer/`.
- **Read** — deerstalker, pipe and magnifying glass.
- **Remember** — he cups a hand over his mouth and whispers into the Engram elephant's ear. The rim follows the accent color.
- **Build** — welding mask and torch.
- **Delegate** — football coach and exercising robots.
- **Explore** — backpack, three steps, and a flashlight on footprints.
- **Verify** — police officer. A green stamp lands on the robot. A failed verify tool holds a red stamp.
- **Jira** — he launches a rocket into a cloud.
- **Compact** — he shrinks in place. The shirt stays black.
- **Super YOLO** — the YOLO character with a sun instead of the rocket. Preview it with `/emote super-yolo`.

## gentle-emote v0.1.2

### Changed
- **Talk scene** — the Gentleman is now live on stream: headphones, a podcast mic and an ON AIR sign that lights up while he speaks.
- **Talk ends with the reply** — the scene stops half a second after the text finishes streaming instead of "reading" the reply at `readingSpeed`.
- **YOLO in every scene** — a generated `gentleman-yolo` twin set (sunglasses and headband) is swapped in the moment YOLO turns on or off, whatever he is doing. Custom sets can ship their own `<set>-yolo` twin.
- **Grandma sooner** — `grandmaAfterMs` defaults to 30 seconds.

### Fixed
- **Subagent scenes** — `explore`, `build`, `verify`, `judge`, `review` and `jira` changed state without showing any frame.

## gentle-emote v0.1.1

### Fixed
- **Unknown emote set** — a misspelled or missing set now falls back to the Gentleman instead of the removed `default` set, which left no avatar.

### Docs
- **Create your own avatar** — README guide for frames, `emotes.json`, accent key colors, install paths and per-model mapping.
- The state gallery moved from the README to `docs/gallery.md`.

## gentle-emote v0.1.0

### Added
- **Gentleman avatar** — code-generated pixel-art set (`npm run sprites`) with 23 states; the rose and the YOLO headband follow the accent color.
- **Framed avatar beside the prompt** — kitty Unicode placeholders in a rounded frame to the left of the editor; the prompt grows to the frame height (`frame`, `frameRows`).
- **Gentle Shell scenes** — subagents (`delegate`, plus `explore`, `build`, `verify`, `judge`, `review`, `jira` picked from the agent name), background jobs (`jobs`), Engram `mem_save` (`remember`) and a read-only YOLO mode look (`yolo`).
- **Grandma and farewell** — turns into a knitting grandma after `grandmaAfterMs` idle; tips the hat on a goodbye prompt (`farewellPattern`).
- **`/emote` command** — preview any state or play `/emote demo`.

### Removed
- Upstream image sets (`default`, `red`, `aza_choi`, `test`) and the status/theme widget.

## v0.3.0

### Added
- **Multi-line ASCII emotes** — ASCII frames now support 8×4 multi-line canvas with ANSI color codes. Frames can be defined as arrays of strings in `ascii.yaml`.
- **`ascii-bot` emote set** — colored ASCII robot with ANSI green body and yellow eyes. Uses multi-line 8×4 format.
- **ANSI escape support in YAML** — `\x1b`, `\e`, `\n`, `\t`, `\r` escape sequences are now processed in double-quoted strings.
- **Automatic ASCII fallback** — when terminal doesn't support images and configured emote set is image-only, automatically falls back to `ascii-bot`.
- **Thinking level emote mapping** — emote set resolution now matches on thinking level as well as model ID. Entries accept a `thinking-level` selector (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); unset selectors default to `*`, an entry matches when **all** of its selectors match, and last match wins. Emote sets re-resolve live on thinking level changes.
- **Colored info lines** — new `theme` config section colors the info panel: `model-name`, `progress-bar` (default/cache-hit/cache-miss/almost-full), `token-info`, `working-directory`, `border`, and `vertical-separator`. Values are pi theme color tokens or the special `thinking-level-color` flag, which follows the current thinking level's color live. All colors update live when pi's theme changes.
- **Warp terminal support** — new `warpterminal` entry in the terminals config, rendering with the Kitty image protocol.

### Changed
- **ASCII renderer canvas** — fixed 8×4 canvas (8 cols × 4 rows) instead of single-line kaomoji. Frames are vertically centered.
- **YAML parser extended** — supports nested arrays (`string[][]`) for multi-line cycling frames and named multi-line frames.

### Fixed
- **Kitty ghost image artifacts** — previous kitty placements are deleted before re-rendering, since kitty images live on a separate display layer not cleared by `\x1b[2K`.

## v0.2.10

### Added
- **Context usage progress bar** — Visual 20-segment bar with eighth-block granularity. Cache (░) and input (█) portions are shown per segment; input wins when both occupy the same bin.
- **Cache hit rate** — Per-message cache ratio shown in the stats line (⇞).
- **Working directory** — Current directory displayed below stats, shortened with `~`.
- **Token count in bar** — Raw token count displayed alongside percentage.

### Changed
- **Info panel restructured** — Merged thinking level and context window into the model line. Progress bar, cumulative stats (↑↓ cache% $cost), and working directory replace the old context/tokens/cost layout.
- **`formatTokens` uses uppercase `K`** — Kilo suffix now uppercase for consistency.
- **Empty bin char** — Changed from `-` to space for a cleaner look.

## v0.2.9

### Added
- **Red emote**

### Changed
- **hideBelow default to 40** — Fit all content in narrow terminals by default.
- **claude emote** — Claude family of models show red emote by default.

## v0.2.8

### Fixed
- **ASCII YAML escape sequences** — `\"` and `\\` in `ascii.yaml` double-quoted strings are now correctly decoded (e.g. `think hard` and `tool` frames in the default set).

## v0.2.7

### Added
- **Multiple ASCII emote sets** — ASCII sets now use the same resolution/lookup machinery as image sets. Each set is a directory with an `ascii.yaml` file.
- **`ascii-bear` emote set** — bear kaomoji (`ʕ•̫͡•ʔ`) by [@LCorleone](https://github.com/LCorleone).
- **Auto-switch to AsciiRenderer** — sets with `ascii.yaml` but no image frames automatically use the ASCII renderer regardless of terminal capabilities.

### Changed
- **tmux default changed to `"auto"`** — tmux + Ghostty now gets `kitty-unicode` images automatically without user configuration. Other outer terminals still fall back to ASCII.
- `emotes/ascii/fallback.yaml` renamed to `emotes/ascii/ascii.yaml`.
- Removed `setName === "ascii"` special case — ASCII sets are now resolved through the standard emote set lookup.

## v0.2.6

### Added
- **TmuxKittyUnicodeRenderer** — pane-safe image rendering through tmux using kitty Unicode placeholders (U+10EEEE). Images stay within their pane and clean up on session switch.
- **`"kitty-unicode"` render value** — new option for terminals config. Auto-selected for Ghostty/kitty through tmux.
- **`"placeholder"` frame kind** — new RenderedFrame variant for text-based image display.

### Changed
- **tmux auto-detection** — `"auto"` now resolves to `kitty-unicode` for Ghostty/kitty (pane-safe), ASCII for iTerm2/WezTerm (no pane-safe renderer available).
- **All tmux rendering is experimental and opt-in** — default remains ASCII. Users opt in via `{ "match": "tmux", "render": "auto" }` in their config.
- Classic `"kitty"` and `"iterm2"` DCS passthrough renderers remain available for single-pane setups.

### Fixed
- **Multiplexer routing bug** — concrete render values (e.g., `"ascii"`) from extension defaults were being ignored, falling through to auto-detection.

## v0.2.5

### Changed
- **Multiplexer defaults reverted to ASCII** — tmux/zellij/screen default to `"ascii"` pending renderer fix. Users can opt in to image rendering with `{ "match": "tmux", "render": "auto" }` in their config.

## v0.2.4

### Added
- **tmux passthrough rendering** — image avatars now work through tmux using DCS passthrough. Auto-detects outer terminal via `tmux show-environment TERM_PROGRAM`.
- **TmuxKittyRenderer** — Kitty protocol through tmux (Ghostty, kitty).
- **TmuxITermRenderer** — iTerm2 protocol through tmux (iTerm2, WezTerm).
- **`"auto"` render value** — new option for terminal config entries. Multiplexers use it by default to auto-detect passthrough support and outer terminal.
- **`src/tmux.ts`** — tmux-specific logic: passthrough check, outer terminal detection, DCS wrapping.
- **Multiplexers section** in README with tmux setup instructions.
- **tmux Requirements section** in AGENTS.md with full auto-detection flow.

### Changed
- `resolveRenderer()` returns a `ResolvedRenderer` object (protocol, multiplexer, warning) instead of a plain string.
- `loadLayeredConfig()` returns `{ config, userConfiguredTerminals }` to track explicit user overrides.
- Multiplexer warnings are suppressed when the user explicitly configures a concrete render value.
- Widget supports `padMode: "skip"` for tmux iTerm2 layout (cursor-right instead of spaces on image row).

## v0.2.3

### Added
- **Configurable terminal renderer whitelist** — override image protocol per terminal via `terminals` config array.
- **Community emote sets** — `aza_choi` and `aza_choi_nobg` by [@shennguyenrs](https://github.com/shennguyenrs) (#3).
- **Gallery section** in README showcasing available emote sets.

### Fixed
- **Config merge semantics** — emote entries now correctly append across config layers; terminal entries merge by `match` key.

## v0.2.2

### Fixed
- **Image row overflow** — row calculation now uses the same column count as the actual render, fixing avatar bleeding into content below.
- **Vertical centering** — Kitty renderer uses pixel-level `Y` offset to center the image within its allocated rows, independent of font/cell dimensions.
- **Consistent sizing** — image width, row calculation, and widget padding all use `config.size` consistently (removed off-by-one from `size + 1`).
- Custom Kitty escape sequence builder replaces pi-tui's `encodeKitty`, enabling protocol params (`Y` offset) not exposed by the library.

## v0.2.1

### Added
- **ASCII fallback renderer** — terminals without image support (tmux, Alacritty, VSCode, etc.) now show text-based emotes instead of nothing.
- ASCII emote frames defined in `emotes/ascii/fallback.yaml`.
- Config support for `"emote-set": "ascii"` to force ASCII mode on any terminal.
- Warning notification via `ctx.ui.notify` when falling back to ASCII.

### Changed
- **Renderer architecture split** — rendering logic separated by protocol:
  - `render_kitty.ts` — Kitty graphics protocol (Kitty, Ghostty, WezTerm).
  - `render_iterm.ts` — iTerm2 inline image protocol.
  - `render_ascii.ts` — plain text fallback.
  - `render_image.ts` — shared base class for image renderers.
  - `renderer.ts` — `Renderer` interface and `RenderedFrame` type.
- `animator.ts` is now a pure state machine, delegates all rendering to the `Renderer` interface.
- `widget.ts` handles image, text, and protocol-specific frame rendering.

### Fixed
- Package imports updated from `@mariozechner/*` to `@earendil-works/*`.
- **iTerm2 inline image rendering** — text-first/image-last strategy prevents ghost
  images and `\x1b[2K` erasure artifacts. Uses `preserveAspectRatio` with auto height
  for correct proportions.
- **Kitty image aspect ratio** — no longer forces row count, letting Kitty auto-size
  height to preserve correct proportions.
- Image width increased by 1 cell for better visual sizing in both protocols.
- I/O token stats (`↑input ↓output`) now shown even when zero.

## v0.2.0

Initial alpha release.

- Animated pixel-art emote widget displayed above the editor.
- State machine: hi, idle, think, talk, read, write, tool, success, failure, compact.
- Idle blinking and think swap animations.
- Talk mouth animation synced to token stream with reading-speed pacing.
- Cycling animations for read/write/tool states.
- Per-model emote set selection via glob patterns in config.
- Layered configuration (extension defaults → user global → project local).
- Emote set lookup across project, user, and extension directories.
- Optional `emotes.json` per set for frame configuration (idle/blink, think/hard, talk weights).
