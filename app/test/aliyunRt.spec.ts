import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { AliyunRealtimeEngine, f32ToPcm16, languageHints, parseServerEvent } from '../electron/asr/aliyunRealtimeEngine';

describe('f32ToPcm16', () => {
  it('converts and clamps float32 to int16 LE', () => {
    const buf = f32ToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    expect(buf.length).toBe(12);
    expect(buf.readInt16LE(0)).toBe(0);
    expect(buf.readInt16LE(2)).toBe(0x7fff);
    expect(buf.readInt16LE(4)).toBe(-0x8000);
    expect(buf.readInt16LE(6)).toBe(Math.floor(0.5 * 0x7fff));
    expect(buf.readInt16LE(8)).toBe(0x7fff); // clamped
    expect(buf.readInt16LE(10)).toBe(-0x8000); // clamped
  });

  it('handles empty input', () => {
    expect(f32ToPcm16(new Float32Array(0)).length).toBe(0);
  });
});

describe('languageHints', () => {
  it('maps explicit languages and omits for auto', () => {
    expect(languageHints('chinese')).toEqual(['zh']);
    expect(languageHints('english')).toEqual(['en']);
    expect(languageHints('auto')).toBeUndefined();
    expect(languageHints(undefined)).toBeUndefined();
  });
});

describe('parseServerEvent', () => {
  it('parses a result-generated payload', () => {
    const ev = parseServerEvent(
      JSON.stringify({
        header: { event: 'result-generated', task_id: 't1' },
        payload: {
          output: {
            sentence: { begin_time: 170, end_time: 920, text: '好，我知道了', sentence_end: true },
          },
        },
      }),
    );
    expect(ev?.header?.event).toBe('result-generated');
    expect(ev?.payload?.output?.sentence?.sentence_end).toBe(true);
    expect(ev?.payload?.output?.sentence?.text).toBe('好，我知道了');
  });

  it('parses task-failed error fields', () => {
    const ev = parseServerEvent(
      JSON.stringify({
        header: { event: 'task-failed', error_code: 'CLIENT_ERROR', error_message: 'request timeout' },
        payload: {},
      }),
    );
    expect(ev?.header?.error_code).toBe('CLIENT_ERROR');
  });

  it('returns null on garbage', () => {
    expect(parseServerEvent('not json')).toBeNull();
    expect(parseServerEvent('42')).toBeNull();
  });
});

it('recovers only unsent startup PCM after a socket close and drains it before finish-task', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const frames: Buffer[] = [];
  let attempts = 0;
  let finished = false;
  server.on('connection', socket => {
    const attempt = ++attempts;
    socket.on('message', (data, binary) => {
      if (binary) { frames.push(Buffer.from(data as Buffer)); return; }
      const action = JSON.parse(data.toString()).header.action;
      if (attempt === 1) socket.close();
      else if (action === 'run-task') socket.send(JSON.stringify({ header: { event: 'task-started' } }));
      else if (action === 'finish-task') {
        finished = true;
        socket.send(JSON.stringify({ header: { event: 'task-finished' } }));
      }
    });
  });
  try {
    const engine = await AliyunRealtimeEngine.load({
      baseUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'mock', apiKey: '',
    });
    const pcm = [0.1, -0.2, 0.3].map(value => new Float32Array(320).fill(value));
    const callbacks = { onSentence() {}, onPartial() {} };
    const recovered = await new Promise<Float32Array[]>(resolve => {
      const s = engine.openSession({ ...callbacks, onError: (_, unsent) => resolve([...(unsent ?? [])]) });
      s.push(pcm[0]); s.push(pcm[1]);
    });
    expect(recovered).toEqual(pcm.slice(0, 2));
    const retry = engine.openSession({ ...callbacks, onError: () => {} }, { recoveredAudio: recovered });
    retry.push(pcm[2]);
    const closing = retry.close();
    retry.push(new Float32Array([1]));
    await closing;
    expect(frames).toEqual(pcm.map(f32ToPcm16));
    expect(finished).toBe(true);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
