import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { AliyunRealtimeEngine } from '../electron/asr/aliyunRealtimeEngine';

const sockets = vi.hoisted(() => [] as FakeSocket[]);
class FakeSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn<(data: Buffer | string, written?: (err?: Error) => void) => void>();
  terminate = vi.fn();
  close = vi.fn();
  constructor() { super(); sockets.push(this); }
  event(event: string) { this.emit('message', JSON.stringify({ header: { event } }), false); }
}
vi.mock('ws', () => ({ get default() { return FakeSocket; } }));

afterEach(() => { vi.useRealTimers(); sockets.length = 0; });

it('gives a slow handshake its own startup window and drains the last MP3 packet before the final response', async () => {
  const engine = await AliyunRealtimeEngine.load({ baseUrl: 'wss://dashscope.aliyuncs.com/test', model: 'fun-asr-realtime', apiKey: 'fixture' });
  vi.useFakeTimers();
  const onError = vi.fn(), onSentence = vi.fn();
  const session = engine.openSession({ onError, onSentence, onPartial() {} });
  const ws = sockets[0];
  vi.advanceTimersByTime(9800);
  ws.emit('open');
  expect(JSON.parse(String(ws.send.mock.calls[0][0])).payload.parameters.format).toBe('mp3');
  session.push(new Float32Array(1600).fill(0.1));
  vi.advanceTimersByTime(900);
  expect(onError).not.toHaveBeenCalled();
  ws.event('task-started');
  for (let i = 0; i < 19; i++) session.push(new Float32Array(1600).fill(-0.1));
  const closing = session.close();
  const packets = ws.send.mock.calls.map(([data]) => data).filter(Buffer.isBuffer);
  const wire = Buffer.concat(packets);
  expect(wire[0]).toBe(0xff);
  expect(wire.length).toBeGreaterThan(7900);
  expect(wire.length).toBeLessThan(9000);
  const [finish, written] = ws.send.mock.calls.at(-1)!;
  expect(JSON.parse(String(finish)).header.action).toBe('finish-task');
  vi.advanceTimersByTime(4800);
  written!();
  await vi.advanceTimersByTimeAsync(6500);
  expect(ws.terminate).not.toHaveBeenCalled();
  ws.emit('message', JSON.stringify({ header: { event: 'result-generated' }, payload: { output: {
    sentence: { text: '你怎么验证效果？', begin_time: 500, end_time: 1800, sentence_end: true },
  } } }), false);
  ws.event('task-finished');
  await closing;
  expect(onSentence).toHaveBeenCalledWith({ text: '你怎么验证效果？', beginMs: 500, endMs: 1800 });
});
