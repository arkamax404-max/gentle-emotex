# Emote control panel (plugin-owned)
An interactive panel inside gentle-emotex that manages every adjustable part of the extension, with no change to the gentle-shell package.
Branch: feat/emote-panel. Baseline: 7c39e54. The uncommitted idle-clock fix in the working tree stays part of this branch; no push, PR or release is authorized by this document.

## Specs
S1. "crees posible solo para gentle-shell que creemos un panel para gestionar la activacion y desactivacion de la salida de los avatares y lo que se pueda de todo lo referente a gentle-emotex ?" — the panel must cover output activation/deactivation and as much of the extension's surface as it can.
S2. "ok, porque no quiero desalinearme con las futuras actualizaciones de gentle-shell, asi que por lo tanto abrimos una feature para implementar el alcance lo mas completo posible" — the widest scope, implemented entirely in gentle-emotex; the gentle-shell repository and package stay untouched, so upstream updates never conflict with us.
S3. "antes de fijar el alcance dime si para hacer esto vamos a modificar el proyecto de gentle-shell o todo quedaría dentro de nuestro plugin" — answered: everything stays in the plugin. `ctx.ui.custom()` is public Pi extension API, so a full overlay needs no host cooperation.
S4. Recorded decision from S2/S3: no cross-package protocol and no edits to gentle-shell. The panel lives in this package, is invoked by our own command, and is inert unless invoked, so no host detection or gating is required.

## Tasks
T1 | S1-S3 | parent inline | done (branch feat/emote-panel + this authority document) | Create the feature branch and the ODD authority document | commit: docs unit
T2 | S1 | parent inline, test-first | pending | Pure panel view model and text rows (`src/panel.ts`) with tests: outputs, clock modes per destination, appearance and live status, no destination ever exposed | commit
T3 | S1 | parent inline | pending | Command entry: `/emote` with no argument (and `/emote panel`) opens the overlay; `ctx.mode === "tui"` guard; every existing argument keeps its behavior byte for byte | commit
T4 | S1 | parent inline | pending | Output toggles applied through the existing command handlers, so persistence and failure paths are the ones already tested | commit
T5 | S1 | parent inline | pending | Idle-clock mode per destination (`off`/`receiver`/`silence`) as a session-local override | commit
T6 | S1 | parent inline | pending | Appearance: avatar set (manual/auto), project title, size, placement, frame and accent, session-local where no persistence exists today | commit
T7 | S1 | parent inline | pending | Live status section that refreshes while the panel is open (activity, work phase and source, selected PNG, clock deadline) | commit
T8 | S1-S3 | parent inline + focused checks | pending | Documentation (README command table, AGENTS.md panel scope, CHANGELOG) and the full suite | commit
T9 | S2 | blocked: needs an explicit owner decision on extending the documented "commands never rewrite config.json" exception before any code | pending | Persist the new keys (size, placement, frame, accent, clock mode) into the user-global config instead of session-only. Risk: item 3 (public config contract and the documented write invariant) | commit

## Log
L1. Original request, verbatim: "crees posible solo para gentle-shell que creemos un panel para gestionar la activacion y desactivacion de la salida de los avatares y lo que se pueda de todo lo referente a gentle-emotex ?"
L2. Feasibility answer recorded: Pi gives `ctx.ui.custom()` to any extension (`docs/extensions.md`: "For custom UI, use `ctx.ui.custom()`"), so a full overlay needs no shell cooperation; the emote side already owns all state, handlers and persistence.
L3. Options laid out (emote-owned panel / shell-owned `/gentle:emote` / shell section in `/gentle:customize`). Cost of touching gentle-shell recorded: it is installed as `git:github.com/Gentleman-Programming/gentle-shell@v4.5.1` with a clean checkout at that tag, so editing it means changing the package source, rebasing against upstream, and an extra delivery/environment risk.
L4. User decision, verbatim: "ok, porque no quiero desalinearme con las futuras actualizaciones de gentle-shell, asi que por lo tanto abrimos una feature para implementar el alcance lo mas completo posible". Scope: widest possible, plugin-owned; no gentle-shell edits.
L5. Design decisions recorded before code: (a) no `pi.events` protocol between packages, because the panel runs in-process and calls our own handlers; the `Risk: item 3` contract risk disappears with it; (b) panel writes only through surfaces that already persist today (output states, `avatar.json`, `title.json`); new keys (size, placement, frame, accent, per-destination clock mode) are session-local until the owner decides on T9; (c) UI copy in English like the rest of the repository, and no destination URL, path or credential is ever shown; (d) existing command arguments keep working, so the panel is an addition, never a replacement.
L6. Open decision tracked as T9, not silently assumed: persisting the new keys would extend the documented exception in AGENTS.md ("Commands never rewrite config.json — with one documented exception"), which is a public contract change and needs the owner's explicit word.