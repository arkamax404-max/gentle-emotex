import type { DisplayActivity } from "./external_display.ts";

export const IDLE_CLOCK_DELAY_MS = 5 * 60 * 1000;
export const IDLE_CLOCK_TICK_MS = 1000;

/** Monotonic elapsed time, independent of local clock or timezone adjustments. */
export class IdleClock {
  private idleSince: number | null;

  constructor(now: number) { this.idleSince = now; }

  /**
   * A settled session is the idle activity or the post-error idle the host
   * reports at agent_end after a failed tool: the display already labels that
   * combination IDLE (red), so it must not block the clock for the rest of the
   * session. The YOLO and Super YOLO rest poses are the idle picture while
   * that permission mode is on, so they settle like idle too. Running work,
   * any non-idle phase, a published work phase and a non-idle preview keep
   * owning the display.
   */
  update(activity: DisplayActivity, now: number, state?: string): void {
    const settled = activity.phase === "idle" && activity.activeSubagents === 0
      && (activity.status === "idle" || activity.status === "error");
    const resting = state === undefined || state === "idle" || state === "grandma"
      || state === "yolo" || state === "super-yolo";
    const eligible = settled && activity.workPhase === undefined && resting;
    if (!eligible) this.idleSince = null;
    else if (this.idleSince === null) this.idleSince = now;
  }

  isActive(now: number): boolean {
    return this.idleSince !== null && now - this.idleSince > IDLE_CLOCK_DELAY_MS;
  }

  /**
   * Remaining settled milliseconds before the clock takes over: positive while
   * the deadline runs, zero or negative once it elapsed, null when the activity
   * is not settled at all (never eligible since the last non-idle event).
   */
  remaining(now: number): number | null {
    return this.idleSince === null ? null : IDLE_CLOCK_DELAY_MS - (now - this.idleSince);
  }
}
