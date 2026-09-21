/**
 * Playback position between Spotify polls.
 *
 * Spotify is polled every 1.5 s, so the position has to be extrapolated to keep
 * the highlight smooth — but only within a bounded window, so a dead connection
 * stops the lyrics instead of letting them run away from the music.
 */

/** Never extrapolate further than this past the last sample. */
export const MAX_EXTRAPOLATION_MS = 5_000;

export interface Sample {
  /** `null` when Spotify reports no progress, which cannot be extrapolated. */
  positionMs: number | null;
  playing: boolean;
  durationMs: number;
  /** `performance.now()` reading from when the sample arrived. */
  receivedAt: number;
}

export const emptySample = (receivedAt: number): Sample => ({
  positionMs: 0,
  playing: false,
  durationMs: 0,
  receivedAt,
});

export function positionAt(sample: Sample, now: number): number {
  if (sample.durationMs <= 0) return 0;
  const playing = sample.playing && sample.positionMs !== null;
  const elapsed = playing
    ? Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, now - sample.receivedAt))
    : 0;
  return Math.min(sample.durationMs, (sample.positionMs ?? 0) + elapsed);
}

/** Index of the cue covering `positionMs`, or -1 before the first cue. */
export function activeLine(times: number[], positionMs: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (positionMs < times[mid]) high = mid;
    else low = mid + 1;
  }
  return low - 1;
}

export function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
