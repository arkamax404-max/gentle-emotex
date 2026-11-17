import { randomUUID } from "node:crypto";
import type { ExternalDisplayConfig } from "./types.ts";
import { encodeProjectName, normalizeTitle } from "./title_state.ts";
import { prepareDisplayImage, resolvePhaseLabel } from "./display_image.ts";
import { IdleClock, IDLE_CLOCK_TICK_MS } from "./idle_clock.ts";
import { isWorkPhase } from "./work_phase.ts";
import { log } from "./log.ts";

export interface SelectedImage { base64: string; state: string; frame: string; set: string }
export type FrameSink = (image: SelectedImage) => void;
export interface DisplayActivity {
  status: "idle" | "busy" | "error";
  phase: "idle" | "thinking" | "responding" | "executing" | "waiting" | "compacting";
  activeSubagents: number;
  /** The host's detailed ODD work phase, when Gentle Shell published one. Optional: omitted when absent. */
  workPhase?: "authorizing" | "exploring" | "researching" | "deciding" | "planning" | "implementing" | "checking" | "closing";
}
type ContextBand = "green" | "yellow" | "red";
type Selection = SelectedImage & { activity: DisplayActivity; contextBand: ContextBand; carrier?: { state: string; title: string | null }; phaseElapsedSeconds?: number };
const IDENTIFIER = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

