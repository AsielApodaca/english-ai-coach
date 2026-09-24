/**
 * Open-loop voice-activity tracker for hands-free practice turns.
 *
 * Feeds one RMS-dB frame at a time (a `WaveRecorder` `onLevel` sample) and
 * reports two transitions:
 *   - "start": sustained speech began (first frame above the speech threshold).
 *   - "silence": speech was heard and then followed by `silenceMs` without
 *     another loud frame — used to end the turn automatically.
 *
 * Pure and testable: all time comes from the injected `now` clock.
 */
export class VadTracker {
  /**
   * @param {{ speechDb?: number, silenceMs?: number, now?: () => number }} [opts]
   */
  constructor({ speechDb = -55, silenceMs = 1200, now = () => Date.now() } = {}) {
    this.speechDb = speechDb;
    this.silenceMs = silenceMs;
    this.now = now;
    /** True once at least one loud frame arrived. */
    this.speechSeen = false;
    /** Instant (ms) the current silence streak started, null while speaking. */
    this.silenceSince = null;
  }

  /**
   * Process one RMS-dB frame.
   *
   * @param {number} db - buffer RMS in dBFS (-Infinity on pure silence)
   * @returns {"start"|"silence"|null}
   */
  feed(db) {
    const loud = Number.isFinite(db) && db > this.speechDb;
    if (loud) {
      this.silenceSince = null;
      if (!this.speechSeen) {
        this.speechSeen = true;
        return "start";
      }
      return null;
    }
    if (!this.speechSeen) return null;
    const t = this.now();
    if (this.silenceSince === null) {
      this.silenceSince = t;
    } else if (t - this.silenceSince >= this.silenceMs) {
      // Re-arm so the tracker could fire again on a following utterance.
      this.silenceSince = null;
      return "silence";
    }
    return null;
  }
}