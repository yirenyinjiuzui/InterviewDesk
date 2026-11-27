/**
 * Aliyun DashScope streaming ASR engine (`fun-asr-realtime` /
 * `paraformer-realtime-v2`): true duplex streaming over WebSocket — audio
 * frames go up continuously, partial + final sentences come back as
 * `result-generated` events (the service does its own sentence endpointing).
 *
 * Protocol (Model Studio "实时语音识别 WebSocket API"):
 *   client:  run-task → <binary pcm16 frames…> → finish-task
 *   server:  task-started → result-generated… → task-finished | task-failed
 *
 * Endpoint is workspace-scoped:
 *   wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
 * Auth: `Authorization: Bearer <key>` on the WS handshake (needs the `ws`
 * package — Node's built-in WebSocket cannot set headers).
 *
 * China-direct, no proxy. Cloud real-time ASR connects when capture starts
 * on the selected channel.
 */
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import type { Mp3Encoder } from '@breezystack/lamejs';
import { StreamTiming, type AsrTimingRecord } from './streamTiming';
import type {
  AsrEngine,
  StreamingAsrEngine,
  StreamingSession,
  StreamingSessionCallbacks,
  TranscribeResult,
} from './engine';
import type { CloudAsrConfig } from './cloudEngine';

/** float32 [-1,1] -> 16-bit little-endian PCM (the wire format). */
export function f32ToPcm16(pcm: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0, i * 2);
  }
  return buf;
}

/** map our language setting to DashScope language_hints (omit for auto). */
export function languageHints(language?: 'auto' | string): string[] | undefined {
  if (language === 'chinese') return ['zh'];
  if (language === 'english') return ['en'];
  return undefined; // auto: let the service detect (fun-asr handles zh/en mixing)
}

// ---- server event shapes (subset we consume) ----

interface ServerEvent {
  header?: { event?: string; task_id?: string; error_code?: string; error_message?: string };
  payload?: {
    output?: {
      sentence?: {
        begin_time?: number;
        end_time?: number;
        text?: string;
        heartbeat?: boolean;
        sentence_end?: boolean;
      };
    };
  };
}

