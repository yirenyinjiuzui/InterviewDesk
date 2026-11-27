import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeSession {
  name: string;
  ready: boolean;
  proxy?: Record<string, string>;
  setProxy(options: Record<string, string>): Promise<void>;
}
interface RequestRecord {
  options: { session: FakeSession; url: string };
  body: string;
  headers: Record<string, string>;
  aborted: boolean;
  sessionReadyAtRequest: boolean;
}
const state = vi.hoisted(() => ({ requests: [] as RequestRecord[], sessions: [] as FakeSession[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    session: { fromPartition(name: string) {
      const target: FakeSession = { name, ready: false, async setProxy(options) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        target.proxy = options;
        target.ready = true;
      } };
      state.sessions.push(target);
      return target;
    } },
    net: { request(options: RequestRecord['options']) {
      const record: RequestRecord = { options, body: '', headers: {}, aborted: false, sessionReadyAtRequest: options.session.ready };
      const request = Object.assign(new EventEmitter(), {
        setHeader(name: string, value: string) { record.headers[name] = value; },
        write(body: string) { record.body = body; },
        abort() { record.aborted = true; },
        end() {
          state.requests.push(record);
          const model = JSON.parse(record.body).model;
          if (model === 'pending') return;
          queueMicrotask(() => {
            const streaming = model.startsWith('stream-');
            const response = Object.assign(new EventEmitter(), {
              statusCode: model === 'broken' ? 403 : model === 'json-only' && JSON.parse(record.body).stream ? 400 : 200,
              headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
            });
            request.emit('response', response);
            if (response.statusCode === 400) {
              response.emit('data', Buffer.from('{"error":"Streaming is not supported"}'));
              response.emit('end');
              return;
            }
            if (streaming) {
              const first = Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n\ndata: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
              for (const byte of first) response.emit('data', Buffer.from([byte]));
              setTimeout(() => {
                response.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"世界"}}]}\n\n'));
                if (model !== 'stream-cutoff') response.emit('data', Buffer.from('data: [DONE]\n\n'));
                response.emit('end');
              }, 10);
              return;
            }
            response.emit('data', Buffer.from(model === 'broken' ? 'Permission denied' : JSON.stringify({ choices: [{ message: { content: model } }] })));
            response.emit('end');
          });
        },
      });
      return request;
    } },
  };
});

beforeEach(() => { state.requests = []; state.sessions = []; vi.resetModules(); });

describe('concurrent vision transport', () => {
  it('shows UTF-8 answer deltas before completion without exposing reasoning', async () => {
    const { visionChat } = await import('../electron/llm/vision');
    const deltas: string[] = [];
    let completed = false;
    const result = visionChat({ baseUrl: 'https://fixture/v1', model: 'stream-good', apiKey: 'fixture' }, [], undefined, (text) => {
      expect(completed).toBe(false);
      deltas.push(text);
    }).then((text) => { completed = true; return text; });
    expect(await result).toBe('你好世界');
    expect(deltas).toEqual(['你好', '世界']);
    expect(JSON.parse(state.requests[0].body).stream).toBe(true);
  });

  it('preserves memo generation limits on the selected model transport', async () => {
    const { visionChat } = await import('../electron/llm/vision');
    await visionChat({ baseUrl: 'https://fixture/v1', model: 'good', apiKey: 'fixture' }, [], undefined, undefined, { maxTokens: 700, temperature: 0.2 });
    expect(JSON.parse(state.requests[0].body)).toMatchObject({ max_tokens: 700, temperature: 0.2, stream: false });
  });

  it('falls back once on an explicit stream rejection and keeps the first send timestamp', async () => {
    const { visionChat } = await import('../electron/llm/vision');
    const onDelta = vi.fn(), onSend = vi.fn();
    await visionChat({ baseUrl: 'https://fixture/v1', model: 'json-only', apiKey: 'fixture' }, [], undefined, onDelta, { retryWithoutStream: true, onSend });
    expect(state.requests.map(req => JSON.parse(req.body).stream)).toEqual([true, false]);
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('json-only');
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('supports a JSON response when streaming was requested', async () => {
    const { visionChat } = await import('../electron/llm/vision');
    const onDelta = vi.fn();
    expect(await visionChat({ baseUrl: 'https://fixture/v1', model: 'good', apiKey: 'fixture' }, [], undefined, onDelta)).toBe('good');
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('good');
  });

  it('rejects an unfinished stream and stops deltas after cancellation', async () => {
    const { visionChat } = await import('../electron/llm/vision');
    await expect(visionChat({ baseUrl: 'https://fixture/v1', model: 'stream-cutoff', apiKey: 'fixture' }, [], undefined, () => {})).rejects.toThrow('连接中断');
    const controller = new AbortController();
    const onDelta = vi.fn(() => controller.abort());
    await expect(visionChat({ baseUrl: 'https://fixture/v1', model: 'stream-good', apiKey: 'fixture' }, [], controller.signal, onDelta)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onDelta).toHaveBeenCalledOnce();
  });

  it('waits for route initialization and isolates different model proxies', async () => {
    const { visionChat } = await import('../electron/llm/vision');
    const configs = ['direct-one', 'direct-two', 'proxy-one', 'proxy-two'].map((model, index) => ({
      baseUrl: `https://provider-${index}.example/v1`, model, apiKey: `fixture-${index}`,
      ...(index > 1 ? { proxyUrl: `127.0.0.1:${7800 + index}` } : {}),
    }));
    expect(await Promise.all(configs.map((config) => visionChat(config, [])))).toEqual(configs.map((config) => config.model));
    expect(state.sessions).toHaveLength(3);
    expect(state.requests.every((request) => request.sessionReadyAtRequest)).toBe(true);
    expect(state.requests[0].options.session).toBe(state.requests[1].options.session);
    expect(state.requests[2].options.session).not.toBe(state.requests[3].options.session);
    for (const request of state.requests) {
      const index = configs.findIndex((config) => request.options.url.startsWith(config.baseUrl));
      expect(request.headers.Authorization).toBe(`Bearer fixture-${index}`);
      if (index < 2) expect(request.options.session.proxy).toEqual({ mode: 'direct' });
      else expect(request.options.session.proxy?.proxyRules).toContain(`127.0.0.1:${7800 + index}`);
    }
  });

  it('lets healthy models finish even when another provider rejects the request', async () => {
    const { visionChat } = await import('../electron/llm/vision');
    const results = await Promise.allSettled(['good-one', 'broken', 'good-two'].map((model) => visionChat({ baseUrl: 'https://fixture/v1', model, apiKey: 'fixture' }, [])));
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(results[0]).toMatchObject({ value: 'good-one' });
    expect(results[2]).toMatchObject({ value: 'good-two' });
  });

  it('aborts every pending model and rejects pre-cancelled work before sending', async () => {
    const { visionChat } = await import('../electron/llm/vision');
    const cancelled = new AbortController(); cancelled.abort();
    await expect(visionChat({ baseUrl: 'https://fixture/v1', model: 'pending', apiKey: 'fixture' }, [], cancelled.signal)).rejects.toThrow();
    expect(state.requests).toHaveLength(0);
    const controllers = [new AbortController(), new AbortController()];
    const requests = controllers.map((controller) => visionChat({ baseUrl: 'https://fixture/v1', model: 'pending', apiKey: 'fixture' }, [], controller.signal));
    const settled = Promise.allSettled(requests);
    while (state.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    controllers.forEach((controller) => controller.abort());
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
    expect(state.requests.every((request) => request.aborted)).toBe(true);
  });
});
