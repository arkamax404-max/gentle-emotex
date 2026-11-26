import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, unwatchFile, watchFile } from "node:fs";

import { EMOTE_STATES } from "./types.ts";
import type { Config, EmoteState, ResolvedRenderer } from "./types.ts";
import type { Renderer } from "./renderer.ts";
import { log, setDebug } from "./log.ts";
import { loadLayeredConfig } from "./config.ts";
import { resolveEmoteSet, findEmoteSetDir, loadEmotesConfig, agentDir, EXTENSION_NAME } from "./emotes.ts";
import { bannerConfigCandidates, createAccentTransform, resolveAccent } from "./accent.ts";
import type { Rgb } from "./accent.ts";
import { KittyRenderer } from "./render_kitty.ts";
import { TmuxKittyRenderer } from "./render_tmux_kitty.ts";
import { KittyUnicodeRenderer } from "./render_kitty_unicode.ts";
import { ITermRenderer } from "./render_iterm.ts";
import { TmuxITermRenderer } from "./render_tmux_iterm.ts";
import { AsciiRenderer } from "./render_ascii.ts";
import { MirroredAsciiRenderer, PngSelectionRenderer } from "./render_ascii_mirror.ts";
import { Animator } from "./animator.ts";
import { createWidgetFactory } from "./widget.ts";
import { resolveRenderer } from "./terminal.ts";
import { readYoloRest } from "./yolo.ts";
import { ExternalDisplay, ExternalDisplays, type IdleClockStatus, type SelectedImage, type FrameSink } from "./external_display.ts";
import { buildPanelModel, cycleClockMode, framePanelLines, nextAppearanceValue, type PanelAppearanceKey, type PanelClockRow, type PanelItem, type PanelSnapshot } from "./panel.ts";
import { writePanelConfig } from "./config_write.ts";
import { createSerialDisplay, serialSystemDeps, type SerialDisplay, type SerialImage, type SerialPortInfo } from "./serial_display.ts";
import { parseSerialPortPath } from "./serial_protocol.ts";
import { parseDisplayAddress, persistGlobalDisplayTarget, withDisplayTarget } from "./display_address.ts";
import { prepareDisplayImage } from "./display_image.ts";
import { IdleClock, IDLE_CLOCK_TICK_MS } from "./idle_clock.ts";
import { createD200Display, d200Url, parseD200Port, resolveD200Port } from "./d200_display.ts";
import { DisplayActivityTracker } from "./display_activity.ts";
import { SubagentTaskTracker } from "./subagent_activity.ts";
import { WORK_PHASES, WorkPhaseTracker, isWorkPhase } from "./work_phase.ts";
import type { WorkPhase } from "./work_phase.ts";
import { OutputStateStore, OUTPUTS } from "./output_state.ts";
import { TitleStore, normalizeTitle, encodeProjectName } from "./title_state.ts";
import { AvatarStateStore } from "./avatar_state.ts";
import { avatarNames, findAvatar } from "./avatar_selection.ts";
import { createHerdrFocusController, type HerdrFocusController } from "./herdr_focus.ts";

const WIDGET_KEY = "gentle-emote";
const BANNER_POLL_MS = 2000;

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "mem_search", "mem_context", "mem_get_observation", "codegraph_explore", "web_fetch"]);
const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch"]);
const ASK_TOOLS = new Set(["ask_user_question", "ask_user_choice"]);
const FAREWELL_TOOLS = new Set(["mem_session_summary"]);
const SUBAGENT_TOOLS = new Set(["subagent_run", "subagent_continue", "subagent_reply"]);
const JOB_TOOLS = new Set(["bash_background", "monitor", "job_list", "job_stop"]);
const MEMORY_TOOLS = new Set(["mem_save"]);
/** Gentle Shell hands out a read/observe adapter for its YOLO switch on this event-bus channel. */
const YOLO_HOST_CHANNEL = "gentle:yolo:host-ui";
/** Fired while a guarded confirm, choice, or questionnaire is waiting. The Yes/No art covers the execution. */
const HERDR_BLOCKED = "herdr:blocked";
const YOLO_DISCOVERY_MS = 300;
/** Quick tools whose scene would otherwise flash by: keep it until the next event. */
const STICKY_TOOL_STATES = new Set<EmoteState>(["jobs", "remember"]);
/** The explicit ODD phase tool: a successful call names the phase, "clear" drops the direct fallback. */
const PHASE_TOOL = "gentle_odd_phase";

const PREVIEW_MS = 6000;
const DEMO_STEP_MS = 3500;
const PREVIEW_TALK_TEXT = "Here is the thing: this preview talks for a few seconds so you can watch the mouth move and the mustache bounce.";
/** States that never end on their own and would stay up forever in a preview. */
const PREVIEW_LOOPING_STATES = new Set<EmoteState>([
  "think", "read", "write", "tool", "ask", "compact", "delegate", "jobs", "remember", "yolo", "super-yolo",
  "explore", "build", "verify", "judge", "review", "jira",
  "authorizing", "exploring", "researching", "deciding", "planning", "implementing", "checking", "closing",
]);
const DEMO_SEQUENCE: EmoteState[] = [
  "hi", "think", "talk", "read", "tool", "delegate", "explore", "build", "verify", "judge", "review", "jira",
  ...WORK_PHASES,
  "write", "jobs", "remember", "ask", "success", "failure", "compact", "yolo", "super-yolo", "grandma", "bye",
];
const EMOTE_DESCRIPTIONS: Record<string, string> = {
  hi: "flies in under a propeller beanie",
  idle: "resting, blinks",
  think: "light bulb switches on",
  talk: "streaming a reply",
  read: "deerstalker, pipe and magnifier",
  write: "frying pan cooking code",
  tool: "whipping the IA robot",
  success: "celebrates",
  failure: "robot blew up",
  compact: "shrinks in place",
  ask: "Yes/No while a prompt is on screen",
  grandma: "idle too long (press a key to wake)",
  bye: "stores memory, tips the hat",
  delegate: "football coach whistling at IA robots (subagents)",
  jobs: "sips mate watching a progress bar (background jobs)",
  remember: "whispers into the Engram elephant's ear (mem_save)",
  yolo: "sunglasses, YOLO headband and a rocket (YOLO mode)",
  "super-yolo": "the same character with a sun (Super YOLO mode)",
  explore: "explorer hat, walking, flashlight on footprints (explore subagents)",
  build: "welding mask and torch (worker / fix subagents)",
  verify: "police officer, a stamp lands on the robot (verify / validator subagents)",
  judge: "judge wig and gavel (judge / refuter subagents)",
  review: "red pen on a page, robot holds the review sign (review-* subagents)",
  jira: "launches a rocket into a cloud (jira subagents)",
  authorizing: "reviews an approval card (host ODD phase)",
  exploring: "sweeps a magnifying glass over footprints (host ODD phase)",
  researching: "reads an open reference book (host ODD phase)",
  deciding: "weighs two choice cards (host ODD phase)",
  planning: "draws the approach on a blueprint (host ODD phase)",
  implementing: "types on the keyboard, code flying (host ODD phase)",
  checking: "fills a checklist with green checks (host ODD phase)",
  closing: "presents the completed-work folder (host ODD phase)",
  demo: "plays the original scenes and all eight ODD work phases in a row",
  avatar: "select a saved global avatar (/emote avatar <folder> | auto)",
  title: "set the display title above the avatar for this project (/emote title <text>; bare restores the folder name)",
  internalOn: "show the terminal avatar (external delivery stays active)",
  internalOff: "hide the terminal avatar (external delivery stays active)",
  status: "show the last selected PNG, work phase source and activity snapshot (read-only diagnostic)",
  debugOn: "show the routine unsupported-frame reports (session-local diagnostic; delivery unchanged)",
  debugOff: "hide the routine unsupported-frame reports again (session-local diagnostic; default)",
  localOn: "resume delivery to configured localhost simulators",
  localOff: "pause localhost delivery without affecting the ESP32",
  d200On: "mirror every frame to the Ulanzi D200 key on 127.0.0.1:8003 and relay Herdr panel-focus ACKs when Herdr context exists; session-local (state and port, never persisted); d200On <port> uses that port for this session only",
  d200Off: "stop mirroring to the Ulanzi D200 key (session-local: nothing is saved, a new session starts off)",
  displayOn: "resume LED/ESP32 delivery and claim the display for this session; displayOn <address> points the group at that board",
  displayOff: "pause LED/ESP32 delivery and release this session's claim",
};

// Public command names are independent of the existing persisted output keys.
function outputCommandName(output: (typeof OUTPUTS)[number]): string {
  return output === "debug" ? "local" : output;
}

/** Check if a set directory contains any image frames (PNG files in state subdirs). */
function hasImageFrames(setDir: string): boolean {
  for (const state of EMOTE_STATES) {
    const stateDir = join(setDir, state);
    if (existsSync(stateDir) && readdirSync(stateDir).some((f) => f.endsWith(".png"))) return true;
  }
  return false;
}

/** Subagent name patterns, first match wins; anything else keeps the generic megaphone scene. */
const AGENT_STATES: Array<[RegExp, EmoteState]> = [
  [/jira/, "jira"],
  [/judge|refuter/, "judge"],
  [/verify|validator/, "verify"],
  [/^review-/, "review"],
  [/worker|fix|apply/, "build"],
  [/explore/, "explore"],
];

export function agentToState(agent: unknown): EmoteState {
  const name = typeof agent === "string" ? agent.toLowerCase() : "";
  return AGENT_STATES.find(([pattern]) => pattern.test(name))?.[1] ?? "delegate";
}

export function toolNameToState(toolName: string, args?: unknown): EmoteState {
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (ASK_TOOLS.has(toolName)) return "ask";
  if (FAREWELL_TOOLS.has(toolName)) return "bye";
  if (SUBAGENT_TOOLS.has(toolName) || /^mcp__.+?__subagent_(run|continue|reply)$/.test(toolName)) {
    return agentToState((args as { agent?: unknown } | undefined)?.agent);
  }
  if (JOB_TOOLS.has(toolName)) return "jobs";
  if (MEMORY_TOOLS.has(toolName)) return "remember";
  return "tool";
}