/** parse one server text frame; returns null on garbage (pure, tested). */
export function parseServerEvent(data: string): ServerEvent | null {
  try {
    const j = JSON.parse(data) as ServerEvent;
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

const START_TIMEOUT_MS = 10_000;
const FINISH_TIMEOUT_MS = 5000;
const MAX_AUDIO_BYTES = 16000 * 2 * 10;
const MP3_KBPS = 32;

class AliyunRtSession implements StreamingSession {
  private ws: WebSocket;
  private readonly taskId = randomUUID();
  private readonly timing?: StreamTiming;
  private started = false;
  private dead = false;
  private pending: Float32Array[] = [];
  private pendingBytes = 0;
  private sentAudio = false;
  private closing = false;
  private taskTimer?: ReturnType<typeof setTimeout>;
  private bufferedSamples = 0;
  private finishResolve: (() => void) | null = null;

  constructor(
    cfg: CloudAsrConfig,
    private readonly cb: StreamingSessionCallbacks,
    language?: 'auto' | string,
    channel?: 'them' | 'me',
    record?: (entry: AsrTimingRecord) => void,
    private recoveredAudio: Float32Array[] = [],
    private readonly encoder?: Mp3Encoder,
  ) {
    if (record) this.timing = new StreamTiming(this.taskId, channel, record);
    this.timing?.mark('connect');
    this.ws = new WebSocket(cfg.baseUrl, {
      // local sidecar (ws://127.0.0.1) needs no auth; omit the header entirely
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      handshakeTimeout: START_TIMEOUT_MS,
    });

    this.ws.on('open', () => {
      this.timing?.mark('open');
      if (this.dead || (this.closing && !this.hasPendingAudio)) return;
      const hints = languageHints(language);
      const runTask = {
        header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: cfg.model,
          parameters: {
            format: this.encoder ? 'mp3' : 'pcm',
            sample_rate: 16000,
            ...(hints ? { language_hints: hints } : {}),
          },
          input: {},
        },
      };
      this.ws.send(JSON.stringify(runTask));
      this.taskTimer = setTimeout(() => this.fail('ASR task-started timeout'), START_TIMEOUT_MS);
      this.taskTimer.unref?.();
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary || this.dead) return;
      const ev = parseServerEvent(data.toString());
      const kind = ev?.header?.event;
      if (!kind) return;
      if (kind === 'task-started') {
        if (this.started || (this.closing && !this.hasPendingAudio)) return;
        this.timing?.mark('task-started');
        clearTimeout(this.taskTimer);
        this.started = true;
        for (const frames of [this.recoveredAudio, this.pending]) {
          for (const pcm of frames) this.writePcm(pcm);
        }
        this.recoveredAudio = [];
        this.pending = [];
        this.pendingBytes = 0;
        if (this.closing) this.sendFinish();
        this.cb.onReady?.();
      } else if (kind === 'result-generated') {
        const s = ev!.payload?.output?.sentence;
        if (!s || s.heartbeat) return;
        const text = (s.text ?? '').trim();
        if (!text) return;
        this.timing?.result(!!s.sentence_end, s.begin_time, s.end_time);
        if (s.sentence_end) {
          this.cb.onSentence({ text, beginMs: s.begin_time ?? NaN, endMs: s.end_time ?? NaN });
        } else {
          this.cb.onPartial(text, { beginMs: s.begin_time, endMs: s.end_time });
        }
      } else if (kind === 'task-finished') {
        if (!this.closing) { this.fail('ASR task finished unexpectedly'); return; }
        this.dead = true;
        this.pending = [];
        this.pendingBytes = 0;
        this.settleFinish();
        this.ws.close();
      } else if (kind === 'task-failed') {
        const msg = `${ev!.header?.error_code ?? 'ERROR'}: ${ev!.header?.error_message ?? 'task failed'}`;
        this.fail(msg);
      }
    });

    this.ws.on('error', (e) => { if (!this.closing) this.fail(`ws error: ${e.message}`); });
    this.ws.on('close', (code) => {
      this.timing?.closed();
      clearTimeout(this.taskTimer);
      if (!this.dead && !this.closing) this.fail(`ASR connection closed unexpectedly (${code})`);
      this.recoveredAudio = [];
      this.pending = [];
      this.pendingBytes = 0;
      this.dead = true;
      this.settleFinish();
    });
  }

  private fail(message: string): void {
    if (this.dead) return;
    this.dead = true;
    const unsent = [...this.recoveredAudio, ...this.pending];
    this.recoveredAudio = [];
    clearTimeout(this.taskTimer);
    this.pending = [];
    this.pendingBytes = 0;
    this.settleFinish();
    try {
      this.ws.terminate();
    } catch {
      /* already closed */
    }
    this.cb.onError(message, unsent);
  }

  private settleFinish(): void {
    const r = this.finishResolve;
    this.finishResolve = null;
    r?.();
  }

  private writePcm(pcm: Float32Array): void {
    const raw = f32ToPcm16(pcm);
    this.sentAudio = true;
    this.bufferedSamples += pcm.length;
    const packet = this.encoder ? Buffer.from(this.encoder.encodeBuffer(new Int16Array(raw.buffer, raw.byteOffset, pcm.length))) : raw;
    this.sendAudio(packet);
  }

  private sendAudio(buf: Buffer): void {
    if (!buf.length) return;
    const samples = this.bufferedSamples;
    this.bufferedSamples = 0;
    const timing = this.timing;
    if (timing) {
      this.ws.send(buf, (error) => { if (!error && samples) timing.frameWritten(samples); });
    } else {
      this.ws.send(buf);
    }
  }

  push(pcm: Float32Array): void {
    if (this.dead || this.closing || pcm.length === 0) return;
    const bytes = pcm.length * 2;
    // Startup buffers raw PCM across handshake and task startup. Once started,
    // bound the socket backlog by audio duration at the negotiated bitrate.
    const compressionRatio = this.encoder ? (16000 * 16) / (MP3_KBPS * 1000) : 1;
    const startupLimit = this.encoder ? 2 * MAX_AUDIO_BYTES : MAX_AUDIO_BYTES;
    const queuedPcmBytes = this.started ? this.ws.bufferedAmount * compressionRatio : this.pendingBytes;
    if (queuedPcmBytes + bytes > (this.started ? MAX_AUDIO_BYTES : startupLimit)) {
      if (!this.started && bytes <= MAX_AUDIO_BYTES) this.pending.push(pcm.slice());
      this.fail('ASR audio backlog exceeded its limit; reconnecting instead of accumulating audio');
      return;
    }
    if (this.started && this.ws.readyState === WebSocket.OPEN) this.writePcm(pcm);
    else { this.pending.push(pcm.slice()); this.pendingBytes += bytes; }
  }

  private get hasPendingAudio(): boolean {
    return this.pending.length > 0 || this.recoveredAudio.length > 0;
  }

  private sendFinish(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.encoder && this.sentAudio) this.sendAudio(Buffer.from(this.encoder.flush()));
    const finishTask = {
      header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
      payload: { input: {} },
    };
    // Give queued audio a bounded drain, then allow a full reply window.
    const replyTimeout = this.encoder ? 20_000 : FINISH_TIMEOUT_MS;
    this.taskTimer = setTimeout(() => this.settleFinish(), START_TIMEOUT_MS + replyTimeout);
    this.taskTimer.unref?.();
    this.ws.send(JSON.stringify(finishTask), error => {
      if (this.dead || !this.finishResolve) return;
      clearTimeout(this.taskTimer);
      if (error) { this.settleFinish(); return; }
      this.taskTimer = setTimeout(() => this.settleFinish(), replyTimeout);
      this.taskTimer.unref?.();
    });
  }

  async close(): Promise<void> {
    this.timing?.flushFrames();
    if (this.dead || this.closing) return;
    this.closing = true;
    if (this.hasPendingAudio || this.sentAudio) {
      // A pending queue keeps its original startup deadline. Once ready, the
      // socket writes the queued PCM in order before finish-task.
      const finished = new Promise<void>((resolve) => { this.finishResolve = resolve; });
      if (this.started) this.sendFinish();
      await finished;
    } else if (this.started) {
      this.sendFinish();
    }
    clearTimeout(this.taskTimer);
    this.ws.terminate();
  }
}

