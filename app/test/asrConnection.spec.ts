import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { AliyunRealtimeEngine } from '../electron/asr/aliyunRealtimeEngine';
const servers: WebSocketServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { for (const client of server.clients) client.terminate(); await new Promise<void>((r) => server.close(() => r())); } });
async function setup(mode: 'close' | 'silent' | 'normal' | 'reject') {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', ...(mode === 'reject' ? { verifyClient: (_: unknown, cb: (ok: boolean, code: number) => void) => cb(false, 401) } : {}) });
  servers.push(server); await new Promise<void>((r) => server.once('listening', r));
  let bytes = 0;
  server.on('connection', (ws) => ws.on('message', (data, binary) => {
    if (binary) { bytes += data instanceof ArrayBuffer ? data.byteLength : Array.isArray(data) ? Buffer.concat(data).length : data.length; return; }
    const msg = JSON.parse(data.toString());
    if (msg.header.action === 'run-task') {
      if (mode === 'close') { ws.close(1011); return; }
      if (mode === 'silent') return;
      ws.send(JSON.stringify({ header: { event: 'task-started' } }));
    } else ws.send(JSON.stringify({ header: { event: 'task-finished' } }));
  }));
  return { server, engine: await AliyunRealtimeEngine.load({ baseUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'fixture', apiKey: '' }), bytes: () => bytes };
}
it.each(['close', 'reject'] as const)('reports %s once and ignores later audio', async (mode) => {
  const { engine, bytes } = await setup(mode); const errors: string[] = [];
  let done!: () => void; const failed = new Promise<void>((r) => done = r);
  const s = engine.openSession({ onPartial() {}, onSentence() {}, onError(e) { errors.push(e); done(); } });
  await failed; s.push(new Float32Array(16000)); await s.close();
  expect(errors).toHaveLength(1); expect(bytes()).toBe(0);
});
it('bounds audio buffered before task-started', async () => {
  const { engine } = await setup('silent'); const errors: string[] = [];
  const s = engine.openSession({ onPartial() {}, onSentence() {}, onError(e) { errors.push(e); } });
  s.push(new Float32Array(16000 * 11)); expect(errors[0]).toContain('backlog'); await s.close();
});
it('gracefully finishes and sends no audio after close', async () => {
  const { engine, bytes } = await setup('normal'); const errors: string[] = [];
  let done!: () => void; const ready = new Promise<void>((r) => done = r);
  const s = engine.openSession({ onReady: () => done(), onPartial() {}, onSentence() {}, onError(e) { errors.push(e); } });
  await ready; s.push(new Float32Array(1600)); await s.close();
  const before = bytes(); s.push(new Float32Array(1600)); expect(bytes()).toBe(before); expect(errors).toEqual([]);
});

it.each(['connecting', 'waiting for task-started'])('drains only pre-stop PCM when stopped while %s', async (stage) => {
  const { engine, server } = await setup('silent');
  const wire: string[] = [];
  let acknowledge!: () => void;
  const requested = new Promise<void>((resolve) => {
    server.once('connection', (ws) => {
      ws.on('message', (data, binary) => {
        if (binary && Buffer.isBuffer(data)) {
          wire.push(data.toString('hex'));
          if (wire.length === 3) ws.send(JSON.stringify({
            header: { event: 'result-generated' },
            payload: { output: { sentence: { text: 'TEST.', sentence_end: true } } },
          }));
        } else {
          const action = JSON.parse(data.toString()).header.action;
          wire.push(action);
          if (action === 'run-task') {
            acknowledge = () => ws.send(JSON.stringify({ header: { event: 'task-started' } }));
            resolve();
          }
        }
      });
    });
  });
  const sentences: string[] = [];
  const errors: string[] = [];
  const session = engine.openSession({
    onPartial() {}, onSentence(s) { sentences.push(s.text); }, onError(e) { errors.push(e); },
  });
  session.push(new Float32Array([1]));
  session.push(new Float32Array([-1]));
  if (stage === 'waiting for task-started') await requested;
  const closed = session.close();
  session.push(new Float32Array([0.5]));
  await requested;
  expect(wire).toEqual(['run-task']);
  acknowledge();
  await closed;
  expect(wire).toEqual(['run-task', 'ff7f', '0080', 'finish-task']);
  expect(sentences).toEqual(['TEST.']);
  expect(errors).toEqual([]);
});


it.each(['capturing', 'stopped with queued PCM'])('bounds a silent task handshake while %s', async (state) => {
  const { engine, bytes } = await setup('silent');
  let failed!: (value: string) => void;
  const failure = new Promise<string>((resolve) => failed = resolve);
  const session = engine.openSession({ onPartial() {}, onSentence() {}, onError(message) { failed(message); } });
  session.push(new Float32Array(320));
  const closing = state === 'stopped with queued PCM' ? session.close() : undefined;
  expect(await failure).toContain('task-started timeout');
  await (closing ?? session.close());
  expect(bytes()).toBe(0);
}, 12000);
