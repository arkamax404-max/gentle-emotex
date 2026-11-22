<div align="center">
  <img src="assets/gentle-logo-only.png" alt="Gentle Emote" width="132" />

# Gentle Emote

**A Gentleman beside the prompt. He acts out the agent. He uses no tokens.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

> **This is a fork.** [`arkamax404-max/gentle-emotex`](https://github.com/arkamax404-max/gentle-emotex) is a personal fork of [`efolchmontiel/gentle-emote`](https://github.com/efolchmontiel/gentle-emote), which in turn forked [`cgxeiji/pi-emote`](https://github.com/cgxeiji/pi-emote). Upstream authorship stays with its authors: see [Credits and acknowledgements](#credits-and-acknowledgements). Issues and pull requests for this fork follow [CONTRIBUTING.md](CONTRIBUTING.md).

A pixel-art **Gentleman** that sits in a frame to the left of your prompt and acts out what the agent is doing. Works in [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell) and [Pi](https://pi.dev).

> **Cross-platform:** compatible with **Windows, macOS and Linux**. **Recommended for use with Herdr**, but Herdr is not required for the avatar or display outputs; panel-focus integration does require it. The companion desktop receiver is a separate, Windows-only utility (see [Related projects](#related-projects)).

He listens to local session events: no model calls or context. Desktop mirroring to `127.0.0.1:8001` is on by default; only avatar images and visual metadata are sent. LAN, USB and D200 stay off until enabled. On top of upstream, this fork adds independent simulator/ESP32 delivery, activity labels, silhouette outlines, ASCII-terminal mirroring, the editable `gentleled` image set, per-destination transparent output and the related projects below.

## Related projects

Gentle Emote ships as separate repositories. Each one works on its own, and each consumes the same PNG frames and protocol described here.

| Project | What it does |
| --- | --- |
| [gentle-emote-desktop](https://github.com/arkamax404-max/gentle-emote-desktop) | Native Windows desktop utility: shows the avatar in its own frameless window, opaque or fully transparent, so it can sit anywhere on the desktop instead of the terminal. |
| [emote-display-firmware](https://github.com/arkamax404-max/emote-display-firmware) | ESP32 LED-matrix receiver that drives a physical display from the frames this extension delivers. |
| [emote-display-simulator](https://github.com/arkamax404-max/emote-display-simulator) | Browser receiver on `127.0.0.1:8000`, the quickest way to see deliveries while configuring a destination. |
| [gentle-emote-d200](https://github.com/arkamax404-max/gentle-emote-d200) | Ulanzi D200 key plugin on `127.0.0.1:8003`: the destination added by `/emote d200On`, which mirrors the avatar frames to the key. |

He listens to local session events: no model calls or context. Desktop mirroring to `127.0.0.1:8001` is on by default; only avatar images and visual metadata are sent. LAN, USB and D200 stay off until enabled.

## Scenes

One frame per state, shown with the pink accent (yours follows `/gentle:customize`). Every frame of every animation is in the [gallery](docs/gallery.md), and `/emote demo` plays them live.

<table width="100%">
  <tr>
    <td align="center"><img src="docs/scenes/hi.png" alt="hi" width="96"><br><code>hi</code></td>
    <td align="center"><img src="docs/scenes/idle.png" alt="idle" width="96"><br><code>idle</code></td>
    <td align="center"><img src="docs/scenes/think.png" alt="think" width="96"><br><code>think</code></td>
    <td align="center"><img src="docs/scenes/talk.png" alt="talk" width="96"><br><code>talk</code></td>
    <td align="center"><img src="docs/scenes/read.png" alt="read" width="96"><br><code>read</code></td>
    <td align="center"><img src="docs/scenes/write.png" alt="write" width="96"><br><code>write</code></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/scenes/tool.png" alt="tool" width="96"><br><code>tool</code></td>
    <td align="center"><img src="docs/scenes/ask.png" alt="ask" width="96"><br><code>ask</code></td>
    <td align="center"><img src="docs/scenes/success.png" alt="success" width="96"><br><code>success</code></td>
    <td align="center"><img src="docs/scenes/failure.png" alt="failure" width="96"><br><code>failure</code></td>
    <td align="center"><img src="docs/scenes/compact.png" alt="compact" width="96"><br><code>compact</code></td>
    <td align="center"><img src="docs/scenes/delegate.png" alt="delegate" width="96"><br><code>delegate</code></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/scenes/explore.png" alt="explore" width="96"><br><code>explore</code></td>
    <td align="center"><img src="docs/scenes/build.png" alt="build" width="96"><br><code>build</code></td>
    <td align="center"><img src="docs/scenes/verify.png" alt="verify" width="96"><br><code>verify</code></td>
    <td align="center"><img src="docs/scenes/judge.png" alt="judge" width="96"><br><code>judge</code></td>
    <td align="center"><img src="docs/scenes/review.png" alt="review" width="96"><br><code>review</code></td>
    <td align="center"><img src="docs/scenes/jira.png" alt="jira" width="96"><br><code>jira</code></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/scenes/jobs.png" alt="jobs" width="96"><br><code>jobs</code></td>
    <td align="center"><img src="docs/scenes/yolo.png" alt="yolo" width="96"><br><code>yolo</code></td>
    <td align="center"><img src="docs/scenes/super-yolo.png" alt="super-yolo" width="96"><br><code>super-yolo</code></td>
    <td align="center"><img src="docs/scenes/remember.png" alt="remember" width="96"><br><code>remember</code></td>
    <td align="center"><img src="docs/scenes/grandma.png" alt="grandma" width="96"><br><code>grandma</code></td>
    <td align="center"><img src="docs/scenes/bye.png" alt="bye" width="96"><br><code>bye</code></td>
  </tr>
</table>

The subagent scene comes from the `agent` argument of the tool call, so a new agent that follows the same naming gets the right scene for free; a call without one (for example, continuing a task by id) shows `delegate`.

The subagent scenes, `jobs`, `yolo`, `super-yolo` and `remember` need the matching Gentle Shell tools or the Engram extension. Without them those states simply never trigger; the rest works the same in plain Pi.

### Work-phase visuals

When Gentle Shell publishes its detailed ODD work phase on the shared event bus, the eight host phases re-skin the generic `think`/`read`/`write`/`tool` scenes with dedicated frames, without changing the logical activity:

| Phase | Visual |
|-------|--------|
| `authorizing` | reviewing an approval card, then stamping it |
| `exploring` | sweeping a magnifying glass over footprints |
| `researching` | an open reference book, pages turning |
| `deciding` | two choice cards, weighed one at a time |
| `planning` | drawing the approach on a blueprint |
| `implementing` | both hands on the keyboard, code flying |
| `checking` | a clipboard checklist filling with green checks |
| `closing` | presenting the completed-work folder |

The override applies only to those four generic scenes: blocking prompts (`ask`), failures, compaction, talking, idle and delegation keep their own truthful visuals, clearing both native and direct phases returns the coarse scene, and a set without frames for a phase falls back to the generic scene. The external display mirrors the phase frames and keeps the `X-Emote-Work-Phase` header (see [Receiver protocol](#receiver-protocol-v1)).

Outside Gentle Shell (plain Pi, other hosts), the same visuals can be driven explicitly: when a successful `gentle_odd_phase` tool call ends, its `phase` argument (`authorizing` … `closing`, or `clear`) is adopted as a direct fallback (its arguments are captured at `tool_execution_start` and applied only after the successful end) — the PNG folder, the frame sink and the `X-Emote-Work-Phase` header all use that phase. The native bus phase always wins: a direct adoption never overrides it, a direct `clear` never erases it, and a host clear only reveals the direct fallback named during the current turn. The direct phase is dropped at turn and session boundaries, so a stale phase never leaks into the next turn. `/emote <phase>` manual previews are unchanged, and nothing is inferred automatically — only an explicit successful call names a phase.

Want a different character? [Create your own avatar](#create-your-own-avatar).

### Dedicated subagent avatar

While the parent rests (idle) and exactly one known subagent task is running, the avatar already told you the count — but not who is doing the work. For that resting window the avatar can switch to a dedicated child character: a bounded, configurable avatar shown with the external labels `SUBAGENT` / `RUNNING`. It is display-only: the parent's logical activity, its ODD phase and the protocol headers never claim a child phase, and there is none to claim — the native bus exposes task lifecycle counts, not child detail.

```json
{
  "subagentAvatar": "gentleled"
}
```

- The value is a direct avatar folder name (same roots as `/emote avatar`), validated through the existing selection guards; it never becomes the saved manual selection and no preference is rewritten to show the child.
- Default: the shipped `gentleled` set; when the parent's own selection already is `gentleled`, the shipped `gentleman` set is used instead, so the child looks different from the parent whenever possible.
- A missing, unsecure or unusable configured name warns once and falls back to that same default without touching any file.
- The scene exists only while the parent's own visual is the resting idle: any work, prompt, failure, compaction or talk keeps the primary avatar, and two or more running children keep the generic `SUBAGENTS (n)` treatment. The count reaching zero (or a session reset) restores the parent selection and its rest timing.
- While a child is known to run, the grandma is suppressed and the idle clock never starts, so the resting parent cannot age into a nap while workers are busy. After `/reload` the tracker starts unobserved (there is no lifecycle snapshot), so the scene appears only at the next emitted transition.

## Install

```bash
# Gentle Shell
gentle-shell install npm:gentle-emote

# Pi
pi install npm:gentle-emote
```

Restart the session (or `/reload`), then run `/emote internalOn` to show the Gentleman. All four outputs start off until explicitly enabled; their last On/Off choices are saved globally.

### Missing commands?

`/reload` restarts the already-installed version; it does not fetch new code. If `/emote` does not list a command such as `displayOn`, the session is still running an older copy. Install from an updated source and reload, for example:

```bash
pi install npm:gentle-emote        # published package
pi install ./gentle-emote          # local checkout with the changes (loaded from that path)
```

A source that is already configured keeps loading until it is updated or removed (`pi remove <source>`); installing an additional source does not replace it automatically.

## Commands

| Command | What it does |
|---------|--------------|
| `/emote` | Lists every state |
| `/emote` (no argument) or `/emote panel` | Opens the interactive control panel; every switch runs the same command path as typing it. Arrows or `j`/`k` move, Enter or Space applies, Escape or `q` closes |
| `/emote <state>` | Previews one state for a few seconds (tab-completes), e.g. `/emote delegate` |
| `/emote demo` | Plays the original scenes and all eight ODD work phases in sequence; previews do not publish a work phase or change agent activity |
| `/emote status` | Read-only diagnostic: the last renderer-selected source PNG before any external idle-clock overlay (state, frame and set basename), the effective work phase and its source (native bus / direct tool / none), and the coarse activity snapshot (status, phase, active subagents). Works with every output off, changes nothing and never sends anything. ASCII-only rendering with no external destination does not select new PNGs; the reported PNG is the last captured selection, or none. It always ends with the idle-clock state, so an older extension can never be mistaken for an inactive clock: `; idleClock off` when every destination keeps avatars, `; idleClock no destination` when this session has no enabled external destination, or one anonymous entry per non-off destination (`; idleClock #1 mode=receiver session=yes remaining=142s carrier=no`): `session` says whether the sender has session identity, the deadline reads `remaining=<n>s`, `active` once the five minutes elapsed, or `not-settled` when the current activity/state is not eligible, and `carrier` says whether an ambient carrier was queued. Destinations, routes and credentials are never exposed |
| `/emote avatar <folder>` | Switches avatar immediately and saves the choice globally; tab completes available folders |
| `/emote avatar auto` | Clears the manual choice and resumes current model/thinking-level mappings |
| `/emote avatar` | Shows the current choice and usage without changing it |
| `/emote idle` | Stops a preview and goes back to rest |
| `/emote internalOff` | Hides the terminal avatar and frees its prompt space; external PNG delivery continues |
| `/emote usbOn [port]` / `usbOff` | Sends to the LED panel over USB CDC: bare `usbOn` auto-detects the single serial display, offers a picker when several are visible (in the interactive TUI), and `usbOn COM5` names it for this session; `usbOff` leaves the binary session and closes the port. Persists only a successful On |
| `/emote internalOn` | Shows the terminal avatar again without disabling external delivery |
| `/emote localOff` | Pauses POSTs to configured localhost simulators; ESP32 delivery continues |
| `/emote localOn` | Resumes localhost delivery immediately with the latest PNG and activity |
| `/emote debugOn` / `debugOff` | Diagnostic-only: shows, or hides again, the routine `externalDisplay: unsupported frame identifier; skipped` reports on every display destination. **Session-local and off by default**: nothing is saved, a new session or `/reload` starts off, delivery and other warnings are unchanged, and this is a different switch from the local output (`localOn`) saved as `debug` |
| `/emote d200On` | Mirrors frames to a Ulanzi D200 key on `127.0.0.1:8003`, independently of `config.json`; **session-local**: both the enabled state and the port live only in the current session and nothing is saved. `/emote d200On <port>` uses that port for this session |
| `/emote d200Off` | Stops the D200 mirror without touching configured destinations or any preference file |
| `/emote displayOn` | Resumes delivery to configured non-loopback LED/ESP32 destinations and claims the display for this session; firmware without session ownership keeps ordinary delivery with a one-time warning. `/emote displayOn <address>` points the group at that board and saves it in the user-global config |
| `/emote displayOff` | Pauses LED/ESP32 delivery and releases this session's reservation, without affecting the terminal, simulators or D200 |
| `/emote title <text>` | Sets the caption above the avatar on every external display for this project, saved in `.pi/extensions/gentle-emote/title.json`; bare `/emote title` restores the project folder basename |

Any new prompt cancels a preview, so the avatar always follows the real agent.

### Avatar selection

Run `/emote avatar minecraft` (or another available folder) to switch without `/reload`.
Sets shipped with the extension are selectable the same way: `/emote avatar gentleemotex`
switches to the included `gentleemotex` character. Tab completion lists every usable folder.
The choice is saved as a folder-name string in `<agent dir>/extensions/gentle-emote/avatar.json`,
independently of `config.json` and output preferences. It survives restarts and project changes;
already-running sessions restore it on their next start/reload. Manual selection wins over model
and thinking-level changes until `/emote avatar auto` saves `null` and restores automatic mappings
using the latest model/thinking-level events. Visibility, activity and output enablement are unchanged.

Folders are resolved project → user → extension, deduplicated in completion. Put state folders
such as `idle/idle.png` directly inside the named folder; nested wrappers are not searched.
`auto` is reserved. Names must be a single basename: no separators, colon, exact `..` or `.`, or
control characters; embedded dots (including `foo..bar`) are allowed. Manual selections and their YOLO
twins require usable idle PNGs (or an ASCII idle scene). Automatic mappings may use partial YOLO twins
with usable PNGs in other states, such as a read-only twin; the same path guards still apply.
Unsafe, missing or unusable manual sets are rejected without changing the live avatar
or preference; failed saves also retain the live choice. A malformed preference warns and uses
automatic selection; a saved folder missing in another project warns and falls back automatically
without overwriting the saved name.

Selection, restoration, completion and YOLO twins validate real paths of the emotes root, set,
configuration, state directories and PNGs before loading. Links escaping the allowed emotes tree
are rejected; an unsafe higher-priority folder is not silently replaced by a lower layer.
These synchronous checks do not lock files against concurrent filesystem replacement: use trusted,
locally managed avatar directories. A PNG selection remains the external avatar even with the
terminal hidden or using ASCII; a genuinely text-only set retains the existing graphical fallback.

### Project title

By default, external deliveries caption the PNG with the project folder's basename. `/emote title <text>` overrides that caption with any trimmed text, applies it live to every enabled destination (localhost, LED/ESP32 and the D200 mirror) without touching outputs, timers or streams, and saves the choice **per project** in `.pi/extensions/gentle-emote/title.json` — separate from `config.json`, never rewritten by other commands. The saved title survives restarts and `/reload`; bare `/emote title` resets to the folder basename. Titles use the same validation as project-name metadata: no path separators, control characters or oversized text. An invalid title reports a warning and changes nothing; a failed save leaves the current caption and file untouched; a malformed stored file warns and falls back to the folder name, preserving the file.

The title ink follows the destination: muted green `#80e0a0` (the idle status palette) on loopback destinations (localhost simulator and the D200 mirror at `127.0.0.1:8003`), pure green `#00ff00` on non-loopback LED/ESP32 destinations, for better contrast on the physical matrix. Status and phase rows keep their own colors everywhere.

The startup greeting runs after 500 ms only if the avatar is still idle and no other event has claimed it. Manual previews (including `/emote idle`), agent activity, compaction, blocking prompts, farewells and tool errors cancel the pending greeting—even if the avatar returns to idle before the deadline.

## Config

Drop a `config.json` with only the keys you want to change in either place (the later one wins):

- `<agent dir>/extensions/gentle-emote/config.json`: global. The agent dir is `PI_CODING_AGENT_DIR`, or `~/.pi/agent` by default.
- `.pi/extensions/gentle-emote/config.json`: per project.

```json
{
  "frameRows": 5,
  "grandmaAfterMs": 120000
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Loads the extension and its commands; `false` disables the extension entirely |
| `placement` | `"beside-editor"` | Where the avatar sits: `"beside-editor"` or `"above-editor"` |
| `frame` | `true` | Draws a rounded frame around the avatar |
| `frameRows` | `4` | Avatar height in terminal rows. The prompt grows to match it |
| `minEditorWidth` | `40` | Below this prompt width the avatar hides to leave room for typing |
| `grandmaAfterMs` | `30000` | Idle time before the grandma appears (any key resets it). Use `0` to disable it |
| `subagentAvatar` | `gentleled` (see below) | Dedicated avatar for the resting parent while exactly one known subagent runs |
| `farewellPattern` | Spanish and English goodbyes | Regex (case-insensitive) that triggers `bye` |
| `accent` | `"auto"` | Rose and headband color: `"auto"` follows `/gentle:customize`; or `"pink"`, `"cyan"`, `"yellow"`, `"green"`, or a hex like `"#ff6ec7"` |
| `readingSpeed` | `4` | Words per second used to pace the `/emote talk` preview |
| `holdDuration` | see `config.json` | How long `hi`, `success`, `failure` and `bye` stay on screen (ms) |
| `emotes` | `gentleman` | Emote set per model or thinking level (see below) |
| `terminals` | see `config.json` | Renderer per terminal (see below) |

`config.json` in the package root has every default.

### Global output preferences

The local output (`localOn`, saved as `debug`) is **on by default** when no preference exists. The `internal`, `display` and `usb` outputs are **off by default** and each On/Off command saves its own global boolean under `<agent dir>/extensions/gentle-emote/output-states/<output>.json`; choices survive `/reload`, restarts and project changes until another command changes them, and already-running sessions restore them on their next session start/reload. A saved `localOff` remains off after an update; missing preferences are not written automatically. The agent dir is `PI_CODING_AGENT_DIR`, or `~/.pi/agent`. Project configuration cannot override these preferences; commands change the current session immediately.

The **D200 output is the exception: it is fully session-local** — both the enabled state and the port (`/emote d200On <port>`) belong to the current session, are written nowhere, and every new session or `/reload` starts it **off**. `d200Off` followed by bare `d200On` inside the same session reuses that session's port choice, which a session start resets to `GENTLE_EMOTE_D200_PORT`/`8003`. A legacy `output-states/d200.json` left by an older version is ignored: never read, never warned about and never rewritten, whatever it contains (true, false or corrupt bytes).

`internalOn` / `internalOff` affect only the terminal avatar (graphics or ASCII), not the animation engine, activity tracking or other outputs. While hidden, no terminal image uploads occur. Keep the extension's `enabled: true` so the commands remain available.

`localOn` / `localOff` control configured loopback destinations (`localhost`, `.localhost`, IPv4 127/8 and IPv6 `::1`). They keep the saved `debug` preference key in `output-states/debug.json`, with no migration or preference reset, and they are not the same switch as the diagnostic `/emote debugOn` / `/emote debugOff` commands below. `displayOn` / `displayOff` control configured non-loopback LED/ESP32 destinations. Each Off aborts that group's active requests, drops pending frames and sends a bodyless `release` control request; On resumes with the latest selection and activity and sends a bodyless `claim` request that reserves the display for this session, ordered before any later image (a repeated `displayOn` re-claims even while already enabled). Destinations qualify for the reservation only with session identity and the exact `/emote` URL without a query; an explicit `displayOn` on a destination that cannot qualify warns once and keeps ordinary delivery without claiming exclusivity, while restoring the saved preference at startup resumes delivery as before and never claims. Heartbeats renew the reservation every 5 s while the destination stays enabled, even before the first frame is sent and while the receiver runs its own clock in `idleClock: "receiver"`; entering `idleClock: "silence"` deliberately stops them, so the reservation lapses 30 s after traffic stops and a later explicit `displayOn` reclaims it. Firmware without session ownership answers `404`/`405` or a `200` without the `X-Emote-Ownership` marker: delivery continues as before with a one-time warning and no exclusivity is reported; a `409` conflict is likewise a warned non-success without an automatic re-claim. Neither group affects the dedicated D200 mirror or diagnostic logging (`config.debug`).

Output commands do not write `config.json`, invent destinations or enable entries explicitly disabled in configuration, with one documented exception: `/emote displayOn <address>` rewrites the LED destination in the **user-global** config, because a named board has to survive `/reload`. An On preference can be saved before configuring its destination, but delivery still requires valid, enabled external-display configuration. Unreadable or malformed saved preferences leave that output off with a warning; a failed save reports an error and leaves the current output unchanged.

### Naming a board from the command

`/emote displayOn <address>` points the LED/ESP32 group at the board you name instead of the one in configuration. `<address>` is a host token only — IPv4, a bracketed IPv6 address or a DNS name, optionally with `:port` — normalized to exactly `http://<address>/emote`. A scheme, path, credentials, query, fragment or other punctuation is refused with `invalid display address`; loopback addresses are refused with `loopback addresses belong to /emote localOn`, because they belong to the local group.

The accepted address is written to the user-global `<agent dir>/extensions/gentle-emote/config.json` as the only non-loopback LED destination: every other non-loopback target is replaced rather than accumulated, while loopback targets (the desktop simulator) and unrelated keys survive — the local group and the D200 key are separate outputs. A legacy single `url` that is loopback migrates into `targets`. The write is atomic, so an interrupted save cannot truncate your config, and it fails closed with `cannot read the global config` or `cannot write the global config` instead of replacing a file it cannot parse; the LED destinations then stay unchanged. The named board also wins over a project layer that still points at the previous one, because configuration layers are not rewritten by a command.

The command requires the LED group to be enabled already: with no enabled external display it warns `no enabled LED/ESP32 display configured; address not applied` and writes nothing, because an output is never switched on by naming a board. On success it saves the `display` preference On, rebuilds this session's sender, claims the display before the first image, and reports `LED/ESP32 display: http://<address>/emote`, followed by `; 1 loopback target preserved` when a loopback destination survived.

## Mirror to an external 64×64 display

Only the main session sends images to external displays. Gentle Shell subagent sessions (`GENTLE_PI_AGENTS_CHILD=1`) do not register the extension's commands, local avatar or external senders, even when saved preferences or global/project configuration enable delivery. The main session can still show delegation scenes and its active-subagent count, but child sessions do not compete for the same display.

### Desktop: ready on first install

The shipped configuration enables one destination: `http://127.0.0.1:8001/emote`, with `transparentBackground: true` and `idleClock: "receiver"` **on that target only**. After more than five uninterrupted settled idle minutes, the desktop draws its own clock; real activity restores the avatar. Start [gentle-emote-desktop](https://github.com/arkamax404-max/gentle-emote-desktop) to receive the avatar without editing JSON. Canvas gaps are transparent; opaque black artwork is preserved (no chromakey). `/emote localOff` pauses local delivery and persists that choice; `/emote localOn` restores it. No receiver is installed or started automatically.

Your own `externalDisplay.targets` replaces this preset. A user/project legacy `externalDisplay.url` also replaces the shipped targets, so existing receivers are not redirected to the desktop. Explicit `externalDisplay.enabled: false` still disables delivery. The preset does not enable LAN, USB or D200, nor change their clock modes or default image opacity.

To keep the desktop avatar instead of handing off to its clock, replace the target in your global or project config (arrays replace the preset as a whole):

```json
{
  "externalDisplay": {
    "targets": [
      { "enabled": true, "url": "http://127.0.0.1:8001/emote", "transparentBackground": true, "idleClock": "off" }
    ]
  }
}
```

An explicit target mode of `"silence"` is also preserved. A parent `idleClock` alone does not override a target's explicit mode.

### Other receivers

With the sibling `emote-display-simulator` receiver running locally, add this to `.pi/extensions/gentle-emote/config.json` (or your global config):

```json
{
  "externalDisplay": {
    "enabled": true,
    "url": "http://127.0.0.1:8000/emote",
    "timeoutMs": 1000
  }
}
```

To send to both the local simulator and a MatrixPortal receiver, replace the single `url` with `targets`:

```json
{
  "externalDisplay": {
    "enabled": true,
    "timeoutMs": 1000,
    "targets": [
      { "enabled": true, "url": "http://127.0.0.1:8000/emote" },
      { "enabled": true, "url": "http://gentle-matrix.local/emote" }
    ]
  }
}
```

`targets`, when present, replaces the legacy `url` and is replaced as a whole by higher-priority config layers. Up to 8 destinations are allowed, each with its own queue, cache, timeout, stream ID and sequence. Target `timeoutMs` overrides the parent timeout. Turn off the simulator target with `enabled: false` when it is only needed for debugging. Use the board's LAN IP if mDNS does not resolve. The parent `enabled` switches all delivery off.

### Global PNG appearance

Configure `transparentBackground`, `background` and `backgroundCoverage` in the **user-global** `config.json` (`<agent dir>/extensions/gentle-emote/config.json`). Shipped defaults apply when unset. Project values for these three keys are ignored, including values inside `targets`. Global per-target preferences follow the destination's URL even when a project replaces the routing array; unmatched URLs inherit the global parent appearance. Destination URLs, enabled states, timeouts, clock modes and outlines retain normal configuration layering. PNG composition is separate from native desktop window opacity.

Set `transparentBackground: true` for a loopback desktop/simulator receiver that supports alpha. Non-loopback HTTP LED targets and USB serial displays always receive opaque PNGs, even when this setting is `true`. This preserves the source sprite's RGBA (including partial alpha and opaque black) and makes the **entire canvas** transparent outside the artwork, text and outline ink. Padding and gaps between labels are transparent; text and outline ink remain opaque. No color is removed by chromakey.

```json
{
  "externalDisplay": {
    "enabled": true,
    "transparentBackground": true,
    "targets": [
      { "enabled": true, "url": "http://127.0.0.1:8000/emote" },
      { "enabled": true, "url": "http://gentle-matrix.local/emote", "transparentBackground": false }
    ]
  }
}
```

The boolean defaults to `false`. The shipped desktop target explicitly sets it to `true` without changing the parent default. Loopback targets inherit the parent value; an explicit `false` keeps a loopback target opaque. Physical HTTP LED/ESP32 and USB outputs ignore a valid transparency opt-in and composite all pixels onto an opaque canvas. Invalid global appearance values still disable affected destinations; a project cannot repair or override them. Other values (including `null` and strings) disable the affected destination. In transparent mode, `background` and `backgroundCoverage` have **no rendering effect**, but supplied values must still be valid. The PNG remains 64×64 and protocol v1 is unchanged; how alpha is displayed depends on the receiver. The dedicated `/emote d200On` mirror remains opaque and does not inherit this setting.

### Opaque background and delivery

Optional `background` accepts an RGB hex color (`"#000000"` by default). It composites genuinely transparent pixels only within the drawn sprite PNG bounds; outer canvas padding and the text area stay black. **opaque black pixels in sprites remain black**. Set `"background": "#404040"` on the parent in user-global config to try a dim gray on both destinations, or on one global target to override it independently. Invalid color values disable that destination. Very dark grays may quantize to black on low-bit-depth panels. Optional `backgroundCoverage` (0–1, default 1) applies a fixed 4×4 ordered dither to the transparency background only; `0.75` retains 75% gray pixels and uses black for the rest. Coverage has 1/16 increments and is inherited/overridden per target. This reduces apparent background brightness without temporal flicker or changing opaque artwork.

Run `/reload`, open the simulator in your browser, then `/emote localOn` and `/emote demo`. For the LED/ESP32, use `/emote displayOn`, or `/emote displayOn 192.168.1.129` to point the group at that board and save it. Stop each group with its corresponding Off command; the choice persists. Shutdown/reload aborts pending delivery, then the next session restores saved preferences.

- **Trust:** project config can override destinations through the normal layered merge, but not global PNG background/transparency preferences; saved `localOn` or `displayOn` preferences allow delivery to those enabled destinations. Review it before using this extension in a project. Use only local, trusted destinations: this iteration has no authentication; HTTP is unencrypted. Do not expose the receiver publicly. URLs must explicitly use HTTP(S), without credentials or fragments. No prompts, tool arguments, file paths, or credentials are sent. When a session identity is available, PNG requests include it for independent avatar routing.
- **Options:** the shipped desktop destination is enabled by default; other receivers require explicit configuration. `timeoutMs` defaults to `1000` and must be finite between `1` and `30000` inclusive. Invalid options safely disable networking without disabling the local avatar.
- **Image:** raw binary PNG, exactly 64×64. In avatar mode, an opaque black canvas by default, with configurable background inside the sprite bounds; `transparentBackground: true` instead preserves source RGBA on a transparent canvas for loopback desktop/simulator destinations only. Post-accent sprites are centered without enlargement in a 48×40 viewport at the top (x=8, y=0 for native sprites), leaving the bottom 24 rows for labels embedded in the PNG: uppercase status and active subagent count (e.g. `BUSY (2)`) at y=44–48 and phase at y=54–58, centered in a native 3×5 pixel font. Status is green (idle), amber (busy), or red (error); the count and parentheses are yellow and appear only when the count is positive (zero or missing counts show the status alone), and phase is near-white light gray (`#eeeeee`). When the phase is `idle`, status is `idle` or `error`, and the active subagent count is positive, the embedded labels instead read exactly `SUBAGENTS (n)` and `RUNNING` — or the singular `SUBAGENT` / `RUNNING` with no count when exactly one is known — this is display-only, so internal status/phase and protocol headers remain unchanged; a post-error idle parent keeps red status ink. Oversized sprites shrink proportionally with nearest-neighbor sampling. Terminal borders are not mirrored. A separate cache retains at most 32 prepared avatar images.

On **every image destination** (local simulator, LAN/ESP32 and the D200 key), when a project name was captured, the PNG switches to a compact captioned layout instead: the folder name rides as a green uppercase caption at y=1–5 (one blank pixel row above; centered, truncated at 16 characters, `_` and `.` drawn, accents folded — `ñ` → `N`), a clear gap at y=6–8, the same 48×40 sprite viewport at y=9–48 with any outline reserved inside that region, two separator rows at y=49–50, the status row at y=51–55, a two-pixel gap (y=56–57), the phase row at y=58–62 and a single black pixel at y=63. Phase-clock timing, colors and idle behavior are identical; only the rows move. Invalid or absent names keep the legacy uncaptioned layout on every destination. A receiver-clock carrier retains the selected avatar's caption; the receiver owns the clock's appearance. The caption is display-only: the `X-Emote-Project-Name` header keeps carrying the percent-encoded raw basename unchanged, and rides every image request — loopback/local (the simulator and the D200 key) and LAN/ESP32 alike — while never riding heartbeats or the bodyless `claim`/`release` control routes.
- **Delivery:** per destination, one request in flight and one replaceable latest pending frame; intermediate frames may be dropped. No retries or redirects. Identical image + state/frame/set + activity selections are deduplicated even on forced terminal redraws. Failure never blocks animation; a failed selection is not retried until a visual change.
- **Scope:** interactive sessions mirror PNGs even when the terminal only supports ASCII (including forced ASCII in tmux/zellij). Text stays local; PNG animation selection and POST delivery do not require a terminal image protocol. In avatar mode, destinations receive the selected set's post-accent frames and labels; only non-loopback LED/ESP32 destinations receive an outline. For an explicitly ASCII-only set, external images fall back to the shipped `gentleman` set. Disabled/invalid destinations preserve the original ASCII-only behavior. Headless sessions still do not mirror; hidden widgets may select frames, but this is not a separate headless animation engine. Subagent processes marked with `GENTLE_PI_AGENTS_CHILD=1` do not activate the extension, even when RPC reports a UI: they cannot render an avatar, send HTTP/D200 frames, or change shared output preferences. The primary session retains its normal delegation scenes and subagent count; interactive RPC hosts without the child marker remain supported.

When status is `error` and phase is `idle`, the external display's status row shows `IDLE` in the same red instead of `ERROR`. Errors during non-idle phases retain red `ERROR`. This label change is external-display-only: internal activity, protocol headers and terminal rendering remain unchanged.

**LED/ESP32 destinations (non-loopback) always receive a one-pixel external silhouette**, white (`#ffffff`) by default. Configure `outline: "#ffffff"` with another RGB hex color to change it; the color can be inherited from the parent or overridden per target. Omitting the option keeps the white outline, rather than disabling it. Loopback destinations (the desktop application, local simulator and D200) ignore configured outline colors and receive no outline; terminal art and text labels are also unaffected. Sprites with any transparency use their alpha mask; fully opaque sprites treat pure black as background for the outline only. Only background connected to the outside is outlined, so enclosed holes stay untouched. Black artwork touching the external black matte cannot be distinguished from it. The outline may extend one pixel outside the sprite bounds; pixels at the top canvas edge are clipped.

### Control panel

`/emote` with no argument opens a modal panel (`/emote panel` is the explicit alias). It is **plugin-owned**: `ctx.ui.custom()` is public Pi extension API, so nothing in Gentle Shell changes and upstream updates cannot conflict with it.

Sections: **OUTPUTS** (terminal avatar, local simulators/desktop, D200 with its port, LED/ESP32 with its destination count), **CLOCK** (`mode` and the deadline per destination: `remaining <n>s`, `active`, `not-settled`), **STATUS** (activity, ODD phase with its source, selected PNG) and **APPEARANCE** (avatar manual/auto, title, size, placement, frame, accent). **ACTIONS** offers avatar cycling, the demo and the status line.

Keyboard: arrows or `j`/`k` move, Enter or Space applies, Escape or `q` closes. The panel rebuilds every row from live state on each draw and once per second; it sends nothing, renders no destination, route or credential, and a panel failure never reaches the avatar, delivery or the prompt.

Every output switch goes through the same command entry point as typing it, so persistence, LED ownership claims and failure paths are identical. The **CLOCK** mode is session-local: switching a destination applies live, writes nothing, and returns to the configured mode on `/reload`. **`size`, `placement`, `frame` and `accent` are global**: the panel validates the new value and writes it atomically to the user-global config of the agent directory the session runs on, preserving every unrelated key, then applies it live — a failed write leaves both the file and the running appearance untouched. LED layout keys (`outline`, `background`, `backgroundCoverage`) and the D200 key are deliberately not editable: the panel layout cannot be altered and the key only mirrors the avatar.

### USB serial output

`/emote usbOn` drives the LED panel over USB CDC instead of HTTP, using the firmware's documented **wire protocol v1** (`docs/serial-transport.md` in the firmware repository): `EMOTE`/`EMOTE_READY` enters the binary session, 18-byte `EMTS` frames carry one operation with a reflected CRC-32 and a raw PNG payload, 12-byte `EMTR` replies are matched by request id while scanning past interleaved console lines, and `EMTE`/`EMOTE_EXIT` leaves cleanly. Delivery is stop-and-wait —one frame in flight, the whole frame resent once on a NACK or a missing reply— so a frame can never overtake another; intermediate animation frames are dropped and only the newest is sent.

Bare `usbOn` succeeds directly when exactly one serial port is visible; with none it warns and stays off, and with several it offers an interactive picker listing each port's OS path plus the metadata the OS reports (friendly name, manufacturer, serial number, vendor/product id — missing fields are simply absent, control sequences are stripped, and no compatibility is claimed). Cancelling the picker changes nothing, and the picked port becomes the session's port: `usbOff` then a bare `usbOn` reuses it without prompting again (the choice is never written anywhere), while a failed open leaves the remembered port untouched. Without an interactive TUI, several visible ports keep the previous refusal (`more than one serial port is visible (N); name the display port explicitly`) and a session-start restore of a saved On never opens a modal. `usbOn COM5` fixes the port for the session, bypasses the picker and writes nothing, like the D200 port. The output is **success-gated**: a failed open or a refused port name warns and persists nothing, so a machine without the serial module never keeps an On preference it cannot honour.

The USB PNG uses the **same LED layout as `displayOn`**: the group outline (white `#ffffff` by default, or the configured `externalDisplay.outline` color — the USB board is always a physical LED target, so it always receives a silhouette), the same `background`/`backgroundCoverage`/`transparentBackground` group options, and the same compact captioned layout with the effective project title: a saved `/emote title` override or the folder basename, omitted safely when invalid. The caption ink follows the session's context band like the LED destinations (pure green by default, yellow from 60%, red above 80%). `/emote title` recomposes the current USB frame immediately, including the bare reset back to the folder name; per-target `targets:` overrides stay HTTP-specific and USB always uses the group options. The USB composition carries no per-destination phase-elapsed clock, and it does follow the group's idle-clock handoff: when `externalDisplay.idleClock` is omitted, USB enters **receiver** mode by default — after more than five uninterrupted settled idle minutes the panel receives exactly one clock-tagged carrier composed from the current avatar and its live validated title (the protocol's existing clock flag, no clock artwork is generated here), ordinary frames stay suppressed while it lasts, and the latest ordinary frame resumes immediately on real activity. The link's 5 s heartbeats keep running during receiver ambient, exactly like an HTTP receiver. An explicit `"off"` disables the handoff and keeps ordinary delivery; an explicit `"receiver"` behaves like the default; `"silence"` stops both ordinary frames and the link's own heartbeats while ambient, like the HTTP silence mode. Any other value reads as `"off"` on USB. `usbOff`, a session start and shutdown clear the clock truth; a restarted link always begins a fresh five-minute deadline.

`serialport` is an optional dependency, imported only when this output starts. Without it the command warns (`the optional serialport package is not installed`), every other output keeps working, and the rest of the package needs no native module.

**Diagnostics.** Failures are reported once per distinct cause as warnings, and clear when a frame is accepted again: `usb image composition failed: <cause>` when the 64×64 frame cannot be composed (delivery to the other outputs is unaffected), `usb frame rejected: <result>` when the firmware refuses a frame, `usb frame send failed: <cause>` when the frame cannot be written to the port, and `usb claim rejected: <result>` / `usb claim send failed: <cause>` when the session's claim is refused or undeliverable. The first accepted frame is confirmed with an informational `usb frame accepted (<n> b64 chars)`.

### Receiver-owned idle clocks after five minutes

**The extension never generates clock faces.** Set `externalDisplay.idleClock` according to each receiver's capability, not its IP address:

| Mode | After more than five uninterrupted idle minutes |
|------|-----------------------------------------------|
| `"off"` (HTTP default when omitted; the shipped desktop target explicitly uses `"receiver"`) | Ordinary avatar delivery and session heartbeats continue; no clock handoff |
| `"receiver"` | Send one existing prepared avatar PNG tagged state `clock`, frame `clock.png`, set `idle-clock`; the desktop utility draws its own clock. Existing session heartbeats continue without periodic PNGs |
| `"silence"` | Stop both PNGs and heartbeats, clearing pending traffic; the LED receiver enters its autonomous fallback after another **10 seconds** without traffic |

The USB serial output reads the same group mode with one approved difference: omitted there defaults to `"receiver"` (see [USB serial output](#usb-serial-output)).

```json
{
  "externalDisplay": {
    "enabled": true,
    "idleClock": "off",
    "targets": [
      { "enabled": true, "url": "http://127.0.0.1:8001/emote", "idleClock": "receiver" },
      { "enabled": true, "url": "http://gentle-matrix.local/emote", "idleClock": "silence" }
    ]
  }
}
```

The optional field accepts only the exact strings `"off"`, `"receiver"` and `"silence"`; other values (including `null`, booleans and differently cased strings) disable the affected destination with a configuration warning — on USB they simply read as `"off"` for the handoff, delivery unchanged. Targets inherit the parent mode unless overridden; normal field-by-field config layering applies, while `targets` arrays are replaced as a whole. No mode is inferred from loopback/LAN addressing. Nothing enables paused/off outputs, changes saved preferences or replaces the terminal avatar.

The coarse phase must stay `idle` with no active subagent, and a **settled error counts as idle**: after a turn whose last tool failed, the host keeps reporting status `error` with phase `idle`, and every destination already labels that combination `IDLE` (in red), so it starts the clock instead of blocking it for the rest of the session. Busy activity, a non-idle phase, a published work phase, active subagents or an explicit non-idle frame preview cancels the deadline. The `idle` and `grandma` states share one continuous idle budget: switching between them does not restart it. Grandma's separate timer and its untimed phase row without subagents are unchanged. Eligibility uses monotonic time and is strictly **more than** five minutes; reload/recreation starts a fresh deadline.

If a destination keeps showing avatars past the deadline, `/emote status` names the blocking input: a `not-settled` deadline with `status=busy`, a non-idle phase, `activeSubagents` above zero, a published work phase or a preview state is why the five minutes are not running, and `session=no` means the receiver is receiving session-less frames. A session that was already running before an extension update keeps the old code until `/reload`.

Receiver mode reuses the selected avatar's prepared bytes (including its original state labels, caption, transparency and outline), not a fabricated raster. No source sprite means no carrier or clock session. Ambient animation selections and title changes are remembered without uploading more carriers; activity restores the latest selection and caption immediately through the normal bounded queue. Silence mode also resumes ordinary delivery immediately on activity. Already in-flight requests may finish, but stale pending traffic is dropped or replaced. Paused outputs send nothing; resuming while still ambient honors the configured mode.

Clock appearance and animation belong entirely to the receiver. `/emote status` continues reporting the renderer's **source avatar PNG**. The existing **1 Hz phase elapsed-time scheduler** remains active for ordinary work phases; it is independent of this idle handoff.

The session-title caption reflects the host's context usage on every image destination: **green below 60%**, **yellow from 60% through 80% inclusive**, and **red above 80%**. Missing or unavailable usage retains the destination's normal green. Usage refreshes on host lifecycle and streaming events; changes within one color band do not resend images. The color is embedded in the avatar PNG, which the desktop displays unchanged; no additional context header or receiver-side title widget is needed. The receiver's autogenerated clock is unaffected. Context changes do not alter the avatar, status or phase colors, enable paused outputs, or upload another idle-clock carrier. The latest title color returns with the avatar when activity resumes.

### Ulanzi D200 key

`/emote d200On` adds a destination for the [Ulanzi D200 key client](../gentle-emote-d200) that lives next
to the terminal: selected avatar frames with labels and no outline are POSTed to
`http://127.0.0.1:8003/emote`. `/emote d200Off` disposes it.

- The toggle is **session-local** (as is the port): initially off, it never writes `config.json`, never writes any preference file, and never changes configured `externalDisplay` destinations. Every new session or `/reload` starts it **off**, even when an older version saved a `output-states/d200.json` preference — that legacy file is ignored silently (never read, never warned about, never rewritten), so its bytes survive untouched.
- `/emote d200On <port>` uses that TCP port for the current session instead of the default, for a key
  client that listens somewhere else. The port is **never written anywhere**: `d200Off` followed by bare
  `d200On` reuses the session's port choice, while the port returns to `GENTLE_EMOTE_D200_PORT`/`8003`
  at the next session start, `/reload` or restart.
  Naming another port while the mirror is already on replaces the sender instead of being ignored.
  Only a bare decimal port in `1`–`65535` is accepted; `0`, `65536`, `-1`, `+8003`, `80.5`, `1e3`,
  `0x1f90`, `abc`, `127.0.0.1:9000`, `9100/emote` and URLs are refused with
  `invalid D200 port (1-65535); D200 mirror unchanged`, and an empty argument with
  `missing D200 port; D200 mirror unchanged`. A refused port sends nothing and leaves the live mirror
  alone; there is no saved preference to leave untouched.
- Port **8003** keeps the key clear of the browser simulator (`8000`) and of the ESP32 firmware
  (`80`). `GENTLE_EMOTE_D200_PORT` overrides it for local experiments.
- Enabling it mid-session starts with the current activity labels and re-sends the current frame.
- **Herdr panel focus (opt-in sender side)**: the explicit `/emote d200On` command wires the same captured Herdr focus controller as the configured local group, so a valid click signal from a compatible receiver ACKs successful focus on the next ordinary frame or heartbeat. There is no session-start restore anymore, so no sender — and no focus wiring — is ever created from a saved preference. The mirror keeps every guard: exact `/emote` loopback route, valid session identity, `DEDICATED-SUCCESS-v1` contract, shared dedup with per-destination ACK. Without valid Herdr context no callback is captured and the mirror is focus-less at any port. **Receiver compatibility is required, not shipped**: the key receiver must answer accepted frames with the exact 204 + `X-Emote-Focus-Request-Id` signal; this sender change alone does not certify it.
- The mirror explicitly uses `idleClock: "receiver"`: one cached avatar carrier with clock metadata and existing heartbeats. **Clock rendering in the D200 receiver is pending implementation**; this prepares the same handoff as the desktop without generating clock artwork here.

### Receiver protocol v1

`POST` to the configured URL with `Content-Type: image/png` and these headers:

| Header | Value |
|--------|-------|
| `X-Emote-Version` | `1` |
| `X-Emote-State` | Delivered state, e.g. `think`, or `clock` for the idle clock |
| `X-Emote-Status` | `idle`, `busy`, or `error` (agent activity, independent of animation) |
| `X-Emote-Phase` | `idle`, `thinking`, `responding`, `executing`, `waiting`, or `compacting` |
| `X-Emote-Work-Phase` | Optional detailed ODD work phase from the native Gentle Shell bus or a successful explicit `gentle_odd_phase` call: `authorizing`, `exploring`, `researching`, `deciding`, `planning`, `implementing`, `checking`, or `closing`; omitted when neither source supplies a phase |
| `X-Emote-Active-Subagents` | Nonnegative count of active subagent tasks (native task lifecycle when observed, otherwise in-flight tool calls) |
| `X-Emote-Frame` | Selected filename, e.g. `think.png`, or `clock.png` for the idle clock |
| `X-Emote-Set` | Actual avatar set directory basename, never its path; `idle-clock` for the receiver-clock carrier |
| `X-Emote-Session-Id` | Optional stable host session ID; absent when unavailable or invalid |
| `X-Emote-Project-Name` | Optional sending project name: the working directory's folder basename only (for example `gentle-emotex`), never the full path, percent-encoded UTF-8 for safe HTTP transport; sent on every image request — loopback/local (the desktop simulator and the D200 key) and LAN/ESP32 alike, so the panel receiver can bind the session title — and never on heartbeats or on the bodyless claim/release control routes; omitted when unavailable, empty, oversized, path-like (separators or dot segments), control characters or malformed Unicode — invalid names never fail delivery. Avatar PNGs on every image destination additionally draw the name as a green caption above the sprite (see the captioned layout below) |
| `X-Emote-Stream-Id` | Random UUID per destination sender lifetime |
| `X-Emote-Sequence` | Increasing positive integer assigned when sending each image or heartbeat; at most u64 for session-aware traffic, otherwise the legacy 1–20 digit range |

Activity-only changes resend the PNG even when the sprite has not changed; its pixels stay identical if the selected state, visible ODD status text and status/count labels are unchanged. These additive v1 headers contain no reasoning text or tool arguments. The project name is metadata only: it names the folder the agent is working in so a desktop utility can label the avatar; it is never the full path, and empty, oversized, path-like or malformed-unicode names are omitted safely rather than drawn or delivered. Subagent counts come from Gentle Shell's native task lifecycle bus (`gentle-pi:notification:source`, statuses `queued`/`running`/`waiting` active and `completed`/`failed`/`cancelled`/`timed_out` terminal): once a transition was observed for the current session that count is authoritative, it is not summed with tool calls, survives agent boundaries and compaction, and only an actual session change clears it. On hosts without the bus (or before the first transition), the count falls back to observed `subagent_run/continue/reply` calls (including MCP-prefixed names) as before, resetting at agent boundaries. Restore is silent — there is no snapshot or replay — so tasks queued before the subscription (a reload, or a start mid-task) become visible only at their next emitted transition. Foreign-session, malformed and duplicate/out-of-order notifications never mutate the count, and a finished task can never be resurrected by a late event. The receiver can display the PNG directly without drawing status/phase text itself. Counts above 999 display as `(999+)`; the header retains the exact count. Older receivers can ignore these headers.

**ODD status text:** when a valid ODD work phase is available, the PNG status row shows that text (for example `EXPLORING` or `PLANNING`) instead of ordinary `BUSY`/`IDLE`. Its color still follows the underlying activity. Error labels and the existing `SUBAGENT(S)` override keep priority; counts remain yellow and capped at `(999+)`, with long status words shortened to keep the complete count inside the 16-character row. Missing, cleared or invalid detail keeps the previous status text. This changes only status copy: no animation selection, internal status, protocol headers, phase-row rules, elapsed timer, layout or saved preferences change. No configuration switch or automatic installation is added.

**Explicit-phase compatibility:** the feature captures validated `gentle_odd_phase` arguments from `tool_execution_start` and applies them only after the matching successful `tool_execution_end`, which need not repeat those arguments. Failed calls do not adopt or clear a phase; completed calls are consumed, and pending calls are discarded at turn/session boundaries. Hosts that include end arguments remain supported. This feeds the existing phase-application path without changing its animation or phase-row rules. In Gentle Pi 4.6.0, automatic prompt-phase inference does not publish the expected ODD bus events: this fallback recovers explicit tool-reported phases only, not every automatically inferred phase. No host upgrade or installed-package change is required.

In avatar mode, the PNG phase row describes the selected image's registered state in uppercase. Action labels use **-ing**: `think` → `THINKING`, `talk` → `TALKING`, `read` → `READING`, `write` → `WRITING`, `compact` → `COMPACTING`, `ask` → `ASKING`, `delegate` → `DELEGATING`, `remember` → `REMEMBERING`, `explore` → `EXPLORING`, `build` → `BUILDING`, `verify` → `VERIFYING`, `judge` → `JUDGING`, and `review` → `REVIEWING`. The eight ODD phases already use -ing and stay unchanged (for example, `planning` → `PLANNING`); nonverb labels such as `IDLE`, `TOOL`, `SUCCESS`, `JIRA` and `SUPER-YOLO` also stay unchanged, including the hyphen.

This wording is display-only: `/emote write` still previews the `write` state, `/emote demo` and `/emote status` keep the internal state names, and receiver metadata such as `X-Emote-State: write` is not renamed. The selected image still wins over the coarse activity and published work phase, even under `idle` or without a host phase. The exception is unchanged: when phase is `idle` and status is `idle` or `error` with active subagents, the rows remain `SUBAGENTS (n)` / `RUNNING` — singular `SUBAGENT` / `RUNNING` without a count when exactly one is known — regardless of the selected image.

Without a registered selected state, a detailed ODD work phase replaces only the coarse `thinking`/`executing` label; otherwise the coarse phase remains. Headers are unchanged: `X-Emote-Phase` stays coarse, and optional `X-Emote-Work-Phase` reports the published detail, not the image name. The native phase takes priority over the direct tool fallback, which clears at agent boundaries. A host without the phase bus can still use the fallback if it provides the `gentle_odd_phase` tool; this extension does not register that tool.

When a visible phase stays on screen for more than five seconds, the phase row gains a ticking clock in amber (`#f1bd65`), matching the clock-seconds palette, while the phase name stays gray (for example `IMPLEMENTI 00:06`), fed by the existing 1 Hz tick: the timer follows the resolved visible label, is preserved across new frames and activity updates of the same phase, and resets on every visible phase change and on pause/resume. `IDLE` and `NO TASK` carry no clock only while no subagent is running: with active subagents they time like any other phase, the timer clears the moment the workers finish, and a later start on the same visible label begins a fresh budget; `RUNNING` (active subagents) does carry a clock. Long phase names are truncated only while the clock is visible, minutes keep two digits (`01:00` at the rollover) and grow past 99 minutes while the phase text shrinks, so the row never exceeds the 16-character font limit; invalid or negative elapsed values render untimed. Unchanged phase seconds deduplicate and share the bounded PNG cache, so identical seconds never resend. The clock is display-only: protocol headers, internal state and the terminal avatar are unchanged.

Identifiers must match `[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}`. Unsupported custom names are skipped without affecting local rendering, and the matching `externalDisplay: unsupported frame identifier; skipped` report (with a `destination N:` prefix per configured destination) appears only while the session-local diagnostic `/emote debugOn` is on: it is off by default, every new session or `/reload` starts it off, it saves nothing, and it neither enables an output nor suppresses any other warning. Delivery failures, timeouts and HTTP rejections stay silent in the UI and are logged only when `debug` is enabled, which `config.debug` alone drives — a different setting from the `/emote debugOn` diagnostic. Configuration errors still produce warnings. Diagnostics never include payloads or the destination URL.

### Session-aware desktop avatars

When the host exposes a valid session ID, every image carries it. IDs are captured
before constructing the destination clients and remain immutable for their lifetime.
A new `session_start` creates new streams for the current session. Session IDs must
match `[A-Za-z0-9._:-]{1,128}`; missing, invalid, or throwing host identity falls back
to the legacy PNG sender. These IDs are metadata, not authentication.

For an exact `/emote` destination without a query string, session-aware clients also
send a **bodyless `POST /emote/heartbeat` every 5 seconds** after the first image is
sent. Heartbeats carry version, session ID, stream ID and sequence headers, without
a body. They share the bounded image queue and timeout; pending images take priority.
Unchanged images remain deduplicated. A receiver returning 404 for the heartbeat
route is probed only once per sender lifetime; its ordinary PNG delivery continues.
Other destination paths and clients without a session ID get no heartbeat route.

The desktop keeps one avatar per session and expires it after **30 seconds without
a valid image or heartbeat**. It retains the final avatar's last image when none
remain active; a new live session replaces that retained image. A timed-out known
session can reactivate through newer communication.

Pausing an output, entering `idleClock: "silence"` ambient mode, or disposing the extension stops its heartbeats. The current
shutdown hook does not establish permanent closure versus reload, so this sender
uses timeout fallback rather than falsely sending a close event. Turn completion
and idle periods do not close sessions. The receiver supports explicit close for
clients with a proven close event, but this extension does not infer one. Child
sessions remain excluded from all shared-display delivery. No destinations or
output preferences are enabled automatically.

### Desktop click → Herdr panel (E2E-4dcc832)

**Functional verification is complete for sender `babaf72` with desktop receiver
`4dcc832` (`DEDICATED-SUCCESS-v1`).** The actual receiver → Herdr → success ACK
round trip passed: the receiver consumed the ACK, exactly one focus process ran,
and no repeat occurred during 20 seconds of quiet observation. The desktop owner
relayed human confirmation that a primary click focused the correct Herdr panel,
non-session clock/empty-space clicks were inert, and dragging moved the window
without requesting focus. The user subsequently confirmed normal session cards
work: “funciona perfecto”. Publication remains subject to required issue approval,
native review and CI gates; this is not an all-tests-pass or all-versions
compatibility claim.

Installing this sender alone does not add desktop click handling. Already-running
Pi sessions need `/reload` to use an updated on-disk checkout; no reload event was
instrumented for the acceptance above. Saved output choices and independent output
gates are unchanged. This feature does not activate Windows Terminal or select a
terminal tab.

Use a Herdr-managed Pi session with its captured `HERDR_ENV=1`, `HERDR_BIN_PATH`,
`HERDR_SOCKET_PATH` and `HERDR_PANE_ID` context, and either an enabled configured
loopback `/emote` destination (no query) or the dedicated D200 mirror (`/emote d200On`,
session restore included). `/emote localOn` enables the local delivery channel; the
signal itself never enables any output. Missing/invalid Herdr context means no focus
capability and no acknowledgement. Trust the configured local receiver: session IDs
route requests, but are not authentication.

| Direction | Headers / meaning |
|-----------|-------------------|
| Accepted current-session/current-stream frame or bodyless heartbeat response | Exactly **204**, empty body; `X-Emote-Focus-Request-Id: <id>` requests focus for the initiating request's immutable session. No action or session echo is required |
| Every next ordinary frame or heartbeat to that same destination, after confirmation | `X-Emote-Focus-Ack: <id>` acknowledges **successful panel focus**, never receipt or pending work |

IDs contain 1–128 ASCII letters, digits or `_.:-` only (the exported
`HERDR_FOCUS_ID_PATTERN`). The receiver keeps one latest pending click
**per session**, using instance nonce + counter IDs without reuse and a fixed
**15 s TTL**. Only a matching success ACK clears it; old ACKs never clear newer
clicks. The receiver also retires pending clicks on stream retirement/takeover,
accepted close, 30 s inactivity expiry, eviction or shutdown. TTL and expiry belong to
the receiver; the sender adds no timers, retries or polling.

ACK requires the trusted Herdr CLI to exit 0 and return bounded parsed
`result.type: "agent_info"` with the captured `agent.pane_id` and
`agent.focused: true`. Pending, failed, replaced or disposed focus never ACKs.
A duplicate shares its original promise/outcome: success can ACK without another
process; failure stays false without retry (within bounded session history), so
the receiver's TTL expires it. One session controller shares deduplication across
local destinations; ACK state remains per destination and stream, never global.
Execution is shell-free, limited to one running and one latest pending click,
with a 2 s timeout. HTTP delivery does not wait for that process: confirmed success
appears only on the next ordinary frame or heartbeat.

No response body is parsed (it is still canceled), and no response can choose an
executable, pane, arguments or socket. Session and stream identity come from the
immutable initiating request; the response cannot retarget focus. Comma-joined
duplicate values, missing/malformed/oversized IDs, **every non-204 response**
(including other 2xx), other paths and non-loopback hosts are ignored. Old generic
`X-Emote-Action` / `X-Emote-Action-Id` / `X-Emote-Session-Id` response headers alone
are ignored, and the sender never emits `X-Emote-Action-Ack`.
Invalid or unknown ACKs are ignored by the receiver without rejecting a valid POST.
Both the configured local group and the dedicated D200 mirror participate when the
same captured controller was wired in; the default callback-less D200 factory (no
Herdr context) proves focus-less on every port. LAN/LED and serial outputs are
excluded. A participating destination is identified by its explicit sender
capability, not by guessing a port. Any trusted participating receiver can emit
this fixed signal, and the D200 key receiver must implement the identical
DEDICATED-SUCCESS-v1 response contract (exact 204 plus `X-Emote-Focus-Request-Id`)
to be compatible; receiver support itself is not yet shipped and is not certified here.

Clicks arrive with the next frame, or the ordinary **5 s heartbeat** while idle
(after the first frame); queueing/network delays can add latency. Receiver-clock
mode keeps that heartbeat channel alive. `localOff` and ambient `idleClock: "silence"`
intentionally stop it, so clicks cannot arrive until delivery resumes. Pause/dispose
clears sender ACKs and invalidates late responses and asynchronous focus completions,
even after pause then resume. Older click completions cannot overwrite newer request
state. Session start captures fresh Herdr context and disposes old queued focus work;
rebuilding destinations for `displayOn <address>` clears per-stream ACKs but keeps
the current session controller and deduplication history.

The captured pane is **not migrated** if Herdr moves or destroys it. A failure or
mismatched confirmation produces no ACK; the receiver's 15 s TTL expires the click.
There is no Windows activation/tab fallback.

## Create your own avatar

The Gentleman is just the default set: swap in your own character without touching the extension.

### 1. Make the frames

One folder per set, one subfolder of PNG frames per state:

```
my-avatar/
├── emotes.json            # optional: timing and special frames
├── idle/idle.png          # resting pose (required)
├── idle/idle_blink.png    # optional blink
├── think/think.png
├── talk/talk_close.png    # talk_small.png, talk_mid.png, talk_wide.png
├── hi/hi_01.png           # animated states: frames play in filename order
├── hi/hi_02.png
└── ...                    # any state from the table above
```

- **Required:** only `idle`. A missing state just doesn't animate, so you can start small and add scenes later.
- **Size:** any size fits, because the image is scaled to the frame. Small pixel art such as 48×40 keeps it crisp.
- **Frame order:** frames play in alphabetical order, so zero-pad the names (`_01`, `_02`…). Frames named `in_*` play once, then the other frames of that state loop; the greeting uses that for the landing.
- **Transparency:** use a transparent background; the frame and the terminal show through.
- **Accent color:** pixels painted exactly `#ff00ff` (base), `#aa00aa` (shade) or `#ff80ff` (light) follow the accent color, like the Gentleman's rose.

### 2. Tune the timing (optional)

`emotes.json` sets how each state plays. Copy `emotes/gentleman/emotes.json` as a starting point:

```json
{
  "idle": { "default": "idle.png", "blink": "idle_blink.png" },
  "talk": { "weights": { "talk_close.png": 1, "talk_small.png": 3, "talk_mid.png": 3, "talk_wide.png": 1 } },
  "cycle": { "hi": "loop", "read": "pingpong" },
  "frameMs": { "hi": 300, "read": 450 }
}
```

`cycle` is `"loop"` (1-2-3-1-2-3) or `"pingpong"` (1-2-3-2-1). `frameMs` is the time per frame in milliseconds.

### 3. Install it and select it

Put the folder in one of these places:

- `<agent dir>/extensions/gentle-emote/emotes/my-avatar/`: for you, in every project.
- `.pi/extensions/gentle-emote/emotes/my-avatar/`: only for that project, so you can commit it for your team.

Select it immediately with `/emote avatar my-avatar`, then `/emote demo` to check it.
Use `/emote avatar auto` to return to mappings. Alternatively configure automatic selection in `config.json`:

```json
{
  "emotes": [{ "model": "*", "emote-set": "my-avatar" }]
}
```

Run `/reload` and `/emote demo` to check every state.

### Different avatars per model

Entries are glob patterns against the model ID and/or thinking level. The last match wins:

```json
{
  "emotes": [
    { "model": "*", "emote-set": "gentleman" },
    { "model": "*haiku*", "emote-set": "my-avatar" },
    { "thinking-level": "high", "emote-set": "focused-avatar" }
  ]
}
```

### A YOLO look for your avatar

Ship a twin set named `<your-set>-yolo` (for example `my-avatar-yolo/`) next to it. While Gentle Shell's YOLO or Super YOLO mode is on, every frame comes from the twin instead; states missing there simply don't animate, so copy the whole set. The rest pose is `<set>/yolo/yolo.png` for the rocket and `<set>/super-yolo/super-yolo.png` for the sun. Without a twin, your avatar keeps its normal look.

### Text-only avatars

For terminals without images, a set can be plain text: add an `ascii.yaml` instead of PNGs. See `emotes/ascii/ascii.yaml` for the format.

### Drawing with code

The Gentleman is not hand-drawn: `scripts/sprites/` generates every frame from code, and `npm run sprites` rebuilds it. To build your character the same way, clone the repo, copy `scripts/sprites/`, change the shapes and colors, and point the output to your set's folder.

## Terminals

| Terminal | Renderer | Status |
|----------|----------|--------|
| Ghostty, kitty, WarpTerminal | kitty Unicode placeholders | ✅ Crisp image in a frame |
| tmux (inside Ghostty or kitty) | kitty Unicode placeholders | ✅ Needs `set -g allow-passthrough on` |
| iTerm2, WezTerm | iTerm2 images | ⚠️ Works, less tested |
| Zellij, screen, others | ASCII | Fallback only |

For tmux, add this to `tmux.conf` and restart the tmux server:

```bash
set -g allow-passthrough on
set -ga update-environment TERM
set -ga update-environment TERM_PROGRAM
set -sg escape-time 0
```

Force a renderer with `terminals`:

```json
{ "terminals": [{ "match": "tmux", "render": "kitty-unicode" }] }
```

Valid `render` values: `"auto"`, `"kitty-unicode"`, `"kitty"`, `"iterm2"`, `"ascii"`.

## Limitations

- Sitting beside the prompt relies on Pi's internal layout. If a future version changes it, the avatar falls back to above the editor.
- YOLO and Super YOLO detection uses Gentle Shell's internal channel: it only reads the mode, never toggles it. In other hosts neither look shows.
- `bye` plays when you say goodbye, not when the process quits (a quit clears the screen right away).
- Zellij has no image passthrough, so it gets the ASCII fallback.

## Contributing

Open an issue first and wait for the `approved` label. A pull request has to point at that issue with `Closes #N` and needs an approving review from someone other than its author; a pull request authored by the sole maintainer instead records the review that preceded the merge. Only the maintainer merges. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits and acknowledgements

- **[pi-emote](https://github.com/cgxeiji/pi-emote)** by Eiji Onchi ([@cgxeiji](https://github.com/cgxeiji)): the animator, renderers and terminal detection come from there. This project would not exist without that work.
- **[efolchmontiel/gentle-emote](https://github.com/efolchmontiel/gentle-emote)**: the immediate upstream fork base, and the source of the structure this repository inherited.
- **[Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell)**: the host that publishes the activity status, detailed ODD work phases and subagent lifecycle events this extension consumes.
- **[Pi](https://pi.dev)**: the agent host the extension also runs in, through its extension and event API.

The Gentleman avatar, the framed layout beside the prompt and the Gentle Shell scenes were added in this fork, and so were external display delivery, activity labels, silhouette outlines, ASCII mirroring and per-destination transparent output.

Thanks to the maintainers of the upstream projects for keeping their work documented and MIT-licensed, and to everyone who reports a broken frame, a wrong label or a receiver that drops deliveries.

## License

MIT. See [LICENSE](LICENSE).
