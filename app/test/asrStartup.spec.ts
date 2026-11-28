import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { StreamingSessionCallbacks } from '../electron/asr/engine';

const state = vi.hoisted(() => ({
  port: { on: vi.fn(), postMessage: vi.fn() },
  sessions: [] as { push: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; callbacks: StreamingSessionCallbacks }[],
}));
vi.mock('worker_threads', () => ({ parentPort: state.port }));
vi.mock('../electron/asr/aliyunRealtimeEngine', () => ({
  AliyunRealtimeEngine: {
    load: async () => ({
      streaming: true,
      ep: 'cloud-rt',
      openSession(callbacks: StreamingSessionCallbacks, opts?: { recoveredAudio?: Float32Array[] }) {
        const session = { push: vi.fn(), close: vi.fn().mockResolvedValue(undefined), callbacks };
        for (const pcm of opts?.recoveredAudio ?? []) session.push(pcm);
        state.sessions.push(session);
        return session;
      },
    }),
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.clearAllMocks();
  state.sessions.length = 0;
});

it('connects on capture silence, preserves timing, and retains the idle cost gate', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const port = new EventEmitter();
  state.port.on.mockImplementation(port.on.bind(port));
  await import('../electron/asr/worker');
  const send = (message: unknown) => port.emit('message', message);
  send({ type: 'init', backend: 'cloud-realtime', language: 'auto', cloud: { baseUrl: 'ws://localhost', model: 'test', apiKey: '' } });
  await Promise.resolve();
  const silence = new Float32Array(1600);
  const frame = (pcm = silence) => send({ type: 'pcm', pcm, captureTs: Date.now(), channel: 'them' });
  frame();
  expect(state.sessions).toHaveLength(1);
  expect(state.sessions[0].push).toHaveBeenCalledTimes(1);
  expect(state.port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'partial' }));

  vi.advanceTimersByTime(100);
  frame(new Float32Array(1600).fill(0.2));
  expect(state.sessions).toHaveLength(1);
  expect(state.sessions[0].push).toHaveBeenCalledTimes(2);
  state.sessions[0].callbacks.onSentence({ text: '测试转录', beginMs: 100, endMs: 200 });
  expect(state.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'segment', speechStartTs: 100000, speechEndTs: 100100,
  }));

  // Continuous silence eventually closes the session without reopening every frame.
  for (let i = 0; i < 150; i++) {
    vi.advanceTimersByTime(100);
    frame();
  }
  expect(state.sessions[0].close).toHaveBeenCalledOnce();
  expect(state.sessions).toHaveLength(1);
  send({ type: 'flush' });
  frame();
  expect(state.sessions).toHaveLength(2);
  expect(state.sessions[1].push).toHaveBeenCalledTimes(1);
  state.sessions[0].callbacks.onError('late failure from the previous capture');
  vi.advanceTimersByTime(100);
  frame();
  expect(state.sessions[1].push).toHaveBeenCalledTimes(2);

  // Independently stopping/resuming a microphone also primes its next capture.
  vi.advanceTimersByTime(1200);
  send({ type: 'pcm', pcm: silence, captureTs: Date.now(), channel: 'me' });
  expect(state.sessions).toHaveLength(3);
});


async function boot(preconnectOnCapture = false, backend = 'cloud-realtime') {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const port = new EventEmitter(); state.port.on.mockImplementation(port.on.bind(port));
  await import('../electron/asr/worker');
  const send = (message: unknown) => port.emit('message', message);
  send({ type: 'init', backend, language: 'auto', preconnectOnCapture, cloud: { baseUrl: 'ws://localhost', model: 'test', apiKey: 'fixture' } });
  await Promise.resolve();
  const frame = (channel = 'them') => send({ type: 'pcm', pcm: new Float32Array(1600), captureTs: Date.now(), channel });
  const frames = (count: number) => { for (let i = 0; i < count; i++) { vi.advanceTimersByTime(100); frame(); } };
  return { send, frame, frames };
}

