/**
 * Vision (R5) transport — MAIN PROCESS ONLY (imports electron).
 *
 * Screenshot Q&A requires a provider that accepts image input. Blank proxy
 * configuration uses an explicitly direct session; configured proxies use
 * their dedicated Electron session. Answer content can also stream to the UI.
 */
import { net, session, type Session } from 'electron';
import { StringDecoder } from 'node:string_decoder';
import { SseParser, extractDelta, toProxyRules, type ChatMessage } from './adapter';

/** Only final answer content is displayed. */
function extractVisionText(jsonBody: string): string {
  try {
    const j = JSON.parse(jsonBody);
    const m = j?.choices?.[0]?.message ?? {};
    return (m.content ?? '').trim();
  } catch {
    return '';
  }
}

export interface VisionConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** e.g. '127.0.0.1:7897'; empty => direct */
  proxyUrl?: string;
}

const routeSessions = new Map<string, Promise<Session>>();

/**
 * Keep the direct route separate from system and configured proxy sessions.
 */
async function pickSession(rules: string): Promise<Session> {
  let ready = routeSessions.get(rules);
  if (!ready) {
    const name = rules ? `vision-proxy-${routeSessions.size}` : 'vision-direct';
    ready = (async () => {
      const target = session.fromPartition(name);
      await target.setProxy(rules ? { mode: 'fixed_servers', proxyRules: rules } : { mode: 'direct' });
      return target;
    })();
    routeSessions.set(rules, ready);
    void ready.catch(() => routeSessions.delete(rules));
  }
  return ready;
}

export async function visionChat(
  config: VisionConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
  options?: { maxTokens?: number; temperature?: number; onSend?: (sentAt: number) => void; retryWithoutStream?: boolean },
): Promise<string> {
  signal?.throwIfAborted();
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({ model: config.model, messages, stream: !!onDelta,
    ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const rules = toProxyRules(config.proxyUrl);
  const ses = await pickSession(rules);

  const raw = await new Promise<{ status: number; body: string; streaming: boolean }>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const req = net.request({ method: 'POST', url, session: ses });
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('Authorization', `Bearer ${config.apiKey}`);
    const onAbort = () => { req.abort(); reject(signal?.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('response', (res) => {
      let data = '';
      const streaming = !!onDelta && res.statusCode >= 200 && res.statusCode < 300 &&
        /text\/event-stream/i.test(String(res.headers['content-type'] ?? ''));
      const parser = new SseParser();
      const decoder = new StringDecoder('utf8');
      res.on('data', (c) => {
        if (signal?.aborted) return;
        const chunk = decoder.write(c);
        if (!streaming) { data += chunk; return; }
        for (const payload of parser.push(chunk)) {
          const text = extractDelta(payload);
          if (text && !signal?.aborted) { data += text; onDelta!(text); }
        }
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('模型输出连接中断，请重试。')));
      res.on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        if (streaming && !parser.done) { reject(new Error('模型输出连接中断，请重试。')); return; }
        resolve({ status: res.statusCode ?? 0, body: data, streaming });
      });
    });
    req.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    options?.onSend?.(Date.now());
    req.write(body);
    req.end();
  });

  if (raw.status < 200 || raw.status >= 300) {
    // A rejected stream option precedes answer content. Keep timing from the first send.
    if (onDelta && options?.retryWithoutStream && (raw.status === 400 || raw.status === 422) &&
        /stream(?:ing)?["'`\s:]*(?:(?:is|mode is)\s+)?(?:not supported|unsupported|must be false)|(?:does not support|unsupported parameter[:\s"']+)\s*stream/i.test(raw.body)) {
      const text = await visionChat(config, messages, signal, undefined, { ...options, onSend: undefined });
      signal?.throwIfAborted();
      onDelta(text);
      return text;
    }
    throw new Error(`Vision HTTP ${raw.status}: ${raw.body.slice(0, 300)}`);
  }
  const text = raw.streaming ? raw.body : extractVisionText(raw.body);
  if (!text) throw new Error('视觉模型未返回最终答案，请重试或检查模型设置。');
  if (!raw.streaming && !signal?.aborted) onDelta?.(text);
  return text;
}
