# Changelog

All notable changes to gentle-emote will be documented in this file. Entries before v0.1.0 belong to [pi-emote](https://github.com/cgxeiji/pi-emote), the upstream project.

## Unreleased

### Added
- **Panel persistence and a session-local clock switch** — every configured destination now appears in the panel's CLOCK section with its real mode (`off` included) and can be switched `off` → `receiver` → `silence` for the current session only: the sender applies it live, writes nothing, and `/reload` returns to the configured mode. `size`, `placement`, `frame` and `accent` are now editable and global: the panel validates the value and writes it atomically to the user-global config of the agent directory the session runs on (temporary sibling plus rename, unrelated keys preserved, unreadable or non-object files refused untouched), then applies it live, so a failed write changes neither the file nor the running appearance. LED layout keys (`outline`, `background`, `backgroundCoverage`) and the D200 key stay out of the panel by decision.
- **Interactive control panel** — `/emote` with no argument (or `/emote panel`) opens a modal panel: one switch per output (terminal avatar, local simulators/desktop, D200 with its port, LED/ESP32 with its destination count), each destination's idle-clock mode and deadline, the live activity/phase/PNG truth and the effective appearance, plus avatar cycling, the demo and the status line. Arrows or `j`/`k` move, Enter or Space applies, Escape or `q` closes; every row is rebuilt from live state on each draw and once per second. Every switch runs the same command entry point as typing it, so persistence, LED ownership claims and failure paths are identical; no destination, route or credential is rendered, nothing is sent, and a panel failure never reaches the avatar, delivery or the prompt. It is plugin-owned (`ctx.ui.custom()`, public Pi API), so `gentle-shell` is untouched and upstream updates cannot conflict. Size, placement, frame, accent and the per-destination clock mode are displayed but not editable, and the panel never writes `config.json`.
- **`/emote displayOn <address>`** — names the LED/ESP32 board from the command instead of configuration: a host token only (IPv4, bracketed IPv6 or DNS name, optional `:port`) normalized to exactly `http://<address>/emote`. The address is written to the user-global config as the only non-loopback LED destination — replacing other non-loopback targets, preserving loopback targets and unrelated keys, migrating a legacy loopback `url` into `targets`, writing atomically and failing closed on an unreadable or non-object file — so it survives `/reload` and restarts. Scheme, path, credentials, query, fragment, whitespace and loopback addresses are refused (`invalid display address`, `loopback addresses belong to /emote localOn`) without writing or sending anything; a disabled LED group reports `no enabled LED/ESP32 display configured; address not applied`, because naming a board never enables an output. The named board also wins over a project layer that still points at the previous one, is claimed before its first image, and bare `/emote displayOn` keeps its previous behaviour byte for byte.
- **`/emote d200On <port>`** — points the D200 key mirror at another TCP port for the current session: a bare decimal port in `1`–`65535`, with `GENTLE_EMOTE_D200_PORT`/`8003` as the default and a second explicit port replacing the live sender instead of being ignored. The port is session-local and written nowhere, so `/reload` and restarts return to the default while the global On preference persists; `0`, `65536`, `-1`, `+8003`, `80.5`, `1e3`, `0x1f90`, `abc`, `127.0.0.1:9000`, `9100/emote` and URLs are refused with `invalid D200 port (1-65535); D200 mirror unchanged`, sending nothing and leaving both the live mirror and the saved preference untouched. `/emote d200Off` still stops every D200 port.
- **Project name reaches the LED panel** — `X-Emote-Project-Name` now rides every image request, LAN/ESP32 included, so the ESP32 receiver can bind the session title exactly as the desktop utility does. It stays absent from heartbeats and from the bodyless `claim`/`release` control routes, the captioned PNG layout is unchanged on every destination, and an absent or invalid name keeps the uncaptioned layout. No other delivery behaviour changes.
- **Project name metadata and captioned layout** — external-display image requests to loopback/local destinations (the desktop simulator and the D200 key) now carry an optional `X-Emote-Project-Name` header with the sending project's working-directory folder basename (for example `gentle-emotex`), so the desktop utility can label the avatar by project, and avatar PNGs on every image destination — simulator, LAN/ESP32 and the D200 key alike — switch to a compact captioned layout whenever a valid name was captured: the folder name rides as a green uppercase 3×5 caption at y=1–5 above the sprite (one blank pixel row above; centered, truncated at 16 characters, `_` and `.` drawn, accents folded — `ñ` → `N`), with a clear gap at y=6–8 and two separator rows at y=49–50, the same 48×40 sprite viewport at y=9–48 (any outline reserved inside that region), the status row at y=51–55, a two-pixel gap and the phase row at y=58–62, leaving a single bottom pixel. Phase-clock timing, colors and idle behavior are unchanged; only the rows move. The name is captured once per sender at session start (and by runtime `/emote d200On`), is never the full path, is percent-encoded UTF-8 in the header, and is omitted safely — never failing delivery and keeping the legacy uncaptioned layout — when the directory is a filesystem root, the name is empty/blank/oversized, path-like (path separators or `.`/`..` dot segments), carries control characters, is malformed Unicode (for example a lone surrogate, which would make percent-encoding throw), or the host gives no working directory. Heartbeats stay unchanged, the synthetic idle-clock face never shows the caption, and receivers without the header are unaffected.
- **Phase elapsed clock** — when a visible external-display phase stays on screen for more than five seconds, its phase row gains a ticking `MM:SS` clock (for example `IMPLEMENTI 00:06`), fed by the existing 1 Hz tick: the timer follows the resolved visible label (selected state, then detailed host phase, then coarse — `RUNNING` first), is preserved across new frames and activity updates of the same phase, resets on every visible phase change and on pause/resume, and is never attached to `IDLE`. Long phase names are truncated only while the clock is visible, minutes grow past 99 without capping the 16-character row, and dedup plus the bounded PNG cache key on the exact phase second so unchanged seconds never resend. Headers, protocol, IdleClock and terminal rendering are unchanged.
- **Experimental idle clock for external screens** — after more than five uninterrupted minutes of idle status and phase, enabled simulator, LED/ESP32 and D200 outputs show a native 64×64 DD/MM/YYYY / 24-hour clock with larger seconds and original bottom-edge pixel walkers. The 1 Hz target is rate-limited independently of avatar animation; active subagents, detailed work, busy/error activity and explicit non-idle previews reset the deadline. Pause/off and bounded latest-frame delivery remain intact, activity restores the remembered avatar, disposal clears the unrefed timer, and the terminal avatar and saved preferences are untouched. Receiver metadata truthfully identifies `clock` / `clock.png` / `idle-clock`; `/emote status` continues to describe the source avatar PNG.
- **`/emote status`** — a read-only diagnostic that reports the truth instead of guessing: the last PNG the renderer actually selected (`state`, `frame` and `set` filename, captured through the existing frame-selection path even with every output off and no destination enabled; ASCII-only rendering without external destinations retains the last captured PNG or reports none rather than forcing PNG selection), the effective ODD work phase and where it came from (`native` bus, `direct` `gentle_odd_phase` fallback, or `none`), and the coarse activity snapshot (`status`, `phase`, `activeSubagents`). The PNG and the phase are reported side by side, never equated — a phase visual does not claim the host phase when none was published. It changes no animator state, output switch or preference, writes nothing (no `config.json`, no output-state store), performs no network calls and exposes only safe public fields — no base64, destinations, paths or credentials. Before any frame is selected it honestly reports `PNG none selected yet`; tab-completes as `status`.
- **Native subagent task count** — the external display now reports real subagent tasks, not just open tool calls. Gentle Shell publishes every subagent task transition on its native notification bus (`gentle-pi:notification:source`); the PNG label and the `X-Emote-Active-Subagents` header track that lifecycle: queued/running/waiting count once, completed/failed/cancelled/timed_out clear it, two concurrent tasks count 2, and the count survives `agent_start`/`agent_end` and compaction (only an actual session change or shutdown clears it). On hosts without the bus — or before the first observed transition — the historical call-based counter stays byte-for-byte, and once the native lifecycle is observed the two are never summed. Strictly validated content-free events only: wrong source/session, malformed payloads, duplicates, out-of-order updates and unknown terminals are no-ops that never inflate, never go negative and never resurrect a finished task (host continuations get a new task id). Restore is silent, so tasks queued before subscription (reload, late start) appear at their next emitted transition.
- **Work-phase visuals** — the eight detailed ODD work phases shipped by Gentle Shell (`authorizing`, `exploring`, `researching`, `deciding`, `planning`, `implementing`, `checking`, `closing`) now have native 48×40 transparent frames in both built-in sets (two animation frames each, drawn on the same Gentleman bust: approval card, magnifier, reference book, choice cards, blueprint, keyboard, checklist, completed-work folder). While a phase is published, it re-skins only the generic `think`/`read`/`write`/`tool` scenes; prompts, failures, compaction, talk, idle and delegation keep their own visuals, a phase clear restores the coarse scene, and sets without phase frames fall back truthfully. A phase preview is also available via `/emote <phase>`.
- **Detailed ODD work phase** — when Gentle Shell publishes its session work phase on the shared event bus (`gentle-pi:odd-phase/v1` plus a synchronous current-phase handshake), the external display shows it: the PNG phase row and an optional `X-Emote-Work-Phase` header carry the detailed phase (`planning`, `implementing`, `checking`, …) in place of the coarse `thinking`/`executing` label. Truthful emote states keep their own labels, malformed or foreign-session payloads are ignored, the detail clears at agent boundaries and everything falls back to the coarse activity without Gentle Shell.
- **Explicit phase-tool fallback** — without the Gentle Shell bus, a successful `gentle_odd_phase` tool call adopts its `phase` argument (`authorizing` … `closing`; `clear` drops it) as a direct fallback: the PNG frames, the external frame sink and the `X-Emote-Work-Phase` header all use the named phase. The native bus phase keeps priority (a direct adoption never overrides it, a direct `clear` never erases it, a host clear reveals only the current turn's direct fallback), the fallback clears at turn and session boundaries, start events and failed or malformed calls are no-ops, and nothing is inferred automatically.
- **`/emote displayOn` / `displayOff`** — pause or resume delivery to configured non-loopback LED/ESP32 destinations without touching the terminal avatar, localhost simulators or the D200 key.
- **Persistent output preferences** — every On/Off command (`internal`, `debug`, `d200`, `display`) saves its own global boolean under `<agent dir>/extensions/gentle-emote/output-states/<output>.json`; choices survive restarts, `/reload` and project changes, and running sessions restore them at their next start/reload.

### Changed
- **Idle error display label** — when status is `error` and phase is `idle`, external displays show `IDLE` in the same red instead of `ERROR` when no subagent is active; active subagents show red `SUBAGENTS (n)` / `RUNNING`. Non-idle errors retain red `ERROR`; internal activity, protocol headers and terminal rendering are unchanged.
- **Complete demo sequence** — `/emote demo` keeps the original scenes and now includes all eight ODD work phases. These visual previews do not publish a work phase or change agent activity.
- **Selected-state phase label** — the external display PNG's phase row now describes every registered selected image state from `/emote demo`, under any coarse activity or published work phase. Action labels use uppercase -ing forms: `THINKING`, `TALKING`, `READING`, `WRITING`, `COMPACTING`, `ASKING`, `DELEGATING`, `REMEMBERING`, `EXPLORING`, `BUILDING`, `VERIFYING`, `JUDGING` and `REVIEWING`. The eight ODD phase labels (for example `PLANNING`) and nonverbs (including `SUPER-YOLO` with its hyphen) stay unchanged. This is display-only: commands such as `/emote write`, internal state names, `/emote demo` names and protocol headers such as `X-Emote-State: write` are not renamed. Without a registered selection, the existing coarse/work-phase fallback remains. The `SUBAGENTS (n)` / `RUNNING` exception with an idle phase, idle or error status and active subagents still wins; artwork, status/count styling and the idle clock are unchanged.
- **Idle parent with active subagents** — when activity phase is `idle`, status is `idle` or `error`, and at least one subagent is active, display labels read exactly `SUBAGENTS (n)` and `RUNNING`. The yellow count and `999+` cap are preserved; internal state, headers and sprite selection do not change.
- **All outputs default off** — after install or reload, run the matching On command (`/emote internalOn`, `debugOn`, `d200On`, `displayOn`) to see or send anything; previously the avatar was visible by default.
- **README troubleshooting** — what to do when `/emote` does not list a new command: `/reload` restarts the installed version but does not update it.

### Added
- **Idle-clock state in `/emote status`** — when a destination's `idleClock` mode is not `off`, the read-only diagnostic now also reports that destination's clock state anonymously: `; idleClock #1 mode=receiver session=yes remaining=142s carrier=no`. `session` states whether the sender carries session identity, the deadline reads `remaining=<n>s`, `active` once five minutes elapsed, or `not-settled` when the current activity or selected state is not eligible, and `carrier` reports whether an ambient carrier was queued. Positions are anonymous and destinations, routes and credentials stay hidden, so a session that keeps showing avatars past the deadline names its own blocking input instead of needing a guess. The segment is always present, so `; idleClock off` (every destination keeps avatars) and `; idleClock no destination` (this session has no enabled external destination) are stated instead of omitted: an absent segment can only mean an extension older than this change. Nothing is sent and no state changes.

### Fixed
- **Idle clock blocked by a settled error** — a turn whose last tool failed leaves the host reporting status `error` with phase `idle`, and the idle clock required status `idle`, so that combination blocked the clock for the rest of the session while every destination went on labelling it `IDLE` (red) with `GRANDMA` beneath. A settled error now starts the clock exactly like idle: same strict five-minute boundary, same shared `idle`/`grandma` budget, `X-Emote-Status: error` still reported truthfully, and running work still cancels the deadline — busy activity, a non-idle phase, a published work phase, active subagents or an explicit non-idle preview. Red `IDLE` ink in avatar mode and every other label are unchanged.
- **Startup greeting ownership** — previews (including explicit idle), agent activity, compaction, blocking prompts, farewells and tool errors cancel the pending 500 ms greeting. Returning to idle before the deadline no longer lets a stale greeting take over; untouched idle startup still greets.
- **Subagent display spelling** — corrected `SUBAGETNS` to `SUBAGENTS` in the external display status label; `RUNNING`, count colors, the `999+` cap and protocol headers are unchanged.

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