it('starts the selected cloud task on capture and anchors its timeline to the first PCM frame', async () => {
  const { send, frame } = await boot(true);
  const capture = (active: boolean) => send({ type: 'capture', channel: 'me', active });
  expect(state.sessions).toHaveLength(0);
  capture(true);
  capture(true);
  expect(state.sessions).toHaveLength(1);
  const s = state.sessions[0];
  expect(s.push).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2500);
  frame('me');
  expect(state.sessions).toHaveLength(1);
  expect(s.push).toHaveBeenCalledOnce();
  s.callbacks.onSentence({ text: 'first sentence', beginMs: 0, endMs: 100 });
  expect(state.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'segment', speaker: 'me', speechStartTs: 102400, speechEndTs: 102500,
  }));
  capture(false);
  expect(s.close).toHaveBeenCalledOnce();
  frame('me');
  expect(s.push).toHaveBeenCalledOnce();
  capture(true);
  expect(state.sessions).toHaveLength(2);
  capture(false);
  expect(state.sessions[1].close).toHaveBeenCalledOnce();
});

it('lets an unused cloud preconnection expire without reconnecting', async () => {
  const { send } = await boot(true);
  send({ type: 'capture', channel: 'them', active: true });
  vi.advanceTimersByTime(15000);
  expect(state.sessions).toHaveLength(1);
  expect(state.sessions[0].close).toHaveBeenCalledOnce();
});

it('leaves a shared realtime engine without cloud preconnect on demand', async () => {
  const { send, frame } = await boot();
  send({ type: 'capture', channel: 'them', active: true });
  expect(state.sessions).toHaveLength(0);
  frame();
  expect(state.sessions).toHaveLength(1);
});

it.each([false, true])('delivers a delayed final to the owner of its audio (stop and preconnect: %s)', async restart => {
  const { send } = await boot(restart);
  const frame = (sessionId: string) => send({ type: 'pcm', channel: 'them', sessionId,
    captureTs: Date.now(), pcm: new Float32Array(1600) });
  send({ type: 'capture', channel: 'them', active: true, sessionId: 'A' });
  frame('A');
  const previous = state.sessions[0];
  previous.callbacks.onPartial('first question', { beginMs: 0 });
  if (restart) {
    send({ type: 'capture', channel: 'them', active: false, sessionId: 'A' });
    send({ type: 'capture', channel: 'them', active: true, sessionId: 'B' });
  }
  frame('B');
  expect(previous.close).toHaveBeenCalledOnce();
  const current = state.sessions[1];
  current.callbacks.onPartial('next question', { beginMs: 0 });
  previous.callbacks.onSentence({ text: 'first question?', beginMs: 0, endMs: 100 });
  current.callbacks.onSentence({ text: 'next question?', beginMs: 0, endMs: 100 });
  const results = state.port.postMessage.mock.calls.map(([event]) => event)
    .filter(event => event.type === 'partial' || event.type === 'segment');
  expect(results.map(event => [event.type, event.text, event.sessionId])).toEqual([
    ['partial', 'first question', 'A'], ['partial', 'next question', 'B'],
    ['segment', 'first question?', 'A'], ['segment', 'next question?', 'B'],
  ]);
});

it('keeps queued batch transcriptions with their original interview when capture moves on', async () => {
  const { CloudAsrEngine } = await import('../electron/asr/cloudEngine');
  const transcribe = vi.spyOn(CloudAsrEngine.prototype, 'transcribe')
    .mockResolvedValueOnce({ text: 'previous interview', inferMs: 10 })
    .mockResolvedValueOnce({ text: 'current interview', inferMs: 10 });
  const { send } = await boot(false, 'cloud');
  for (const sessionId of ['A', 'B']) {
    send({ type: 'pcm', channel: 'me', sessionId, captureTs: Date.now(),
      pcm: new Float32Array(4800).fill(0.2) });
    vi.advanceTimersByTime(300);
  }
  send({ type: 'flush' });
  await vi.advanceTimersByTimeAsync(0);
  expect(transcribe).toHaveBeenCalledTimes(2);
  const finals = state.port.postMessage.mock.calls.map(([event]) => event).filter(event => event.type === 'segment');
  expect(finals.map(event => [event.sessionId, event.text])).toEqual([['A', 'previous interview'], ['B', 'current interview']]);
  transcribe.mockRestore();
});