/** Invalid options disable networking, never local rendering. Credentials are not supported. */
export function normalizeExternalDisplay(value: unknown): ExternalDisplayConfig | null {
  if (!value || typeof value !== "object") return null;
  const { enabled, url, timeoutMs = 1000, transparentBackground, background, backgroundCoverage, outline, idleClock } = value as ExternalDisplayConfig;
  if (idleClock !== undefined && !["off", "receiver", "silence"].includes(idleClock)) return null;
  if (transparentBackground !== undefined && typeof transparentBackground !== "boolean") return null;
  if (outline !== undefined && (typeof outline !== "string" || !/^#[0-9a-f]{6}$/i.test(outline))) return null;
  if (backgroundCoverage !== undefined && (typeof backgroundCoverage !== "number" || !Number.isFinite(backgroundCoverage) || backgroundCoverage < 0 || backgroundCoverage > 1)) return null;
  if (background !== undefined && (typeof background !== "string" || !/^#[0-9a-f]{6}$/i.test(background))) return null;
  if (enabled !== true || typeof url !== "string" || typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return null;
    return { enabled: true, url: parsed.href, timeoutMs, ...(idleClock === undefined ? {} : { idleClock }), ...(transparentBackground === undefined ? {} : { transparentBackground }), ...(background === undefined ? {} : { background }), ...(backgroundCoverage === undefined ? {} : { backgroundCoverage }), ...(outline === undefined ? {} : { outline }) };
  } catch { return null; }
}

/** Match configured loopback destinations, never arbitrary LAN hosts or substrings. */
export function isLoopbackDisplayUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch { return false; }
}

/** Independent queues, timeouts and caches per destination; legacy URL stays supported. */
export class ExternalDisplays {
  private displays: ExternalDisplay[] = [];

  constructor(options: unknown, fetcher: typeof fetch = fetch, report: (message: string) => void = () => {}, sessionId: string | null = null, projectName: string | null = null) {
    if (!options || typeof options !== "object") return;
    const config = options as ExternalDisplayConfig;
    if (config.enabled !== true) return;
    if (config.targets === undefined) {
      this.displays = [new ExternalDisplay(options, fetcher, report, sessionId, projectName)];
      return;
    }
    if (!Array.isArray(config.targets) || config.targets.length > 8) {
      try { report("externalDisplay: targets must be an array of at most 8 destinations; disabled"); } catch { /* diagnostic only */ }
      return;
    }
    this.displays = config.targets.map((target, index) => new ExternalDisplay(
      target && typeof target === "object" ? { timeoutMs: config.timeoutMs, transparentBackground: config.transparentBackground, background: config.background, backgroundCoverage: config.backgroundCoverage, outline: config.outline, idleClock: config.idleClock, ...target } : null,
      fetcher,
      message => report(`destination ${index + 1}: ${message}`),
      sessionId,
      projectName,
    ));
  }

  get enabled(): boolean { return this.displays.some(display => display.enabled); }

  /** Pause only configured loopback destinations; never enables disabled config. */
  setDebugEnabled(enabled: boolean): number {
    let count = 0;
    for (const display of this.displays) {
      if (!display.local) continue;
      display.setPaused(!enabled);
      count++;
    }
    return count;
  }

  /** LED/ESP32 destinations are the configured non-loopback targets. */
  setDisplayEnabled(enabled: boolean): number {
    let count = 0;
    for (const display of this.displays) {
      if (!display.enabled || display.local) continue;
      display.setPaused(!enabled);
      count++;
    }
    return count;
  }

  /** Explicit /emote displayOn: resume and claim each LED/ESP32 destination, even when already enabled. */
  claimDisplays(): number {
    let count = 0;
    for (const display of this.displays) {
      if (!display.enabled || display.local) continue;
      display.claimOwnership();
      count++;
    }
    return count;
  }

  /** Explicit /emote displayOff: cancel pending work and release each LED/ESP32 destination. */
  releaseDisplays(): number {
    let count = 0;
    for (const display of this.displays) {
      if (!display.enabled || display.local) continue;
      display.releaseOwnership();
      count++;
    }
    return count;
  }

  select(image: SelectedImage): void { for (const display of this.displays) display.select(image); }
  updateActivity(activity: DisplayActivity): void { for (const display of this.displays) display.updateActivity(activity); }
  setContextUsage(percent: number | null): void { for (const display of this.displays) display.setContextUsage(percent); }
  /** Live caption change on every destination; returns the count that accepted it. */
  setTitle(value: string | null): number { let count = 0; for (const display of this.displays) if (display.setTitle(value)) count++; return count; }
  dispose(): void { for (const display of this.displays) display.dispose(); this.displays = []; }
}

/** Latest-frame delivery: one active request, one replaceable pending selection. */
export class ExternalDisplay {
  private options: ExternalDisplayConfig | null;
  private streamId = randomUUID();
  private sequence = 0n;
  // Capture identity for this sender lifetime: queued frames cannot change sessions.
  private readonly sessionId: string | null;
  // Capture the sending project's working-directory basename for every image
  // destination: immutable per sender, never a full path. The raw basename
  // labels the captioned PNG layout on all destinations, and the percent-encoded
  // metadata header rides every image request, loopback and LAN alike, so the
  // panel receiver can bind the session title like the desktop receiver does.
  // It never rides heartbeats or the bodyless control routes, which are not images.
  private projectName: string | null;
  private displayName: string | null;
  // Captured folder basename: the fallback when a title override resets.
  private readonly baseName: string | null;
  private readonly baseEncoded: string | null;
  private heartbeatUrl: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatPending = false;
  private hasFrame = false;
  // Session ownership (fixed LED protocol): only the explicit /emote displayOn
  // path claims through the same single-flight queue; restore never claims and
  // legacy/409 answers stay warned non-claims, never an exclusivity report.
  private controls: Array<"claim" | "release"> = [];
  private explicitOwner = false;
  private legacyWarned = false;
  private conflictWarned = false;
  private unclaimableWarned = false;
  private disposed = false;
  private paused = false;
  private active: AbortController | null = null;
  private pending: Selection | null = null;
  private selected: SelectedImage | null = null;
  private activity: DisplayActivity = { status: "idle", phase: "idle", activeSubagents: 0 };
  private lastKey = "";
  // Phase-clock identity per destination: the resolved visible label and the
  // monotonic moment it appeared. Null while IDLE, absent selection or pause.
  private phaseLabel: string | null = null;
  private phaseStartedAt: number | null = null;
  // Whether the current visible phase is exempt from the clock: visible IDLE or
  // GRANDMA with no active subagents. Tracked separately so an eligibility
  // transition resets the budget even when the label itself stays unchanged.
  private phaseUntimed = false;
  // Independent of terminal caches; at most 32 prepared avatar images.
  private cache = new Map<string, Buffer>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private idleClock = new IdleClock(performance.now());
  // Freeze the selected avatar and caption for the receiver's one-time carrier.
  private clockCarrier: (SelectedImage & { title: string | null; contextBand: ContextBand }) | null = null;
  private contextBand: ContextBand = "green";

  private fetcher: typeof fetch;
  private report: (message: string) => void;

  constructor(options: unknown, fetcher: typeof fetch = fetch, report: (message: string) => void = () => {}, sessionId: string | null = null, projectName: string | null = null) {
    this.fetcher = fetcher;
    this.report = report;
    this.sessionId = typeof sessionId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId) ? sessionId : null;
    this.projectName = encodeProjectName(projectName);
    this.displayName = this.projectName === null ? null : projectName as string;
    this.baseName = this.displayName;
    this.baseEncoded = this.projectName;
    this.options = normalizeExternalDisplay(options);
    if (this.options) {
      this.clockTimer = setInterval(() => this.queueLatest(), IDLE_CLOCK_TICK_MS);
      this.clockTimer.unref?.();
      const url = new URL(this.options.url);
      if (this.sessionId && url.pathname === "/emote" && !url.search) {
        url.pathname = "/emote/heartbeat";
        this.heartbeatUrl = url.href;
        this.heartbeatTimer = setInterval(() => {
          if (this.disposed || this.paused || !this.heartbeatUrl || this.isSilenced()) return;
          // Heartbeats also run before the first frame once the user explicitly
          // enabled this destination or it holds a reservation; a restored
          // preference keeps today's first-frame gate exactly as before.
          if (!this.hasFrame && !this.explicitOwner) return;
          this.heartbeatPending = true;
          if (!this.active) void this.drain();
        }, 5000);
        this.heartbeatTimer.unref?.();
      }
    }
    if (options && (options as ExternalDisplayConfig).enabled && !this.options) this.warn("externalDisplay: invalid configuration; disabled");
  }

  get enabled(): boolean { return !!this.options && !this.disposed; }

  get local(): boolean { return !!this.options && isLoopbackDisplayUrl(this.options.url); }

  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.paused) return;
    this.paused = paused;
    this.lastKey = "";
    this.clockCarrier = null;
    // Resume starts the phase clock fresh.
    this.phaseLabel = null;
    this.phaseStartedAt = null;
    this.phaseUntimed = false;
    if (paused) {
      this.pending = null;
      this.heartbeatPending = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.active?.abort();
    } else {
      this.queueLatest();
    }
  }

  private warn(message: string) { try { this.report(message); } catch { /* sink diagnostics cannot break UI */ } }

  /** Control routes exist only on non-loopback exact /emote destinations with session identity. */
  private claimable(): boolean {
    if (!this.options || this.sessionId === null || this.local) return false;
    try {
      const url = new URL(this.options.url);
      return url.pathname === "/emote" && !url.search;
    } catch { return false; }
  }

  /** Explicit /emote displayOn for this destination: claim the reservation through the shared queue, before any later image. */
  claimOwnership(): void {
    if (this.disposed || !this.options) return;
    this.explicitOwner = true;
    // Every explicit command enqueues its own claim: a queued claim never
    // stands in for a later order, because only the sent request reserves.
    if (this.claimable()) this.controls.push("claim");
    else if (!this.unclaimableWarned) {
      // No session identity or not the exact /emote route: this destination
      // cannot hold a reservation, and reporting an enforced one would lie.
      this.unclaimableWarned = true;
      this.warn("externalDisplay: this destination cannot hold a session reservation without a session identity and the exact /emote route; delivering without exclusivity");
    }
    this.setPaused(false);
    if (!this.paused && !this.active) void this.drain();
  }

  /** Explicit /emote displayOff for this destination: cancel pending work, abort the active request and release. */
  releaseOwnership(): void {
    if (this.disposed || !this.options) return;
    this.setPaused(true);
    this.pending = null;
    this.heartbeatPending = false;
    this.explicitOwner = false;
    this.legacyWarned = false;
    this.conflictWarned = false;
    this.unclaimableWarned = false;
    if (this.claimable()) this.controls = ["release"];
    if (!this.active) void this.drain();
  }

  /** Ownership outcomes never throw and never auto-retry: legacy and 409 stay warned non-claims. */
  private handleControl(control: "claim" | "release", response: Response): void {
    if (control === "claim" && response.ok && response.headers.get("X-Emote-Ownership") === "1") return;
    if (response.status === 409) {
      if (!this.conflictWarned) {
        this.conflictWarned = true;
        this.warn(`externalDisplay: ${control} rejected with 409 (another session may own the display); delivering without exclusivity`);
      }
    } else if (control === "claim" && (response.ok || response.status === 404 || response.status === 405)) {
      if (!this.legacyWarned) {
        this.legacyWarned = true;
        this.warn("externalDisplay: receiver does not support session ownership; delivering without a reservation");
      }
    } else if (!response.ok) {
      this.deliveryDiagnostic("externalDisplay: receiver rejected control request");
    }
  }

  private deliveryDiagnostic(message: string): void {
    try { log(message); } catch { /* diagnostics must not affect delivery or UI */ }
  }

  updateActivity(activity: DisplayActivity): void {
    if (!Number.isSafeInteger(activity.activeSubagents) || activity.activeSubagents < 0) return;
    // A present but invalid detail rejects the whole update; a valid or absent one is stored.
    if (activity.workPhase !== undefined && !isWorkPhase(activity.workPhase)) return;
    const { workPhase, ...rest } = activity;
    this.activity = rest as DisplayActivity;
    if (isWorkPhase(workPhase)) this.activity.workPhase = workPhase;
    this.idleClock.update(this.activity, performance.now(), this.selected?.state);
    this.queueLatest();
  }

  select(image: SelectedImage): void {
    if (!this.options || this.disposed) return;
    try {
      if (![image.state, image.frame, image.set].every(value => IDENTIFIER.test(value))) {
        this.warn("externalDisplay: unsupported frame identifier; skipped"); return;
      }
      this.selected = { ...image };
      this.idleClock.update(this.activity, performance.now(), image.state);
      this.queueLatest();
    } catch { this.warn("externalDisplay: selection failed"); }
  }

  /**
   * Live caption change: re-captions the current selection without touching the
   * selection, stream, sequence, timers or output states. `null` resets to the
   * captured folder basename. Returns false when the title is invalid.
   */
  setTitle(value: string | null): boolean {
    const next = normalizeTitle(value);
    if (next === undefined) return false;
    const raw = next === null ? this.baseName : next;
    const encoded = next === null ? this.baseEncoded : encodeProjectName(next);
    if (raw === this.displayName) return true;
    this.displayName = raw;
    this.projectName = encoded;
    // Save caption changes now, but do not churn the receiver's clock carrier.
    if (!this.clockCarrier) this.lastKey = "";
    this.queueLatest();
    return true;
  }

  /** Context affects only caption ink; unknown usage retains the existing green. */
  setContextUsage(percent: number | null): void {
    if (this.disposed) return;
    const band: ContextBand = typeof percent === "number" && Number.isFinite(percent) && percent >= 0
      ? percent > 80 ? "red" : percent >= 60 ? "yellow" : "green"
      : "green";
    if (band === this.contextBand) return;
    this.contextBand = band;
    // Receiver clocks retain one frozen carrier; apply the latest band on resume.
    if (!this.clockCarrier) this.queueLatest();
  }

  private isSilenced(): boolean {
    return this.options?.idleClock === "silence" && this.idleClock.isActive(performance.now());
  }

  /** Delegate ambient visuals to the destination; retain the latest avatar for resume. */
  private queueLatest(): void {
    if (!this.options || this.disposed || this.paused) return;
    try {
      const now = performance.now();
      const ambient = this.options.idleClock !== undefined && this.options.idleClock !== "off" && this.idleClock.isActive(now);
      if (ambient && this.options.idleClock === "silence") {
        this.pending = null;
        this.heartbeatPending = false;
        this.lastKey = "";
        return;
      }
      if (!this.selected) return;
      if (!ambient) this.clockCarrier = null;
      else this.clockCarrier ??= { ...this.selected, title: this.displayName, contextBand: this.contextBand };
      const image = this.clockCarrier
        ? { base64: this.clockCarrier.base64, state: "clock", frame: "clock.png", set: "idle-clock" }
        : this.selected;
      const carrier = this.clockCarrier ? { state: this.clockCarrier.state, title: this.clockCarrier.title } : undefined;
      const phaseElapsedSeconds = ambient ? undefined : this.phaseElapsed(image, now);
      const contextBand = this.displayName ? (this.clockCarrier?.contextBand ?? this.contextBand) : "green";
      const key = JSON.stringify([image.base64, image.state, image.frame, image.set, this.activity, phaseElapsedSeconds, contextBand]);
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.pending = { ...image, activity: { ...this.activity }, contextBand, ...(carrier === undefined ? {} : { carrier }), ...(phaseElapsedSeconds === undefined ? {} : { phaseElapsedSeconds }) };
      if (!this.active) void this.drain();
    } catch { this.warn("externalDisplay: selection failed"); }
  }

  /**
   * Timer identity follows the visible phase label per destination: reset on
   * every visible change, preserved across same-label frames and activity
   * updates, elapsed only past five seconds. Visible IDLE and GRANDMA stay
   * untimed only while no subagent is running: with active workers they time
   * like any other phase, the timer clears the moment the workers finish, and
   * a later start on the same visible label begins a fresh budget.
   */
  private phaseElapsed(image: SelectedImage, now: number): number | undefined {
    const label = resolvePhaseLabel({ ...this.activity, state: image.state });
    const untimed = ["IDLE", "GRANDMA"].includes(label.toUpperCase()) && this.activity.activeSubagents === 0;
    if (label !== this.phaseLabel || untimed !== this.phaseUntimed) {
      this.phaseLabel = label;
      this.phaseUntimed = untimed;
      this.phaseStartedAt = untimed ? null : now;
    }
    if (this.phaseStartedAt === null) return undefined;
    const elapsed = now - this.phaseStartedAt;
    return elapsed > 5000 ? Math.floor(elapsed / 1000) : undefined;
  }

  private async drain(): Promise<void> {
    const control = this.controls[0] ?? null;
    // Silence stops ambient traffic so the receiver can run its own clock, which
    // is why the documented 30 s reservation lapses while it lasts. An explicit
    // claim or release is an order, not ambient traffic, so it still runs.
    if (this.isSilenced()) {
      this.pending = null;
      this.heartbeatPending = false;
      if (!control) return;
    }
    if (!this.options || this.disposed || this.active) return;
    // Release may run while paused; every other delivery waits for an enabled destination.
    if (this.paused && control !== "release") return;
    if (!control && !this.pending && !this.heartbeatPending) return;
    const image = control ? null : this.pending;
    const heartbeat = !control && !image;
    if (control) this.controls.shift();
    if (image) this.pending = null;
    if (heartbeat) this.heartbeatPending = false;
    const controller = new AbortController();
    this.active = controller;
    this.timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      if (control) {
        // Control routes are bodyless and session-scoped; the image sequence stays image-attempt-only.
        const url = new URL(this.options.url);
        url.pathname = `/emote/${control}`;
        const response = await this.fetcher(url.href, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "X-Emote-Version": "1", "X-Emote-Session-Id": this.sessionId! },
        });
        // Do not retain or consume receiver content; release its connection/body.
        await response.body?.cancel();
        this.handleControl(control, response);
      } else {
      let body: Buffer | undefined;
      const headers: Record<string, string> = { "X-Emote-Version": "1", "X-Emote-Stream-Id": this.streamId };
      if (this.sessionId) headers["X-Emote-Session-Id"] = this.sessionId;
      if (image) {
        // Keep the same preparation and cache policy for legacy and session images.
        // The captioned layout is part of the cached bytes' identity per destination.
        const title = image.carrier ? image.carrier.title : this.displayName;
        const state = image.carrier?.state ?? image.state;
        const layoutKey = title ? `project:${title}:` : "";
        const cacheKey = `${layoutKey}${JSON.stringify([image.base64, state, image.activity.status, image.activity.phase, image.activity.activeSubagents, image.activity.workPhase, image.phaseElapsedSeconds, image.contextBand])}`;
        body = this.cache.get(cacheKey);
        if (!body) {
          // LED targets always get an outline; desktop/D200 loopback targets never do.
          body = prepareDisplayImage(image.base64, { ...image.activity, state, ...(image.phaseElapsedSeconds === undefined ? {} : { phaseElapsedSeconds: image.phaseElapsedSeconds }) }, this.options.background, this.options.backgroundCoverage, this.local ? undefined : (this.options.outline ?? '#ffffff'), this.options.transparentBackground, title, image.contextBand === "red" ? [255, 0, 0] : image.contextBand === "yellow" ? [255, 255, 0] : this.local ? undefined : [0, 255, 0]);
          if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(cacheKey, body);
        }
        Object.assign(headers, {
          "Content-Type": "image/png", "X-Emote-State": image.state,
          "X-Emote-Frame": image.frame, "X-Emote-Set": image.set,
          "X-Emote-Status": image.activity.status, "X-Emote-Phase": image.activity.phase,
          "X-Emote-Active-Subagents": String(image.activity.activeSubagents),
          ...(image.activity.workPhase === undefined ? {} : { "X-Emote-Work-Phase": image.activity.workPhase }),
        });
        if (this.projectName) headers["X-Emote-Project-Name"] = this.projectName;
      }
      const limit = this.sessionId ? 18446744073709551615n : 99999999999999999999n;
      if (this.sequence >= limit) throw new Error("sequence exhausted");
      headers["X-Emote-Sequence"] = String(++this.sequence);
      if (image) this.hasFrame = true;
      const response = await this.fetcher(heartbeat ? this.heartbeatUrl! : this.options.url, {
        method: "POST", redirect: "error", signal: controller.signal, body, headers,
      });
      // Do not retain or consume receiver content; release its connection/body.
      await response.body?.cancel();
      // Older PNG receivers may not implement lifecycle routes. Probe only once.
      if (heartbeat && response.status === 404) this.heartbeatUrl = null;
      else if (response.status === 409 && !this.conflictWarned) {
        this.conflictWarned = true;
        this.warn("externalDisplay: receiver reports another session owns the display (409); delivering without exclusivity");
      }
      else if (!response.ok) this.deliveryDiagnostic("externalDisplay: receiver rejected frame");
      }
    } catch { if (!this.disposed) this.deliveryDiagnostic("externalDisplay: delivery failed or timed out"); }
    finally {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.active = null;
      if (!this.disposed && (this.pending || this.heartbeatPending || this.controls.length > 0)) void this.drain();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.controls = [];
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatPending = false;
    this.pending = null;
    this.selected = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active?.abort();
    this.cache.clear();
    this.lastKey = "";
    this.phaseLabel = null;
    this.phaseStartedAt = null;
    this.phaseUntimed = false;
  }
}