export class AliyunRealtimeEngine implements StreamingAsrEngine, AsrEngine {
  readonly ep = 'cloud-rt';
  readonly streaming = true as const;
  readonly loadMs = 0;
  warmMs = 0;
  readonly lidAvailable = false;

  private constructor(private readonly cfg: CloudAsrConfig, private readonly record?: (entry: AsrTimingRecord) => void,
    private readonly Encoder?: typeof Mp3Encoder) {}

  static async load(cfg: CloudAsrConfig, record?: (entry: AsrTimingRecord) => void): Promise<AliyunRealtimeEngine> {
    if (!cfg.baseUrl || !cfg.model) {
      throw new Error('streaming ASR is not configured (needs a ws(s) URL and a model)');
    }
    if (!/^wss?:\/\//.test(cfg.baseUrl)) {
      throw new Error(`streaming ASR URL must start with ws:// or wss:// (got: ${cfg.baseUrl})`);
    }
    // remote (wss) requires a key; the local ws:// sidecar does not
    if (/^wss:\/\//.test(cfg.baseUrl) && !cfg.apiKey) {
      throw new Error('cloud streaming ASR requires an API key');
    }
    const url = new URL(cfg.baseUrl);
    const useMp3 = url.protocol === 'wss:' && url.hostname.endsWith('.aliyuncs.com') && cfg.model === 'fun-asr-realtime';
    const Encoder = useMp3 ? (await import('@breezystack/lamejs')).Mp3Encoder : undefined;
    return new AliyunRealtimeEngine(cfg, record, Encoder);
  }

  async warmup(): Promise<number> {
    return 0; // stateless per-session; nothing to warm
  }

  openSession(cb: StreamingSessionCallbacks, opts?: { language?: 'auto' | string; channel?: 'them' | 'me'; recoveredAudio?: Float32Array[] }): StreamingSession {
    const encoder = this.Encoder && new this.Encoder(1, 16000, MP3_KBPS);
    return new AliyunRtSession(this.cfg, cb, opts?.language, opts?.channel, this.record, opts?.recoveredAudio, encoder);
  }

  /**
   * One-shot compatibility path (harness / worker partial fallback): stream
   * the whole clip through a throwaway session and join the sentences.
   */
  async transcribe(pcm: Float32Array, language: 'auto' | string): Promise<TranscribeResult> {
    const t0 = Date.now();
    const parts: string[] = [];
    let err: string | null = null;
    const session = this.openSession(
      {
        onPartial: () => undefined,
        onSentence: (s) => parts.push(s.text),
        onError: (m) => {
          err = m;
        },
      },
      { language },
    );
    const CHUNK = 1600; // 100 ms
    for (let off = 0; off < pcm.length; off += CHUNK) {
      session.push(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
    }
    await session.close();
    if (err && parts.length === 0) throw new Error(err);
    return { text: parts.join(' ').trim(), lang: undefined, inferMs: Date.now() - t0 };
  }
}
