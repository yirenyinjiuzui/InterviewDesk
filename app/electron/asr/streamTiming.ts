import { performance } from 'node:perf_hooks';

interface FrameWrite {
  /** Exclusive end offset in 16 kHz mono samples, including silence. */
  endSample: number;
  sentAt: number;
}

interface AudioBounds {
  /** Connection-wide PCM writes completed so far, including any trailing silence. */
  firstFrameSentAt: number | null;
  lastFrameSentAt: number | null;
}

type TimingEvent =
  | { event: 'connect' | 'open' | 'task-started' }
  | { event: 'audio'; frames: FrameWrite[] }
  | { event: 'first-partial'; beginMs: number | null }
  | ({ event: 'segment'; beginMs: number | null; endMs: number | null; firstPartialAt: number | null } & AudioBounds)
  | ({ event: 'close' } & AudioBounds);

export type AsrTimingRecord = TimingEvent & { taskId: string; channel?: 'them' | 'me'; at: number };

// Epoch milliseconds on one monotonic clock, shared by all stages of this task.
const now = () => performance.timeOrigin + performance.now();

export class StreamTiming {
  private endSample = 0;
  private frames: FrameWrite[] = [];
  private firstFrameSentAt: number | null = null;
  private lastFrameSentAt: number | null = null;
  private readonly partials = new Map<number | null, number>();

  constructor(
    private readonly taskId: string,
    private readonly channel: 'them' | 'me' | undefined,
    private readonly record: (entry: AsrTimingRecord) => void,
  ) {}

  mark(event: 'connect' | 'open' | 'task-started'): void {
    this.emit({ event });
  }

  frameWritten(samples: number): void {
    const sentAt = now();
    this.firstFrameSentAt ??= sentAt;
    this.lastFrameSentAt = sentAt;
    this.endSample += samples;
    this.frames.push({ endSample: this.endSample, sentAt });
    // Batch metadata across IPC and disk writes; keep even the first lone frame observable.
    if (this.endSample === samples || this.frames.length >= 64) this.flushFrames();
  }

  flushFrames(): void {
    if (!this.frames.length) return;
    this.emit({ event: 'audio', frames: this.frames }, this.lastFrameSentAt!);
    this.frames = [];
  }

  result(final: boolean, beginMs: number | undefined, endMs: number | undefined): void {
    const at = now();
    const begin = typeof beginMs === 'number' && Number.isFinite(beginMs) ? beginMs : null;
    if (final) {
      this.flushFrames();
      this.emit({
        event: 'segment',
        beginMs: begin,
        endMs: typeof endMs === 'number' && Number.isFinite(endMs) ? endMs : null,
        firstPartialAt: this.partials.get(begin) ?? null,
        firstFrameSentAt: this.firstFrameSentAt,
        lastFrameSentAt: this.lastFrameSentAt,
      }, at);
      this.partials.delete(begin);
    } else if (!this.partials.has(begin)) {
      // Match the worker's bound when a provider keeps revising sentence starts without finals.
      if (this.partials.size >= 16) this.partials.delete(this.partials.keys().next().value!);
      this.partials.set(begin, at);
      this.flushFrames();
      this.emit({ event: 'first-partial', beginMs: begin }, at);
    }
  }

  closed(): void {
    this.flushFrames();
    this.emit({ event: 'close', firstFrameSentAt: this.firstFrameSentAt, lastFrameSentAt: this.lastFrameSentAt });
  }

  private emit(event: TimingEvent, at = now()): void {
    this.record({ ...event, at, taskId: this.taskId, channel: this.channel });
  }
}
