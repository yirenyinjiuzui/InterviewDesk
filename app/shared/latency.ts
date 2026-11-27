import type { SegmentTimings } from './protocol';

/** Unknown/invalid timestamps stay unknown; never clamp a clock error to zero. */
export function measuredMs(end?: number, start?: number): number | undefined {
  return Number.isFinite(end) && Number.isFinite(start) && end! >= start! ? end! - start! : undefined;
}
export function transcriptLatency(timing: SegmentTimings, renderedAt: number) {
  if (timing.timingValid === false) return { finalMs: undefined, firstMs: undefined, inferMs: undefined };
  return { finalMs: measuredMs(renderedAt, timing.speechEndTs), firstMs: measuredMs(timing.firstTextTs, timing.speechStartTs),
    inferMs: timing.timingKind === 'stream' ? undefined : measuredMs(timing.inferEndTs, timing.inferStartTs) };
}
export function durationText(ms?: number): string {
  return ms !== undefined && Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(2)}s` : '—';
}