function createRendererFromResolved(resolved: ResolvedRenderer, config: Config): Renderer {
  const { protocol, multiplexer } = resolved;
  const { size } = config;
  const besideEditor = config.placement === "beside-editor";
  const inTmux = multiplexer === "tmux";
  // Only placeholder rows are plain text, so they are the only image form that fits the prompt gutter.
  if (protocol === "kitty-unicode" || (protocol === "kitty" && besideEditor)) {
    const frameRows = besideEditor && config.frame ? Math.max(2, Math.round(config.frameRows)) : 0;
    log(`createRenderer: using KittyUnicodeRenderer (passthrough=${inTmux}, frameRows=${frameRows})`);
    return new KittyUnicodeRenderer(size, inTmux, frameRows);
  }
  if (protocol === "kitty") {
    log(`createRenderer: using ${inTmux ? "TmuxKittyRenderer" : "KittyRenderer"}`);
    return inTmux ? new TmuxKittyRenderer(size) : new KittyRenderer(size);
  }
  if (protocol === "iterm2") {
    log(`createRenderer: using ${inTmux ? "TmuxITermRenderer" : "ITermRenderer"}`);
    return inTmux ? new TmuxITermRenderer(size) : new ITermRenderer(size);
  }
  log(`createRenderer: using AsciiRenderer`);
  return new MirroredAsciiRenderer();
}

