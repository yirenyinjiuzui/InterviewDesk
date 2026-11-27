import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { AliyunRealtimeEngine } from '../electron/asr/aliyunRealtimeEngine';
import type { AsrTimingRecord } from '../electron/asr/streamTiming';

it('records buffered and live frame sends and keeps partial timings separate for consecutive sentences', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  try {
    const receivedSamples: number[] = [];
    let taskId = '';
    let peer!: WebSocket;
    server.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (data, binary) => {
        if (binary && Buffer.isBuffer(data)) {
          receivedSamples.push(data.length / 2);
          return;
        }
        const { header } = JSON.parse(data.toString());
        if (header.action === 'run-task') taskId = header.task_id;
        if (header.action === 'finish-task') socket.send(JSON.stringify({ header: { event: 'task-finished' } }));
      });
    });

    const records: AsrTimingRecord[] = [];
    const errors: string[] = [];
    const config = { baseUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/private-route`, model: 'fixture', apiKey: 'fixture-private-key' };
    const engine = await AliyunRealtimeEngine.load(config, (record) => records.push(record));
    const session = engine.openSession({ onPartial() {}, onSentence() {}, onError: (error) => errors.push(error) });
    session.push(new Float32Array(320));
    session.push(new Float32Array(160));
    await vi.waitFor(() => expect(taskId).toBeTruthy());
    expect(records.map((record) => record.event)).toEqual(['connect', 'open']);
    expect(receivedSamples).toEqual([]);

    peer.send(JSON.stringify({ header: { event: 'task-started' } }));
    await vi.waitFor(() => expect(receivedSamples).toEqual([320, 160]));
    session.push(new Float32Array(320).fill(0.25));
    await vi.waitFor(() => expect(receivedSamples).toEqual([320, 160, 320]));

    function sentence(beginMs: number, endMs: number, text: string, final: boolean) {
      peer.send(JSON.stringify({
        header: { event: 'result-generated' },
        payload: { output: { sentence: { begin_time: beginMs, end_time: endMs, text, sentence_end: final } } },
      }));
    }
    sentence(0, 10, 'private-transcript-partial', false);
    await vi.waitFor(() => expect(records.some((record) => record.event === 'first-partial')).toBe(true));
    sentence(0, 22, 'private-transcript-revision', false);
    sentence(0, 30, 'private-transcript-one', true);
    sentence(30, 50, 'private-transcript-two', true);
    await vi.waitFor(() => expect(records.filter((record) => record.event === 'segment')).toHaveLength(2));
    await session.close();
    await vi.waitFor(() => expect(records.at(-1)?.event).toBe('close'));

    expect(errors).toEqual([]);
    expect(records.every((record) => record.taskId === taskId)).toBe(true);
    const phases = records.filter((record) => record.event !== 'audio');
    expect(phases.map((record) => record.event)).toEqual(['connect', 'open', 'task-started', 'first-partial', 'segment', 'segment', 'close']);
    const times = phases.map((record) => record.at);
    expect(times.every(Number.isFinite)).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const [, , started, partial, firstSentence, secondSentence, closed] = phases;

    const frames = records.flatMap((record) => record.event === 'audio' ? record.frames : []);
    expect(frames.map((frame) => frame.endSample)).toEqual([320, 480, 800]);
    for (const frame of frames) {
      expect(frame.sentAt).toBeGreaterThanOrEqual(started.at);
      expect(frame.sentAt).toBeLessThanOrEqual(partial.at);
    }
    expect(firstSentence).toMatchObject({ beginMs: 0, endMs: 30, firstPartialAt: partial.at });
    expect(secondSentence).toMatchObject({ beginMs: 30, endMs: 50, firstPartialAt: null });
    expect(closed).toMatchObject({ firstFrameSentAt: frames[0].sentAt, lastFrameSentAt: frames[2].sentAt });
    expect(JSON.stringify(records)).not.toMatch(/private-transcript|private-key|private-route/);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