it('reopens after a capture gap and ignores results from the old audio timeline', async () => {
  const { frame } = await boot(); frame();
  const old = state.sessions[0];
  vi.advanceTimersByTime(1500); frame();
  expect(state.sessions).toHaveLength(2); expect(old.close).toHaveBeenCalledOnce();
  const before = state.port.postMessage.mock.calls.length;
  old.callbacks.onSentence({ text: 'late stale sentence', beginMs: 100, endMs: 200 });
  expect(state.port.postMessage.mock.calls.length).toBe(before);
  state.sessions[1].callbacks.onSentence({ text: 'new sentence', beginMs: 0, endMs: 100 });
  expect(state.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'segment', speechEndTs: 101500, timingValid: true }));
});

it('uses bounded retries, stops sending after capture stop, and resets on explicit restart', async () => {
  const { send, frame, frames } = await boot(); frame();
  state.sessions[0].callbacks.onError('unexpected close'); frames(9); expect(state.sessions).toHaveLength(1);
  frames(2); expect(state.sessions).toHaveLength(2);
  state.sessions[1].callbacks.onError('handshake failure'); frames(21); expect(state.sessions).toHaveLength(3);
  state.sessions[2].callbacks.onError('failure again'); frames(100); expect(state.sessions).toHaveLength(3);
  send({ type: 'capture', channel: 'them', active: false });
  const pushes = state.sessions[2].push.mock.calls.length; frames(20);
  expect(state.sessions).toHaveLength(3); expect(state.sessions[2].push.mock.calls.length).toBe(pushes);
  send({ type: 'capture', channel: 'them', active: true }); frame(); expect(state.sessions).toHaveLength(4);
});

it('retains all incoming frames during the retry delay in capture order', async () => {
  const { send, frame } = await boot(); frame();
  state.sessions[0].callbacks.onError('connection lost', [new Float32Array(1600).fill(-1)]);
  for (let i = 1; i <= 10; i++) {
    vi.advanceTimersByTime(100);
    send({ type: 'pcm', pcm: new Float32Array(1600).fill(i), captureTs: Date.now(), channel: 'them' });
  }
  expect(state.sessions[1].push.mock.calls.map(([pcm]) => pcm[0])).toEqual([-1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

it('drains retry audio on stop and excludes late frames', async () => {
  const { send, frame, frames } = await boot(true);
  send({ type: 'capture', channel: 'them', active: true });
  frame();
  state.sessions[0].callbacks.onError('failed to start', [new Float32Array(1600)]);
  frames(4);
  send({ type: 'capture', channel: 'them', active: false });
  frame();
  expect(state.sessions).toHaveLength(2);
  expect(state.sessions[1].push).toHaveBeenCalledTimes(5);
  expect(state.sessions[1].close).toHaveBeenCalledOnce();
});

it('keeps the microphone running when system capture stops and ignores blocked audio', async () => {
  const { send, frame } = await boot(); frame('them'); frame('me');
  send({ type: 'capture', channel: 'them', active: false });
  expect(state.sessions[0].close).toHaveBeenCalledOnce(); expect(state.sessions[1].close).not.toHaveBeenCalled();
  frame('them'); frame('me'); expect(state.sessions[1].push).toHaveBeenCalledTimes(2);
  // Do not invoke shutdown in-process (it exits the worker); blocked channels
  // exercise the same late-frame guard used during stop.
  send({ type: 'capture', channel: 'me', active: false }); frame('me'); expect(state.sessions).toHaveLength(2);
});

it('tracks first text separately and marks invalid service timestamps unknown', async () => {
  const { frame } = await boot(); frame();
  vi.advanceTimersByTime(100); frame();
  state.sessions[0].callbacks.onPartial('first', { beginMs: 100 });
  vi.advanceTimersByTime(100); frame();
  state.sessions[0].callbacks.onSentence({ text: 'final', beginMs: 100, endMs: 200 });
  expect(state.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ firstTextTs: 100100, speechStartTs: 100000, speechEndTs: 100100, timingValid: true, timingKind: 'stream' }));
  state.sessions[0].callbacks.onSentence({ text: 'invalid times', beginMs: 0, endMs: 30000 });
  expect(state.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ timingValid: false, firstTextTs: undefined }));
});