const sameRgb = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export default function (pi: ExtensionAPI) {
  // RPC children can have UI, but only the primary session owns avatar outputs.
  if (process.env.GENTLE_PI_AGENTS_CHILD === "1") return;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const extDir = dirname(__dirname);

  let cwd = process.cwd();
  let { config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd);
  setDebug(config.debug);

  if (!config.enabled) return;

  // A terminal UI does not establish ownership of shared displays in delegated sessions.
  const ownsSharedDisplays = process.env.GENTLE_PI_AGENTS_CHILD !== "1";
  let externalDisplay: ExternalDisplays | null = null;
  let herdrFocus: HerdrFocusController | null = null;
  // Capture the controller, not the mutable session variable: old senders can
  // never redirect a late response to the next session's pane.
  function desktopFocusRequest() {
    const controller = herdrFocus;
    return controller?.enabled ? (id: string) => controller.request(id) : undefined;
  }
  let d200Display: ExternalDisplay | null = null;
  /** Explicit `/emote d200On <port>` choice: session-local, cleared by every session start. */
  let d200Port: number | null = null;
  /** USB serial output: one display at most, port session-local. */
  let usbDisplay: SerialDisplay | null = null;
  let usbPort: string | null = null;
  let usbPending: SerialImage | { clockPeriod: symbol } | null = null;
  /** Last image the renderer selected, so a late usb start can push it at once. */
  let lastFrameImage: SelectedImage | null = null;
  let usbBusy: SerialDisplay | null = null;
  /** Where to report a rejected serial frame, and the last error already shown. */
  let usbCtx: any = null;
  let usbWarned: string | null = null;
  /** First successful send per link, so "nothing is queued" is distinguishable. */
  let usbSentReported = false;
  /** USB receiver idle-clock handoff: strict >300000 ms settled eligibility via the shared IdleClock. */
  let usbIdleClock: IdleClock | null = null;
  let usbClockMode: "off" | "receiver" | "silence" = "off";
  let usbClockTimer: ReturnType<typeof setInterval> | null = null;
  let usbClockAmbient = false;
  let usbClockPeriod: symbol | null = null;
  /** Port of the live D200 sender, so a repeated command can tell which one it holds. */
  let d200LivePort: number | null = null;
  let contextPercent: number | null = null;
  /** Session-local diagnostic visibility of the routine unsupported-frame report.
   * `/emote debugOn|debugOff` control only this: they never persist, never touch the
   * saved "debug" output state (that is /emote localOn|localOff) and never gate the
   * debug.log file switch, which `config.debug` alone drives. Every new session and
   * every /reload starts this off; new senders inherit the live flag. */
  let frameWarningsOn = false;

  /** Propagate the session-local diagnostic toggle to every live display sender. */
  function applyFrameWarnings(): void {
    externalDisplay?.setFrameWarningEnabled(frameWarningsOn);
    d200Display?.setFrameWarningEnabled(frameWarningsOn);
  }

  /** Host usage is optional on older Pi versions; never infer context from text. */
  function refreshContextUsage(ctx: any): void {
    try {
      const percent = ctx?.getContextUsage?.()?.percent;
      contextPercent = typeof percent === "number" && Number.isFinite(percent) && percent >= 0 ? percent : null;
    } catch { contextPercent = null; }
    externalDisplay?.setContextUsage(contextPercent);
    d200Display?.setContextUsage(contextPercent);
  }

  const displayActivity = new DisplayActivityTracker(activity => {
    // Known subagent activity (native count or, before the bus speaks, observed
    // tool calls) drives two display-only behaviors: no grandma or running age
    // for the resting parent, and no invented child phase anywhere.
    knownSubagentCount = activity.activeSubagents;
    animator.setSubagentActive(knownSubagentCount > 0);
    if (knownSubagentCount > 0 && animator.currentState === "grandma") animator.transitionTo("idle");
    externalDisplay?.updateActivity(activity);
    d200Display?.updateActivity(activity);
    if (usbIdleClock !== null && usbClockMode !== "off") {
      usbIdleClock.update(activity, performance.now(), lastFrameImage?.state);
      refreshUsbClock(true);
    }
    applySubagentScene();
  });
  /** Native subagent task lifecycle (Gentle Shell bus); null falls back to the call-based count. */
  const subagentTasks = new SubagentTaskTracker(count => {
    displayActivity.setNativeSubagents(count);
  });
  /** Detailed host phase (Gentle Shell only); display detail alongside the coarse activity. */
  const workPhase = new WorkPhaseTracker(() => applyWorkPhase());
  /**
   * Direct fallback: the phase a successful explicit gentle_odd_phase call named
   * this turn. The native bus always wins; a host clear only reveals this fallback.
   */
  let directWorkPhase: WorkPhase | null = null;
  // Pi supplies args on start, not end. Keep only the validated phase per call.
  const pendingDirectPhases = new Map<string, WorkPhase | "clear">();

  /** Effective detail phase: the native bus phase, or the direct tool fallback filling the gap. */
  function applyWorkPhase(): void {
    const phase = workPhase.current() ?? directWorkPhase;
    displayActivity.setWorkPhase(phase);
    animator.setWorkPhase(phase);
  }
  let currentEmoteSet = "gentleman";
  let widgetActive = false;
  const outputState = new OutputStateStore();
  const avatarState = new AvatarStateStore();
  let manualAvatar: string | null = null;
  let latestModel = "";
  // Action methods are unavailable while the extension factory is loading.
  // session_start initializes this before emote selection uses it.
  let latestThinking = "";
  /** Per-project display title override; null shows the project folder basename. */
  let projectTitle: string | null = null;
  // Dedicated subagent scene (display-only): the resting parent swaps to a
  // configurable child avatar while exactly one known subagent runs.
  let knownSubagentCount = 0;
  let sceneSuppressed = false;
  let subagentSceneOn = false;
  /** Frames currently loaded by the scene; null when the parent's own are loaded. */
  let subagentSceneSet: string | null = null;
  let applyingScene = false;
  let subagentAvatarWarned = false;
  let uiNotify: ((message: string, level?: string) => void) | null = null;

  /** Apply the saved override on top of destinations built with the folder basename. */
  function applyProjectTitle(): void {
    if (projectTitle === null) return;
    externalDisplay?.setTitle(projectTitle);
    d200Display?.setTitle(projectTitle);
  }
  let internalVisible = false;
  let lastResolved = resolveRenderer(config.terminals, userConfiguredTerminals);
  let renderer: Renderer = new PngSelectionRenderer();
  let accent = resolveAccent(config.accent);
  let farewell = false;
  let farewellTimer: ReturnType<typeof setTimeout> | null = null;
  let greetTimer: ReturnType<typeof setTimeout> | null = null;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let demoTimer: ReturnType<typeof setTimeout> | null = null;
  let runHadError = false;
  let runUsedTools = false;
  let stopTerminalInput: (() => void) | null = null;
  let watchedBannerFiles: string[] = [];
  let yoloOn = false;
  let yoloVariant: EmoteState | null = null;
  /** Last PNG the renderer actually selected, safe fields only; diagnostics for /emote status. */
  let lastSelected: { state: string; frame: string; set: string } | null = null;

  const animator = new Animator(config, renderer);
  animator.setStateListener(() => applySubagentScene());

  // --- Dedicated subagent avatar (a display scene, never a logical phase) ---

  /** The set the parent's own visuals belong to; the scene always restores it. */
  function primarySetName(): string {
    return manualAvatar ?? resolveEmoteSet(latestModel, latestThinking, config.emotes);
  }

  /** First shipped default distinct from the parent's own selection. */
  function defaultSubagentSet(primary: string): string | null {
    for (const fallback of ["gentleled", "gentleman"] as const) {
      if (fallback === primary) continue;
      if (findAvatar(fallback, extDir, cwd)) return fallback;
    }
    return null;
  }

  /**
   * The bounded child avatar: the configured name through the existing manual
   * selection guards, otherwise the default alternate (gentleled, or gentleman
   * when the parent rests on gentleled). A missing or unusable configured name
   * falls back safely, warns once and rewrites no preference anywhere.
   */
  function resolveSubagentSet(): string | null {
    const configured = typeof config.subagentAvatar === "string" && config.subagentAvatar.trim() !== "" ? config.subagentAvatar : null;
    const primary = primarySetName();
    if (configured !== null) {
      if (configured === primary) {
        const alternate = defaultSubagentSet(primary);
        if (!subagentAvatarWarned && alternate !== null) {
          subagentAvatarWarned = true;
          uiNotify?.(`configured subagentAvatar "${configured}" is the current avatar; using "${alternate}"`, "warning");
        }
        return alternate;
      }
      if (findAvatar(configured, extDir, cwd)) return configured;
      if (!subagentAvatarWarned) {
        subagentAvatarWarned = true;
        uiNotify?.(`configured subagentAvatar "${configured}" is unavailable; using the shipped default`, "warning");
      }
    }
    return defaultSubagentSet(primary);
  }

  /**
    * Applies the display-only child scene. It exists only while the parent's
    * own visual is the resting idle (never under a prompt or the goodbye),
    * exactly one subagent is known to run, and a bounded child avatar exists.
    * Everything else — busy work, prompts, failures, compaction, talk, several
    * children — keeps the primary avatar and its own visuals; the child's real
    * phase is never invented or displayed.
    */
  function applySubagentScene(): void {
    if (applyingScene || !widgetActive) return;
    const want = !sceneSuppressed && !farewell && knownSubagentCount === 1
      && animator.currentState === "idle" && !animator.promptOpen;
    if (want) {
      const set = resolveSubagentSet();
      if (set === null) {
        subagentSceneOn = false;
        subagentSceneSet = null;
        return;
      }
      if (subagentSceneOn && subagentSceneSet === set) return;
      subagentSceneOn = true;
      subagentSceneSet = set;
      applyingScene = true;
      loadEmoteSet(set, true);
      refreshCurrentFrame();
      applyingScene = false;
      return;
    }
    if (subagentSceneOn) {
      subagentSceneOn = false;
      subagentSceneSet = null;
      applyingScene = true;
      loadEmoteSet(primarySetName());
      refreshCurrentFrame();
      applyingScene = false;
    }
  }

  /**
   * Every configured destination; paused targets retain the latest frame.
   * The sink also captures the last selected PNG for /emote status, so the
   * diagnostic works with every output off (no delivery, no network). The
   * mirrored ASCII renderer only activates its PNG companion for real
   * delivery — a capture-only sink would change what it renders — so it
   * keeps receiving null when no destination is enabled.
   */
  function frameSink(): FrameSink | null {
    const targets = [externalDisplay, d200Display].filter(
      (display): display is ExternalDisplay => display?.enabled === true,
    );
    // The usb link is started later by its command, so it must be read at call
    // time: capturing it here froze the sink with "off" for the whole session.
    if (targets.length === 0 && usbDisplay === null && renderer instanceof MirroredAsciiRenderer) return null;
    return (image: SelectedImage) => {
      lastSelected = { state: image.state, frame: image.frame, set: image.set };
      for (const display of targets) display.select(image);
      lastFrameImage = image;
      queueUsbFrame(image);
    };
  }

  /** Strips ANSI escapes and control sequences (C0, C1, DEL) so OS-provided metadata cannot reach the TUI raw. */
  function sanitizeUsbText(text: unknown): string {
    return typeof text === "string"
      ? text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim()
      : "";
  }

  /**
   * Picker label: the OS path plus only the metadata the OS actually reported,
   * stated as facts (never a compatibility claim), each piece sanitized.
   */
  function formatUsbPortLabel(info: SerialPortInfo): string {
    const facts: string[] = [];
    const push = (value: string | undefined) => {
      const clean = sanitizeUsbText(value);
      if (clean && !facts.includes(clean)) facts.push(clean);
    };
    push(info.friendlyName);
    push(info.manufacturer);
    push(info.serialNumber);
    const hex = (value: string | number | undefined) =>
      typeof value === "number" ? value.toString(16).padStart(4, "0") : sanitizeUsbText(value);
    const vid = hex(info.vendorId);
    const pid = hex(info.productId);
    if (vid && pid) facts.push(`usb ${vid}:${pid}`);
    else if (vid) facts.push(`usb vid ${vid}`);
    else if (pid) facts.push(`usb pid ${pid}`);
    const path = sanitizeUsbText(info.path);
    return facts.length > 0 ? `${path} — ${facts.join(" · ")}` : path;
  }

  /** The selector is a TUI facility, exactly like the control panel. */
  function canShowUsbSelector(ctx: any): boolean {
    return typeof ctx?.ui?.select === "function" && (ctx?.mode === undefined || ctx.mode === "tui");
  }

  /**
   * Asks the user which port to open. The answer is mapped back to the original
   * enumerated path through a Map — never re-parsed or split out of its label —
   * and a cancel, a rejection or an unrecognizable answer leave everything as it was.
   */
  async function selectUsbPort(ctx: any, candidates: SerialPortInfo[]): Promise<string | null> {
    const pathSeen = new Set<string>();
    const byLabel = new Map<string, string>();
    const options: string[] = [];
    for (const info of candidates) {
      if (pathSeen.has(info.path)) continue;
      pathSeen.add(info.path);
      let label = formatUsbPortLabel(info);
      if (byLabel.has(label)) label = `${label} (${options.length + 1})`;
      byLabel.set(label, info.path);
      options.push(label);
    }
    try {
      const chosen = await ctx.ui.select("USB serial display", options);
      if (chosen === undefined) return null;
      const mapped = byLabel.get(chosen);
      return mapped === undefined ? null : mapped;
    } catch {
      return null;
    }
  }

  /** USB CDC output: at most one display, session-local port, nothing persisted on failure. */
  async function setUsbDisplay(enabled: boolean, ctx: any, requestedPort?: string, allowSelection = false): Promise<boolean> {
    if (!ownsSharedDisplays) return false;
    if (!enabled) {
      const current = usbDisplay;
      usbDisplay = null;
      usbPending = null;
      stopUsbClock();
      if (current) void current.stop();
      ctx.ui?.notify?.(`[${EXTENSION_NAME}] usb serial display off`, "info");
      return true;
    }
    if (usbDisplay) {
      ctx.ui?.notify?.(`[${EXTENSION_NAME}] usb serial display already on: ${usbDisplay.path ?? "auto"}`, "info");
      return true;
    }
    // The remembered port is only written by a successful start: a refused
    // explicit port or a failed chosen open keeps the session's previous truth.
    let target = requestedPort ?? usbPort ?? undefined;
    if (target === undefined) {
      let candidates: SerialPortInfo[] = [];
      try { candidates = await serialSystemDeps().list(); } catch { candidates = []; }
      if (candidates.length === 0) {
        // Zero devices keeps the transport's no-device warning, without opening
        // anything or enumerating the ports a second time.
        ctx.ui?.notify?.(`[${EXTENSION_NAME}] no usb serial display found; usb serial display unchanged`, "warning");
        return false;
      }
      if (candidates.length === 1) {
        target = candidates[0]!.path;
      } else if (allowSelection && canShowUsbSelector(ctx)) {
        target = await selectUsbPort(ctx, candidates) ?? undefined;
        if (target === undefined) {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] usb serial display unchanged`, "warning");
          return false;
        }
      }
      // Several ports without an available selector keep the transport's refusal:
      // `start(undefined)` warns exactly as before and never opens anything.
    }
    const link = createSerialDisplay({
      ...serialSystemDeps(),
      sessionId: sessionId(),
      projectName: typeof cwd === "string" ? basename(cwd) : null,
      report: message => ctx.ui?.notify?.(`[${EXTENSION_NAME}] ${message}`, "warning"),
    });
    const started = await link.start(target);
    if (!started.ok) {
      ctx.ui?.notify?.(`[${EXTENSION_NAME}] ${started.error}; usb serial display unchanged`, "warning");
      return false;
    }
    usbDisplay = link;
    usbPort = started.path;
    usbCtx = ctx;
    usbWarned = null;
    usbSentReported = false;
    startUsbClock();
    // A refused claim used to vanish into a void promise: the receiver would
    // keep its previous session while this one believed it owned the display.
    void link.sendControl("claim").then(result => {
      if (result.ok) return;
      usbCtx?.ui?.notify?.(`[${EXTENSION_NAME}] usb claim rejected: ${result.error}`, "warning");
    }).catch(error => {
      usbCtx?.ui?.notify?.(`[${EXTENSION_NAME}] usb claim send failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    });
    ctx.ui?.notify?.(`[${EXTENSION_NAME}] usb serial display: ${started.path}`, "info");
    // `displayOn`/`displayOff` govern the HTTP destinations only: the serial link
    // must deliver with every HTTP output off. When no HTTP target existed at
    // session start the renderer kept no sink at all, so it is registered here.
    renderer.setFrameSink?.(frameSink());
    // A quiet idle state may never select a new frame, so the last known image is
    // pushed here instead of waiting for the animator.
    if (lastFrameImage) queueUsbFrame(lastFrameImage);
    refreshCurrentFrame();
    return true;
  }

  /** USB clock mode: the group's explicit choice, with the approved receiver default when omitted. */
  function usbIdleClockMode(): "off" | "receiver" | "silence" {
    const configured = config.externalDisplay.idleClock;
    if (configured === undefined) return "receiver";
    return configured === "off" || configured === "receiver" || configured === "silence" ? configured : "off";
  }

  /** Clock truth begins with the link itself: a fresh deadline and the 1 Hz ambient check. */
  function startUsbClock(): void {
    usbIdleClock = new IdleClock(performance.now());
    usbClockMode = usbIdleClockMode();
    usbClockAmbient = false;
    if (usbClockMode !== "off") {
      usbClockTimer = setInterval(() => refreshUsbClock(true), IDLE_CLOCK_TICK_MS);
      usbClockTimer.unref?.();
    }
  }

  /** USB off, session start reset or shutdown: no clock truth without a live link. */
  function stopUsbClock(): void {
    if (usbClockTimer) { clearInterval(usbClockTimer); usbClockTimer = null; }
    usbIdleClock = null;
    usbClockMode = "off";
    usbClockAmbient = false;
    usbClockPeriod = null;
  }

  /**
   * At the strict >300000 ms deadline, receiver mode queues one handoff and
   * silence drops pending traffic plus the link's own heartbeats.
   * Real activity ends the ambient period immediately; the
   * ordinary latest frame (receiver) or the heartbeats (silence) resume. `resume`
   * pushes the latest ordinary frame on transitions not driven by a fresh selection.
   */
  function refreshUsbClock(resume: boolean): void {
    if (usbIdleClock === null || usbClockMode === "off" || !usbDisplay) return;
    const ambient = usbIdleClock.isActive(performance.now());
    if (ambient === usbClockAmbient) return;
    usbClockAmbient = ambient;
    usbClockPeriod = null;
    if (usbPending && "clockPeriod" in usbPending) usbPending = null;
    if (ambient && usbClockMode === "receiver") {
      if (usbDisplay.supportsClockUtc) {
        usbClockPeriod = Symbol();
        usbPending = { clockPeriod: usbClockPeriod };
        pumpUsb();
      } else {
        queueUsbClockCarrier();
      }
    } else if (ambient) {
      usbPending = null;
      usbDisplay.setQuiet(true);
    } else if (usbClockMode === "silence") {
      usbDisplay.setQuiet(false);
    } else if (resume && lastFrameImage) {
      queueUsbFrame(lastFrameImage);
    }
  }

  /**
   * Legacy handoff (or definite activation rejection): send the current avatar
   * and title with the existing clock flag, replacing any pending ordinary frame.
   */
  function queueUsbClockCarrier(): void {
    if (!usbDisplay || !lastFrameImage) return;
    const composed = composeUsbImage(lastFrameImage);
    if (!composed) return;
    usbPending = { ...composed, state: "clock" };
    pumpUsb();
  }

  /** Shared LED composition for the USB link; null (with a once-per-cause warning) when it fails. */
  function composeUsbImage(image: SelectedImage): SerialImage | null {
    try {
      // LED layout parity with the HTTP composition: the group outline (white by
      // default, like every non-loopback LED destination), the effective validated
      // title (saved override or folder basename, omitted when invalid) and the
      // context-banded caption ink from the host usage this session already has.
      const folderName = typeof cwd === "string" ? basename(cwd) : null;
      const title = projectTitle ?? folderName;
      const band = contextPercent === null || contextPercent < 60
        ? "green" : contextPercent <= 80 ? "yellow" : "red";
      const composed = prepareDisplayImage(
        image.base64,
        { ...displayActivity.snapshot(), state: image.state },
        config.externalDisplay.background,
        config.externalDisplay.backgroundCoverage,
        config.externalDisplay.outline ?? "#ffffff",
        false, // Physical CDC displays always receive opaque PNGs.
        title !== null && encodeProjectName(title) !== null ? title : null,
        band === "red" ? [255, 0, 0] : band === "yellow" ? [255, 255, 0] : [0, 255, 0],
      );
      return { base64: composed.toString("base64"), state: image.state };
    } catch (error) {
      // Composition failures are never fatal, but a silent one made a broken
      // destination look like a working link: the cause is reported once.
      const message = `usb image composition failed: ${error instanceof Error ? error.message : String(error)}`;
      if (usbWarned === message) return null;
      usbWarned = message;
      usbCtx?.ui?.notify?.(`[${EXTENSION_NAME}] ${message}`, "warning");
      return null;
    }
  }

  /**
   * Queues the composed 64x64 image for the serial link. The firmware validates
   * the PNG envelope just like the HTTP path, and the raw sprite is 48x40, so the
   * composed bytes are what travels; a composition failure never blocks the
   * other outputs. While the ambient clock owns the panel, ordinary frames are
   * suppressed: receiver mode queued its one handoff and silence drops
   * traffic entirely. Selections still update the idle clock, so a non-idle
   * state ends the ambient period and resumes ordinary delivery immediately.
   */
  function queueUsbFrame(image: SelectedImage): void {
    if (!usbDisplay) return;
    if (usbIdleClock !== null && usbClockMode !== "off") {
      usbIdleClock.update(displayActivity.snapshot(), performance.now(), image.state);
      refreshUsbClock(false);
      if (usbClockAmbient) return;
    }
    const composed = composeUsbImage(image);
    if (!composed) return;
    usbPending = composed;
    pumpUsb();
  }

  /** Bounded latest-frame delivery: one send in flight, intermediate frames dropped. */
  function pumpUsb(): void {
    const link = usbDisplay;
    if (!link || usbBusy === link || !usbPending) return;
    const pending = usbPending;
    usbPending = null;
    usbBusy = link;
    const finish = () => {
      if (usbBusy !== link) return;
      usbBusy = null;
      pumpUsb();
    };

    if ("clockPeriod" in pending) {
      const isCurrent = () => usbDisplay === link && usbClockPeriod === pending.clockPeriod;
      void link.sendClock(isCurrent).then(result => {
        if (!result.ok && result.result !== undefined && isCurrent()) queueUsbClockCarrier();
      }).catch(() => {
        // A transport failure, like a timeout, may have left the clock active.
        // Never replace it with a PNG without a definitive negative reply.
      }).finally(finish);
      return;
    }

    const image = pending;
    void link.sendImage(image).then(result => {
      if (usbDisplay !== link) return;
      // A rejected frame used to be silent, which made a wrong payload look like a
      // working link. The firmware's own result code is reported once per change.
      if (result.ok) {
        usbWarned = null;
        if (!usbSentReported) {
          usbSentReported = true;
          usbCtx?.ui?.notify?.(`[${EXTENSION_NAME}] usb frame accepted (${image.base64.length} b64 chars)`, "info");
        }
        return;
      }
      if (usbWarned === result.error) return;
      usbWarned = result.error;
      usbCtx?.ui?.notify?.(`[${EXTENSION_NAME}] usb frame rejected: ${result.error}`, "warning");
    }).catch(error => {
      if (usbDisplay !== link) return;
      // A failed write used to be an unhandled rejection: the frame was lost
      // without a trace. The cause is reported once per change, like a NACK.
      const message = `usb frame send failed: ${error instanceof Error ? error.message : String(error)}`;
      if (usbWarned === message) return;
      usbWarned = message;
      usbCtx?.ui?.notify?.(`[${EXTENSION_NAME}] ${message}`, "warning");
    }).finally(finish);
  }

  /**
   * Dedicated D200 mirror, independent of configured external destinations.
   * `requestedPort` is the session-local choice from `/emote d200On <port>`: it
   * overrides the default for this session and is never persisted, so a reload
   * falls back to `GENTLE_EMOTE_D200_PORT`/8003. Naming another port while the
   * mirror is on replaces the sender instead of being silently ignored.
   */
  function setD200Display(enabled: boolean, ctx: any, requestedPort?: number): void {
    if (!ownsSharedDisplays) return;
    if (enabled) {
      if (requestedPort !== undefined) d200Port = requestedPort;
      const port = d200Port ?? resolveD200Port();
      if (d200Display?.enabled && d200LivePort === port) {
        ctx.ui?.notify?.(`[${EXTENSION_NAME}] D200 mirroring already on: ${d200Url(port)}`, "info");
        return;
      }
      d200Display?.dispose();
      d200Display = createD200Display({
        port,
        fetcher: fetch,
        report: (message) => ctx.ui?.notify?.(`[${EXTENSION_NAME}] ${message}`, "warning"),
        sessionId: sessionId(),
        projectName: typeof cwd === "string" ? basename(cwd) : "",
        // Opt-in focus: the key receiver shares the session's captured Herdr
        // controller, so a valid click ACKs like the configured local group.
        focusRequest: desktopFocusRequest(),
      });
      d200LivePort = port;
      d200Display.setFrameWarningEnabled(frameWarningsOn);
      if (projectTitle !== null) d200Display.setTitle(projectTitle);
      refreshContextUsage(ctx);
      d200Display.updateActivity(displayActivity.snapshot());
      renderer.setFrameSink?.(frameSink());
      refreshCurrentFrame();
      ctx.ui?.notify?.(`[${EXTENSION_NAME}] D200 mirroring on: ${d200Url(port)}`, "info");
      return;
    }
    d200LivePort = null;
    if (!d200Display) {
      ctx.ui?.notify?.(`[${EXTENSION_NAME}] D200 mirroring already off`, "info");
      return;
    }
    d200Display.dispose();
    d200Display = null;
    renderer.setFrameSink?.(frameSink());
    ctx.ui?.notify?.(`[${EXTENSION_NAME}] D200 mirroring off`, "info");
  }

  function loadEmoteSet(setName: string, scene = false) {
    // Explicit choices never use the legacy resolver's silent Gentleman fallback.
    // A scene avatar is always looked up like a manual selection, but it never
    // becomes the selection: currentEmoteSet and the panel keep the parent's own.
    const baseDir = manualAvatar !== null || scene ? findAvatar(setName, extDir, cwd) : findEmoteSetDir(setName, extDir, cwd);
    if (!baseDir) return;
    if (!scene) {
      currentEmoteSet = setName;
      subagentSceneSet = null;
    }
    // Automatic twins may be partial; manual twins still require usable idle content.
    // Both use the same path guards and first-existing-layer ownership.
    const safeTwin = yoloOn ? findAvatar(`${setName}-yolo`, extDir, cwd,
      manualAvatar === null ? "automatic-partial" : "manual") : null;
    const setDir = safeTwin || baseDir;
    currentEmoteSet = setName;
    const isAsciiOnly = existsSync(join(setDir, "ascii.yaml")) && !hasImageFrames(setDir);

    if (!internalVisible) {
      if (!(renderer instanceof PngSelectionRenderer)) {
        renderer.dispose();
        renderer = new PngSelectionRenderer();
        animator.setRenderer(renderer);
      }
    } else if (isAsciiOnly) {
      if (!(renderer instanceof AsciiRenderer)) {
        renderer.dispose();
        renderer = new MirroredAsciiRenderer();
        animator.setRenderer(renderer);
      }
    } else {
      const detected = createRendererFromResolved(lastResolved, config);
      if (renderer.constructor !== detected.constructor) {
        renderer.dispose();
        renderer = detected;
        animator.setRenderer(renderer);
      }
    }

    renderer.setFrameSink?.(frameSink());
    const framesDir = !internalVisible && isAsciiOnly ? join(extDir, "emotes", "gentleman") : setDir;
    renderer.loadFrames(framesDir, extDir, createAccentTransform(accent));
    animator.setEmotesConfig(loadEmotesConfig(framesDir));
  }

  /** Re-show the current state after frames were reloaded. */
  function refreshCurrentFrame() {
    animator.resetRenderCache();
    if (!widgetActive) return;
    if (animator.currentState === "idle") animator.enterIdle();
    else animator.transitionTo(animator.currentState);
  }

  function switchEmoteSet(modelId: string, thinkingLevel: string) {
    const setName = manualAvatar ?? resolveEmoteSet(modelId, thinkingLevel, config.emotes);
    if (setName === currentEmoteSet) return;
    loadEmoteSet(setName);
    log(`switchEmoteSet: loaded "${setName}", state="${animator.currentState}"`);
    refreshCurrentFrame();
  }

  function onBannerChange() {
    const next = resolveAccent(config.accent);
    if (sameRgb(next, accent)) return;
    accent = next;
    log(`accent: changed to rgb(${next.join(",")})`);
    loadEmoteSet(currentEmoteSet);
    refreshCurrentFrame();
    applySubagentScene();
  }

  function watchBanner() {
    unwatchBanner();
    if (config.accent !== "auto") return;
    watchedBannerFiles = bannerConfigCandidates();
    for (const file of watchedBannerFiles) {
      watchFile(file, { interval: BANNER_POLL_MS, persistent: false }, onBannerChange);
    }
  }

  function unwatchBanner() {
    for (const file of watchedBannerFiles) unwatchFile(file, onBannerChange);
    watchedBannerFiles = [];
  }

  /** Once another event owns the avatar, startup must not greet later. */
  function cancelGreeting() {
    if (greetTimer) { clearTimeout(greetTimer); greetTimer = null; }
  }

  function startFarewell() {
    cancelGreeting();
    farewell = true;
    if (farewellTimer) { clearTimeout(farewellTimer); farewellTimer = null; }
    if (animator.currentState !== "bye") animator.transitionTo("bye");
  }

  function endFarewellLater() {
    if (farewellTimer) clearTimeout(farewellTimer);
    farewellTimer = setTimeout(() => {
      farewellTimer = null;
      farewell = false;
      if (animator.currentState === "bye") animator.transitionTo("idle");
    }, config.holdDuration.bye);
  }

  // --- YOLO mode (Gentle Shell only): read and observe, never toggle ---

  interface YoloReader {
    read(): Promise<unknown>;
    readMode?: () => Promise<unknown>;
    readSnapshot?: () => Promise<unknown>;
    observe(refresh: () => void): () => void;
    dispose?(): void;
  }
  let yoloReader: YoloReader | null = null;
  let stopYoloObserve: (() => void) | null = null;

  async function refreshYolo() {
    const reader = yoloReader;
    if (!reader) return;
    try {
      const variant = await readYoloRest(reader);
      if (reader !== yoloReader || !widgetActive) return;
      const on = variant !== null;
      if (on === yoloOn && variant === yoloVariant) return;
      yoloOn = on;
      yoloVariant = variant;
      log(`yolo: ${variant ?? "off"}`);
      animator.setIdleVariant(variant);
      loadEmoteSet(currentEmoteSet);
      refreshCurrentFrame();
      applySubagentScene();
    } catch { /* display only */ }
  }

  function watchYolo(ctx: unknown) {
    const bus = (pi as { events?: { emit?: (channel: string, payload: unknown) => void } }).events;
    if (typeof bus?.emit !== "function") return;
    let settled = false;
    const timer = setTimeout(() => { settled = true; }, YOLO_DISCOVERY_MS);
    timer.unref?.();
    const respond = (value: unknown) => {
      const reader = value as Partial<YoloReader> | null;
      if (!reader || typeof reader.read !== "function" || typeof reader.observe !== "function") return;
      if (settled || !widgetActive) { reader.dispose?.(); return; }
      settled = true;
      clearTimeout(timer);
      yoloReader = reader as YoloReader;
      stopYoloObserve = yoloReader.observe(() => { void refreshYolo(); });
      void refreshYolo();
    };
    try {
      bus.emit(YOLO_HOST_CHANNEL, { context: ctx, respond });
    } catch {
      clearTimeout(timer);
    }
  }

  function unwatchYolo() {
    stopYoloObserve?.();
    stopYoloObserve = null;
    yoloReader?.dispose?.();
    yoloReader = null;
    yoloOn = false;
    yoloVariant = null;
    animator.setIdleVariant(null);
  }

  /** This session's id, when the host exposes it; the bus contract is session-scoped. */
  function sessionId(): string | null {
    try {
      const id = (ctxRef as { sessionManager?: { getSessionId?: () => unknown } } | null | undefined)?.sessionManager?.getSessionId?.();
      return typeof id === "string" && id !== "" ? id : null;
    } catch { return null; }
  }

  let ctxRef: unknown = null;

  /** Subscribe to the host's ODD phase bus and recover its current state; missing bus tolerated. */
  function attachWorkPhase(): void {
    workPhase.attach((pi as { events?: unknown }).events, sessionId());
  }

  /** Subscribe to the host's native subagent task lifecycle for this session. */
  function attachSubagentTasks(): void {
    subagentTasks.attach((pi as { events?: unknown }).events, sessionId());
  }

  /** Activity transitions are suppressed while the goodbye animation owns the avatar. */
  function show(state: EmoteState) {
    if (!widgetActive || farewell) return;
    cancelGreeting();
    if (animator.currentState !== state) animator.transitionTo(state);
  }

  /**
   * Adopt the phase named by a successful gentle_odd_phase call. Anything but a
   * valid phase or "clear" is a no-op; failures and start events never adopt.
   */
  function adoptDirectPhase(args: unknown, isError: boolean | undefined): void {
    if (isError) return;
    const phase = (args as { phase?: unknown } | null | undefined)?.phase;
    if (phase === "clear") {
      if (directWorkPhase === null) return;
      directWorkPhase = null;
      applyWorkPhase();
      return;
    }
    if (!isWorkPhase(phase) || directWorkPhase === phase) return;
    directWorkPhase = phase;
    applyWorkPhase();
  }

  function installWidget(ctx: any) {
    ctx.ui.setWidget(WIDGET_KEY, createWidgetFactory({
      animator,
      config,
      getCurrentEmoteSet: () => currentEmoteSet,
      setFrameColor: (color) => {
        if (renderer instanceof KittyUnicodeRenderer) renderer.setFrameColor(color);
      },
    }), { placement: "aboveEditor" });
  }

  // --- /emote previews and local visibility (no model involved) ---

  function clearPreview() {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  }

  function previewState(state: EmoteState) {
    cancelGreeting();
    clearPreview();
    if (farewellTimer) { clearTimeout(farewellTimer); farewellTimer = null; }
    farewell = false;
    if (state === "bye") {
      startFarewell();
      endFarewellLater();
      return;
    }
    animator.transitionTo(state);
    if (state === "talk") animator.onTalkToken(PREVIEW_TALK_TEXT);
    if (!PREVIEW_LOOPING_STATES.has(state)) return;
    previewTimer = setTimeout(() => {
      previewTimer = null;
      if (animator.currentState === state) animator.transitionTo("idle");
    }, PREVIEW_MS);
  }

  function playDemo(step = 0) {
    const state = DEMO_SEQUENCE[step];
    if (!state || !widgetActive) return;
    previewState(state);
    demoTimer = setTimeout(() => {
      demoTimer = null;
      playDemo(step + 1);
    }, DEMO_STEP_MS);
  }

  /** Read-only /emote status diagnostic: never mutates animator, phases or outputs. */
  function showEmoteStatus(ctx: any): void {
    const png = lastSelected;
    const activity = displayActivity.snapshot();
    const native = workPhase.current();
    const phase = native ?? directWorkPhase;
    const source = native ? "native" : directWorkPhase ? "direct" : "none";
    const pngPart = png
      ? `state=${png.state} frame=${png.frame} set=${png.set}`
      : "none selected yet";
    // Idle-clock truth lives in each destination sender, never in the renderer.
    // Only non-off modes appear, positions stay anonymous and no destination,
    // path or credential is exposed: this is the same safe-fields contract.
    const clockDeadline = (remaining: number | null): string => {
      if (remaining === null) return "not-settled";
      if (remaining > 0) return `remaining=${Math.ceil(remaining / 1000)}s`;
      return "active";
    };
    const clockSegment = (clock: IdleClockStatus): string =>
      `mode=${clock.mode} session=${clock.session ? "yes" : "no"} ${clockDeadline(clock.remaining)} carrier=${clock.carrier ? "yes" : "no"}`;
    const d200Clock = d200Display?.idleClockState() ?? null;
    const clocks = [...(externalDisplay?.idleClockStates() ?? []), ...(d200Clock ? [d200Clock] : [])];
    // Always report the clock truth: an absent segment would be ambiguous between
    // an older extension, a session without destinations and modes that are off.
    const clockPart = clocks.length > 0
      ? `; idleClock ${clocks.map((clock, index) => `#${index + 1} ${clockSegment(clock)}`).join(" | ")}`
      : externalDisplay?.enabled ? "; idleClock off" : "; idleClock no destination";
    ctx.ui?.notify?.(
      `[${EXTENSION_NAME}] status: PNG ${pngPart}; phase ${phase ?? "none"} (source: ${source}); activity status=${activity.status} phase=${activity.phase} activeSubagents=${activity.activeSubagents}${clockPart}`,
      "info",
    );
  }

  /** Panel snapshot: preferences, capabilities and live status, never a destination. */
  function buildPanelSnapshot(): PanelSnapshot {
    const stored = outputState.load(() => {});
    const counts = externalDisplay?.destinationCounts() ?? { local: 0, lan: 0 };
    const d200Live = d200Display?.enabled === true;
    const clocks: PanelClockRow[] = [];
    // Every valid destination is listed, off included, so the panel can switch it;
    // the indices stay aligned with ExternalDisplays.clockRows()/setClockMode().
    for (const row of externalDisplay?.clockRows() ?? []) {
      clocks.push({ ...row, actionable: true });
    }
    const d200Clock = d200Display?.idleClockState() ?? null;
    if (d200Clock) clocks.push({ label: "d200", mode: d200Clock.mode, session: d200Clock.session, remaining: d200Clock.remaining, carrier: d200Clock.carrier });
    const native = workPhase.current();
    const phase = native ?? directWorkPhase;
    return {
      enabled: config.enabled,
      ownsDisplays: ownsSharedDisplays,
      outputs: [
        { output: "internal", enabled: stored.internal, destinations: 0 },
        { output: "local", enabled: stored.debug, destinations: counts.local },
        { output: "d200", enabled: d200Live, destinations: d200Live ? 1 : 0, detail: `port ${d200LivePort ?? resolveD200Port()}` },
        { output: "display", enabled: stored.display, destinations: counts.lan },
        { output: "usb", enabled: usbDisplay !== null, destinations: usbDisplay ? 1 : 0, ...(usbPort ? { detail: usbPort } : {}) },
      ],
      clocks,
      appearance: {
        avatar: currentEmoteSet,
        avatarManual: manualAvatar !== null,
        title: projectTitle,
        folder: typeof cwd === "string" ? basename(cwd) : "-",
        size: config.size,
        placement: config.placement,
        frame: config.frame,
        accent: config.accent,
      },
      status: {
        ...displayActivity.snapshot(),
        workPhase: phase,
        workPhaseSource: native ? "native" : directWorkPhase ? "direct" : "none",
        png: lastSelected,
      },
    };
  }

  /** Apply one persisted appearance key live, right after its guarded write. */
  function applyAppearance(key: PanelAppearanceKey, value: string | number | boolean, ctx: any): void {
    if (key === "size") {
      config.size = value as number;
      animator.updateConfig(config);
      refreshCurrentFrame();
      applySubagentScene();
      return;
    }
    if (key === "placement") {
      config.placement = value as Config["placement"];
      installWidget(ctx);
      refreshCurrentFrame();
      applySubagentScene();
      return;
    }
    if (key === "frame") {
      config.frame = value as boolean;
      refreshCurrentFrame();
      applySubagentScene();
      return;
    }
    // A new accent re-tints the frames themselves, so the set is reloaded from disk.
    config.accent = value as Config["accent"];
    accent = resolveAccent(config.accent);
    loadEmoteSet(currentEmoteSet);
    refreshCurrentFrame();
    applySubagentScene();
  }

  /** Apply one panel item through the command entry point, so behavior never forks. */
  async function applyPanelItem(item: PanelItem, ctx: any): Promise<void> {
    if (item.kind === "clock") {
      // Session-local: applied live, written nowhere, gone after a reload.
      externalDisplay?.setClockMode(item.index, cycleClockMode(item.mode));
      return;
    }
    if (item.kind === "output") {
      await emoteHandler(`${item.output}${item.enabled ? "Off" : "On"}`, ctx);
      return;
    }
    if (item.kind === "appearance") {
      // Persisted for every avatar from now on, applied live right here; a failed
      // write leaves both the file and the running appearance untouched.
      const next = nextAppearanceValue(item.key, item.value);
      const written = writePanelConfig(agentDir(), item.key, next);
      if (!written.ok) {
        ctx?.ui?.notify?.(`[${EXTENSION_NAME}] ${written.error ?? "cannot write configuration"}; appearance unchanged`, "warning");
        return;
      }
      applyAppearance(item.key, next, ctx);
      return;
    }
    if (item.kind !== "action") return;
    if (item.action === "demo" || item.action === "status") {
      await emoteHandler(item.action, ctx);
      return;
    }
    const names = avatarNames(extDir, cwd);
    if (names.length === 0) return;
    const current = manualAvatar ?? currentEmoteSet;
    const index = names.indexOf(current);
    await emoteHandler(`avatar ${names[(index + 1) % names.length]!}`, ctx);
  }

  /**
   * Interactive control panel: one entry point for every switch, rebuilt from the
   * extension's live truth on each render. It owns no state beyond its cursor, and
   * a failure never reaches the avatar, delivery or the prompt.
   */
  async function showPanel(ctx: any): Promise<void> {
    const custom = ctx?.ui?.custom;
    if (typeof custom !== "function" || (ctx?.mode !== undefined && ctx.mode !== "tui")) {
      ctx?.ui?.notify?.(`[${EXTENSION_NAME}] the control panel needs the interactive TUI`, "info");
      return;
    }
    const ESC = String.fromCharCode(27);
    const up = `${ESC}[A`, down = `${ESC}[B`;
    const enter = String.fromCharCode(13);
    let cursor = 0;
    let applying = false;
    try {
      await custom((tui: any, _theme: any, keybindings: any, done: (value: null) => void) => {
        const model = () => buildPanelModel(buildPanelSnapshot());
        const positions = (): number[] => model().reduce<number[]>((acc, row, index) => (row.item ? [...acc, index] : acc), []);
        const move = (delta: number): void => {
          const reachable = positions();
          if (reachable.length === 0) return;
          const current = reachable.indexOf(cursor);
          cursor = reachable[(current < 0 ? 0 : current + delta + reachable.length) % reachable.length]!;
          tui?.requestRender?.();
        };
        const activate = (): void => {
          const item = model()[cursor]?.item;
          if (!item || applying) return;
          applying = true;
          void applyPanelItem(item, ctx).finally(() => {
            applying = false;
            tui?.requestRender?.();
          });
        };
        // The status section must tick while the panel is open; unref keeps the
        // process free to exit and dispose clears it with the overlay.
        const ticker = setInterval(() => tui?.requestRender?.(), 1000);
        ticker.unref?.();
        return {
          render(width: number): string[] {
            const rows = model();
            const reachable = positions();
            if (reachable.length > 0 && !reachable.includes(cursor)) cursor = reachable[0]!;
            const lines = rows.map((row, index) => {
              const marker = row.item ? (index === cursor ? ">" : " ") : " ";
              return `${marker}${row.text}`;
            });
            lines.push(" Esc/q close  ↑↓ or j/k move  Enter apply");
            return framePanelLines(lines, width);
          },
          handleInput(data: string): void {
            if (keybindings?.matches?.(data, "tui.select.cancel") || data === "q" || data === "Q") { done(null); return; }
            if (data === up || data === "k" || keybindings?.matches?.(data, "tui.select.up")) { move(-1); return; }
            if (data === down || data === "j" || keybindings?.matches?.(data, "tui.select.down")) { move(1); return; }
            if (data === enter || data === " " || keybindings?.matches?.(data, "tui.select.confirm")) activate();
          },
          invalidate() {},
          dispose() {
            clearInterval(ticker);
          },
        };
      }, { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } });
    } catch { /* a panel failure never reaches the avatar or delivery */ }
  }

  /**
   * One entry point for the command line and for the panel, so a toggle from
   * either side persists, applies and fails exactly the same way.
   */
  async function emoteHandler(args: string, ctx: any): Promise<void> {
      const name = args.trim();
      if (!widgetActive) {
        ctx.ui?.notify?.(`[${EXTENSION_NAME}] avatar inactive (no UI or disabled)`, "warning");
        return;
      }
      // Bare `/emote` opens the panel; every explicit argument keeps its behavior.
      if (name === "" || name === "panel") {
        await showPanel(ctx);
        return;
      }
      if (name === "avatar" || name.startsWith("avatar ")) {
        const choice = name.slice("avatar".length).trim();
        if (!choice) {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] avatar: ${manualAvatar ?? "auto"}; /emote avatar <folder> | auto`, "info");
          return;
        }
        const next = choice === "auto" ? null : choice;
        if (next !== null && !findAvatar(next, extDir, cwd)) {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] invalid or unavailable avatar; avatar unchanged`, "warning");
          return;
        }
        try { avatarState.save(next); }
        catch {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] cannot save global avatar; avatar unchanged`, "error");
          return;
        }
        manualAvatar = next;
        loadEmoteSet(next ?? resolveEmoteSet(latestModel, latestThinking, config.emotes));
        refreshCurrentFrame();
        applySubagentScene();
        ctx.ui?.notify?.(`[${EXTENSION_NAME}] avatar: ${next ?? "auto"}`, "info");
        return;
      }
      // `/emote displayOn <address>` names a board directly. Writing the global
      // config is this command's documented exception to "output commands never
      // touch config.json", because the address must survive /reload.
      if (name.startsWith("displayOn ")) {
        const parsed = parseDisplayAddress(name.slice("displayOn".length).trim());
        if (parsed.error !== null) {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] ${parsed.error}; LED destinations unchanged`, "warning");
          return;
        }
        // The address configures the LED group, so the group must already be
        // enabled: a disabled output is never turned on by naming a board.
        if (!externalDisplay?.enabled) {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] no enabled LED/ESP32 display configured; address not applied`, "warning");
          return;
        }
        const saved = persistGlobalDisplayTarget(parsed.url as string);
        if (!saved.ok) {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] ${saved.error}; LED destinations unchanged`, "error");
          return;
        }
        try { outputState.save("display", true); }
        catch {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] cannot save global display state; output unchanged`, "error");
          return;
        }
        // Reload the layers so the persisted address is what the new sender uses,
        // then rebuild it: destinations are immutable per session.
        ({ config } = loadLayeredConfig(extDir, cwd));
        subagentAvatarWarned = false;
        const report = (message: string) => ctx.ui?.notify?.(`[${EXTENSION_NAME}] ${message}`, "warning");
        externalDisplay?.dispose();
        // The named board must win even when a project layer still configures the
        // previous one: persistence records the choice, this override executes it.
        externalDisplay = ownsSharedDisplays
          ? new ExternalDisplays(withDisplayTarget(config.externalDisplay, parsed.url as string), fetch, report, sessionId(), typeof cwd === "string" ? basename(cwd) : "", desktopFocusRequest())
          : null;
        const savedStates = outputState.load(report);
        externalDisplay?.setDebugEnabled(savedStates.debug);
        externalDisplay?.setDisplayEnabled(savedStates.display);
        // A rebuilt sender inherits the live session diagnostic, like every other one.
        externalDisplay?.setFrameWarningEnabled(frameWarningsOn);
        renderer.setFrameSink?.(frameSink());
        // A fresh sender retains no frame, so the reservation comes first and the
        // current selection is pushed through the existing animation pipeline.
        externalDisplay?.claimDisplays();
        refreshCurrentFrame();
        applySubagentScene();
        const kept = saved.loopbackPreserved > 0 ? `; ${saved.loopbackPreserved} loopback target preserved` : "";
        ctx.ui?.notify?.(`[${EXTENSION_NAME}] LED/ESP32 display: ${parsed.url}${kept}`, "info");
        return;
      }
      // `/emote d200On <port>` picks the key receiver port. The whole D200 output is
      // session-local: neither the enabled state nor the port is written anywhere, so
      // every fresh session (and /reload) starts off.
      if (name.startsWith("d200On ")) {
        const parsed = parseD200Port(name.slice("d200On".length).trim());
        if (parsed.port === null) {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] ${parsed.error}; D200 mirror unchanged`, "warning");
          return;
        }
        setD200Display(true, ctx, parsed.port);
        return;
      }
      // `/emote usbOn [port]` is success-gated: a failed open never saves On.
      if (name === "usbOn" || name.startsWith("usbOn ")) {
        const requested = name.slice("usbOn".length).trim();
        if (requested !== "") {
          const invalid = parseSerialPortPath(requested);
          if (invalid !== null) {
            ctx.ui?.notify?.(`[${EXTENSION_NAME}] ${invalid}; usb serial display unchanged`, "warning");
            return;
          }
        }
        const started = await setUsbDisplay(true, ctx, requested === "" ? undefined : requested, requested === "");
        if (started) {
          try { outputState.save("usb", true); }
          catch { ctx.ui?.notify?.(`[${EXTENSION_NAME}] cannot save global usb state; output unchanged`, "error"); }
        }
        return;
      }
      if (name === "usbOff") {
        try { outputState.save("usb", false); }
        catch { ctx.ui?.notify?.(`[${EXTENSION_NAME}] cannot save global usb state; output unchanged`, "error"); return; }
        await setUsbDisplay(false, ctx);
        return;
      }
      // The d200 commands are handled below and never persist: the D200 output is
      // fully session-local (state and port).
      const output = OUTPUTS.find(output => name === `${outputCommandName(output)}On` || name === `${outputCommandName(output)}Off`);
      if (output && output !== "d200") {
        try { outputState.save(output, name === `${outputCommandName(output)}On`); }
        catch {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] cannot save global ${outputCommandName(output)} state; output unchanged`, "error");
          return;
        }
      }
      if (name === "displayOn" || name === "displayOff") {
        // Explicit commands claim and release the LED session reservation; the
        // startup restore path below keeps using setDisplayEnabled and never claims.
        const count = name === "displayOn"
          ? externalDisplay?.claimDisplays() ?? 0
          : externalDisplay?.releaseDisplays() ?? 0;
        if (!count) ctx.ui?.notify?.(`[${EXTENSION_NAME}] no enabled LED/ESP32 display configured; preference saved`, "info");
        return;
      }
      if (name === "d200On" || name === "d200Off") {
        setD200Display(name === "d200On", ctx);
        return;
      }
      if (name === "debugOn" || name === "debugOff") {
        // Diagnostic-only commands for this session's visibility of the routine
        // unsupported-frame report. Session-local like the D200 mirror: a new
        // session or /reload always starts off, and no output is enabled or
        // disabled, no preference is written and no frame is sent by these.
        frameWarningsOn = name === "debugOn";
        applyFrameWarnings();
        ctx.ui?.notify?.(`[${EXTENSION_NAME}] unsupported-frame warnings ${frameWarningsOn ? "on" : "off"} (session-local)`, "info");
        return;
      }
      if (name === "localOn" || name === "localOff") {
        const count = externalDisplay?.setDebugEnabled(name === "localOn") ?? 0;
        if (!count) ctx.ui?.notify?.(`[${EXTENSION_NAME}] no enabled localhost display configured`, "info");
        return;
      }
      if (name === "internalOn" || name === "internalOff") {
        const visible = name === "internalOn";
        if (visible === internalVisible) return;
        internalVisible = visible;
        loadEmoteSet(currentEmoteSet);
        installWidget(ctx);
        refreshCurrentFrame();
        applySubagentScene();
        return;
      }
      if (name === "status") {
        showEmoteStatus(ctx);
        return;
      }
      if (name === "title" || name.startsWith("title ")) {
        // Bare `/emote title` resets to the project folder basename; any other
        // text is trimmed and validated with the sender's project-name rules.
        const text = name.slice("title".length).trim();
        const next = text === "" ? null : normalizeTitle(text);
        // An empty argument restores the folder name (null); only a present but
        // unparseable one is rejected. Narrowing here keeps both cases explicit.
        if (next === undefined) {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] invalid title; the display title is unchanged`, "warning");
          return;
        }
        try { new TitleStore(cwd).save(next); }
        catch {
          ctx.ui?.notify?.(`[${EXTENSION_NAME}] cannot save project title; title unchanged`, "error");
          return;
        }
        projectTitle = next;
        externalDisplay?.setTitle(next);
        d200Display?.setTitle(next);
        // The USB output composes its own PNG: requeue the current frame so the
        // caption changes immediately, including the reset to the folder name.
        if (lastFrameImage) queueUsbFrame(lastFrameImage);
        ctx.ui?.notify?.(`[${EXTENSION_NAME}] display title ${next === null ? "restored to the project folder name" : `set to "${next}"`}`, "info");
        return;
      }
      if (name === "demo") {
        playDemo();
        return;
      }
      if ((EMOTE_STATES as readonly string[]).includes(name)) {
        previewState(name as EmoteState);
        return;
      }
      ctx.ui?.notify?.(`[${EXTENSION_NAME}] /emote <state>: ${[...EMOTE_STATES, "demo", "status", "panel", "avatar", "title", "debugOn", "debugOff", ...OUTPUTS.flatMap(output => [`${outputCommandName(output)}On`, `${outputCommandName(output)}Off`])].join(", ")}`, "info");
  }

  pi.registerCommand?.("emote", {
    description: "Gentle-emote: /emote <state> | demo | status | avatar <folder> | avatar auto | title <text> | internalOn | internalOff | localOn | localOff | debugOn | debugOff | d200On [port] | d200Off | usbOn [port] | usbOff | displayOn [address] | displayOff (global, persistent; displayOn claims the LED display for this session, displayOn <address> persists that board as the LED destination, d200On/d200Off and d200On <port> are session-local — mirror state and port never persist and a new session starts off —, usbOn with several visible ports offers a picker in the interactive TUI, displayOff releases it; debugOn/debugOff are session-local diagnostics that only show or hide the routine unsupported-frame warning, default off, persisting nothing and never enabling an output)",
    getArgumentCompletions: (prefix: string) => {
      const choices = prefix.trimStart().startsWith("avatar ")
        ? ["avatar auto", ...avatarNames(extDir, cwd).map(name => `avatar ${name}`)]
        : [...EMOTE_STATES, "demo", "status", "panel", "avatar", "title", "debugOn", "debugOff", ...OUTPUTS.flatMap(output => [`${outputCommandName(output)}On`, `${outputCommandName(output)}Off`])];
      return choices.filter(name => name.startsWith(prefix.trim()))
        .map(name => ({ value: name, label: name, description: name.startsWith("avatar ") ? EMOTE_DESCRIPTIONS.avatar : EMOTE_DESCRIPTIONS[name] }));
    },
    handler: emoteHandler,
  });

  loadEmoteSet(currentEmoteSet);

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    log(`session_start: hasUI=${ctx.hasUI}`);
    // Invalidate queued focus even when the next session has no UI or disables
    // this extension. A same-session board rebuild does not recreate it.
    herdrFocus?.dispose();
    herdrFocus = null;
    if (!ctx.hasUI) return;
    // Bind identity before constructing this session's immutable delivery streams.
    ctxRef = ctx;

    cancelGreeting();
    animator.clearAllTimers();
    cwd = ctx.cwd;
    ({ config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd));
    setDebug(config.debug);
    animator.updateConfig(config);
    if (!config.enabled) return;

    herdrFocus = createHerdrFocusController({ env: process.env, log });
    const report = (message: string) => ctx.ui.notify(`[${EXTENSION_NAME}] ${message}`, "warning");
    uiNotify = (message, level = "warning") => ctx.ui.notify(`[${EXTENSION_NAME}] ${message}`, level);
    // The saved per-project override wins over the folder basename; a malformed
    // file warns and falls back to the folder name, preserving the file.
    projectTitle = typeof cwd === "string" ? new TitleStore(cwd).load(report) : null;
    // Metadata only: the project folder's basename, never the full path. The
    // saved title override (if any) is layered on top of every destination.
    const projectName = typeof cwd === "string" ? basename(cwd) : "";
    const states = outputState.load(report);
    internalVisible = states.internal;
    externalDisplay?.dispose();
    // Never create shared-display senders in a child, even with saved On states.
    // Animation and output commands cannot bypass this ownership restriction.
    externalDisplay = ownsSharedDisplays ? new ExternalDisplays(config.externalDisplay, fetch, report, sessionId(), projectName, desktopFocusRequest()) : null;
    externalDisplay?.setDebugEnabled(states.debug);
    externalDisplay?.setDisplayEnabled(states.display);
    d200Display?.dispose();
    d200Display = null;
    // The D200 output is fully session-local: a fresh session (or /reload) starts
    // off even when an older version saved a d200.json preference. That legacy
    // file is ignored — never read, never warned about and never rewritten — and
    // the session port choice resets here too.
    d200Port = null;
    d200LivePort = null;
    // The diagnostic warning toggle is also session-local: every session start
    // (and /reload) resets it, so freshly constructed senders stay silent.
    frameWarningsOn = false;
    usbDisplay = null;
    usbPort = null;
    stopUsbClock();
    if (ownsSharedDisplays && states.usb) void setUsbDisplay(true, ctx);
    applyProjectTitle();
    refreshContextUsage(ctx);
    displayActivity.reset();
    directWorkPhase = null;
    pendingDirectPhases.clear();
    knownSubagentCount = 0;
    sceneSuppressed = false;
    subagentSceneOn = false;
    subagentSceneSet = null;
    subagentAvatarWarned = false;
    attachWorkPhase();
    attachSubagentTasks();
    lastResolved = resolveRenderer(config.terminals, userConfiguredTerminals);
    renderer.dispose();
    renderer = internalVisible ? createRendererFromResolved(lastResolved, config) : new PngSelectionRenderer();
    animator.setRenderer(renderer);
    accent = resolveAccent(config.accent);

    if (lastResolved.warning) {
      ctx.ui.notify(lastResolved.warning, lastResolved.warningLevel);
    } else if (renderer instanceof AsciiRenderer) {
      ctx.ui.notify(`[${EXTENSION_NAME}] No image protocol detected \u2014 using ASCII emotes.`, "warning");
    }

    latestModel = ctx.model?.id ?? "";
    latestThinking = pi.getThinkingLevel();
    manualAvatar = avatarState.load(report);
    if (manualAvatar !== null && !findAvatar(manualAvatar, extDir, cwd)) {
      report("saved avatar unavailable; using automatic selection");
      manualAvatar = null;
    }
    const setName = manualAvatar ?? resolveEmoteSet(latestModel, latestThinking, config.emotes);
    log(`session_start: set="${setName}" dir="${findEmoteSetDir(setName, extDir, cwd)}"`);
    unwatchYolo();
    loadEmoteSet(setName);
    watchBanner();

    installWidget(ctx);

    stopTerminalInput?.();
    stopTerminalInput = ctx.ui.onTerminalInput?.(() => {
      if (animator.currentState === "grandma") animator.wave();
      else animator.touch();
      return undefined;
    }) ?? null;

    widgetActive = true;
    watchYolo(ctx);
    cancelGreeting();
    greetTimer = setTimeout(() => {
      greetTimer = null;
      if (widgetActive && animator.currentState === "idle") animator.transitionTo("hi");
    }, 500);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    herdrFocus?.dispose();
    herdrFocus = null;
    cancelGreeting();
    clearPreview();
    unwatchYolo();
    animator.stop();
    animator.disposeRenderer();
    // The host shutdown hook does not prove a permanent session close (reloads
    // also dispose extensions). Stop heartbeats and let the receiver lease expire.
    externalDisplay?.dispose();
    externalDisplay = null;
    d200Display?.dispose();
    d200Display = null;
    void usbDisplay?.stop();
    usbDisplay = null;
    usbPending = null;
    stopUsbClock();
    unwatchBanner();
    stopTerminalInput?.();
    stopTerminalInput = null;
    stopBlocked?.();
    if (farewellTimer) { clearTimeout(farewellTimer); farewellTimer = null; }
    if (widgetActive && ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      widgetActive = false;
    }
    animator.setTui(null);
    workPhase.dispose();
    subagentTasks.dispose();
    directWorkPhase = null;
    pendingDirectPhases.clear();
    knownSubagentCount = 0;
    sceneSuppressed = false;
    subagentSceneOn = false;
    subagentSceneSet = null;
    uiNotify = null;
  });

  pi.on("model_select", async (event, ctx) => {
    if (!widgetActive) return;
    refreshContextUsage(ctx);
    latestModel = event.model?.id ?? "";
    latestThinking = pi.getThinkingLevel();
    switchEmoteSet(latestModel, latestThinking);
  });

  pi.on("thinking_level_select", async (event) => {
    if (!widgetActive) return;
    latestThinking = event.level;
    switchEmoteSet(latestModel, latestThinking);
  });

  pi.on("input", async (event) => {
    if (!widgetActive) return;
    let farewellPattern: RegExp | null = null;
    try {
      farewellPattern = new RegExp(config.farewellPattern, "i");
    } catch {
      log(`input: invalid farewellPattern "${config.farewellPattern}"`);
    }
    if (farewellPattern?.test(event.text ?? "")) startFarewell();
  });

  pi.on("agent_start", async (_event, ctx) => {
    refreshContextUsage(ctx);
    // The turn is about to own the avatar; the child scene must not flash while
    // the turn interrupts it and the finale is still being chosen.
    sceneSuppressed = true;
    cancelGreeting();
    // The tracker reset drops any stale detail from the previous turn; the
    // handshake recovers the host's current phase (order-safe: a host event
    // that arrives first is re-requested, and a host clear before this reset
    // leaves the same cleared state).
    directWorkPhase = null;
    pendingDirectPhases.clear();
    displayActivity.reset();
    animator.setWorkPhase(null);
    attachWorkPhase();
    attachSubagentTasks();
    displayActivity.set("busy", "thinking");
    clearPreview();
    runHadError = false;
    runUsedTools = false;
    animator.setAfterTalkState("idle");
  });

  pi.on("message_update", async (event, ctx) => {
    if (!widgetActive) return;
    refreshContextUsage(ctx);
    if (farewell) return;
    if (event.message?.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (!streamEvent) return;

    if (streamEvent.type === "thinking_start" || streamEvent.type === "thinking_delta") {
      displayActivity.set("busy", "thinking");
      show("think");
      return;
    }

    if (streamEvent.type === "toolcall_start") {
      const block = streamEvent.partial?.content?.[streamEvent.contentIndex];
      const name = block && "name" in block && block.name ? String(block.name) : "";
      if (FAREWELL_TOOLS.has(name)) startFarewell();
      else show(name ? toolNameToState(name) : "tool");
      return;
    }

    if (streamEvent.type !== "text_delta" || !streamEvent.delta) return;
    displayActivity.set("busy", "responding");
    show("talk");
    animator.onTalkToken(streamEvent.delta);
  });

  pi.on("tool_execution_start", async (event) => {
    if (!widgetActive) return;
    if (event.toolName === PHASE_TOOL) {
      pendingDirectPhases.delete(event.toolCallId);
      const phase = (event.args as { phase?: unknown } | null | undefined)?.phase;
      if (phase === "clear" || isWorkPhase(phase)) pendingDirectPhases.set(event.toolCallId, phase);
    }
    displayActivity.toolStart(event.toolName, event.toolCallId);
    runUsedTools = true;
    if (FAREWELL_TOOLS.has(event.toolName)) startFarewell();
    else show(toolNameToState(event.toolName, event.args));
  });

  pi.on("tool_execution_end", async (event) => {
    if (!widgetActive) return;
    // A successful explicit phase call is adopted before the post-tool scene so
    // the outgoing frame and headers already wear the named phase.
    // Prefer the captured start phase. Optional end args retain compatibility
    // with older hosts; ordinary tools keep their existing end-argument path.
    const args = (event as { args?: unknown }).args;
    if (event.toolName === PHASE_TOOL) {
      const phase = pendingDirectPhases.get(event.toolCallId);
      pendingDirectPhases.delete(event.toolCallId); // Consume failures too; never replay a captured call.
      adoptDirectPhase(phase === undefined ? args : { phase }, event.isError);
    }
    displayActivity.toolEnd(event.toolCallId, event.isError);
    if (farewell) return;
    if (event.isError) {
      cancelGreeting();
      runHadError = true;
      animator.setHoldNextState("think");
      const scene = toolNameToState(event.toolName, args);
      if (scene !== "verify" || !animator.showFailureFrame("verify", "fail.png")) animator.transitionTo("failure");
    } else if (!ASK_TOOLS.has(event.toolName) && !STICKY_TOOL_STATES.has(toolNameToState(event.toolName))) {
      show("read");
    }
  });

  pi.on("ui_prompt_start", async () => {
    if (!widgetActive) return;
    cancelGreeting();
    displayActivity.set("busy", "waiting");
    animator.beginPrompt();
  });

  pi.on("ui_prompt_end", async () => {
    if (!widgetActive) return;
    displayActivity.set("busy", "executing");
    animator.endPrompt();
  });

  const stopBlocked = pi.events?.on?.(HERDR_BLOCKED, (data: unknown) => {
    if (!widgetActive) return;
    const active = !!data && typeof data === "object" && (data as { active?: unknown }).active === true;
    displayActivity.set("busy", active ? "waiting" : "executing");
    if (active) {
      cancelGreeting();
      animator.beginPrompt();
    } else animator.endPrompt();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!widgetActive) return;
    refreshContextUsage(ctx);
    directWorkPhase = null;
    pendingDirectPhases.clear();
    sceneSuppressed = true;
    displayActivity.reset();
    if (runHadError) displayActivity.set("error", "idle");
    if (farewell) {
      sceneSuppressed = false;
      endFarewellLater();
      return;
    }
    const finale: EmoteState = runUsedTools && !runHadError ? "success" : "idle";
    if (animator.currentState === "talk") {
      animator.setAfterTalkState(finale);
      animator.endTalk();
    } else if (animator.currentState !== "idle" && animator.currentState !== "hi" && animator.currentState !== "failure") {
      animator.transitionTo(finale);
    }
    // The finale settled (or already rested): the child scene may take over.
    sceneSuppressed = false;
    applySubagentScene();
  });

  pi.on("session_before_compact", async () => {
    displayActivity.set("busy", "compacting");
    show("compact");
  });

  pi.on("session_compact", async (_event, ctx) => {
    refreshContextUsage(ctx);
    displayActivity.reset();
    show("idle");
  });

  // turn_end runs after persisted assistant/tool messages; also refresh when
  // navigating history or when compaction fails without a success event.
  for (const event of ["turn_start", "turn_end", "session_tree", "session_switch", "session_compact_failed"] as const) {
    // One overload is selected for all of them: the host dispatches by the runtime
    // name, and every branch here only refreshes the context usage.
    pi.on(event as "turn_start", async (_event, ctx) => {
      if (widgetActive) refreshContextUsage(ctx);
    });
  }
}
