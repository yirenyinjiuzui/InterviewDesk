import { beforeEach, expect, it, vi } from 'vitest';
import type { SettingsStore } from '../electron/settings';

const calls = vi.hoisted(() => ({ vision: vi.fn(), text: vi.fn(), once: vi.fn() }));
vi.mock('../electron/llm/vision', () => ({ visionChat: calls.vision }));
vi.mock('../electron/llm/adapter', () => ({ chatStream: calls.text, chatOnce: calls.once }));
import { completeBilingualAnswer, interviewDelta, translateTranscript, updateInterviewMemo } from '../electron/llm/translate';

function settings(multimodal = true, enabled = true) {
  return {
    data: { llm: { answerWithVision: multimodal, baseUrl: 'https://old.example/v1', model: 'old-text' } },
    getPublic: () => ({ llm: { answerWithVision: multimodal, baseUrl: 'https://old.example/v1', model: 'old-text', apiKeySet: true }, vision: {
      baseUrl: 'https://disabled.example/v1', model: 'disabled', apiKeySet: true, interviewEnabled: false,
      additional: [{
        baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeySet: true,
        interviewEnabled: enabled, proxyUrl: '127.0.0.1:7897',
      }],
    } }),
    getVisionApiKey: vi.fn(() => 'active-key'),
    getLlmApiKey: vi.fn(() => 'old-key'),
  } as unknown as SettingsStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.vision.mockResolvedValue('你能做兼职吗？');
  calls.text.mockResolvedValue({ text: '文本接口翻译' });
  calls.once.mockResolvedValue({ text: '更新备忘' });
});

it('uses only the first enabled interview provider, its key and its proxy', async () => {
  const s = settings();
  expect(await translateTranscript(s, 'Can you work part time?', 'missing key')).toBe('你能做兼职吗？');
  expect(s.getVisionApiKey).toHaveBeenCalledWith('vision-2');
  expect(s.getLlmApiKey).not.toHaveBeenCalled();
  expect(calls.text).not.toHaveBeenCalled();
  expect(calls.vision).toHaveBeenCalledWith({
    baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
    apiKey: 'active-key', proxyUrl: '127.0.0.1:7897',
  }, expect.arrayContaining([{ role: 'user', content: 'Can you work part time?' }]), undefined, undefined, undefined);
});

it.each([[false, true]])('retains text translation when multimodal=%s and enabled=%s', async (multimodal, enabled) => {
  const s = settings(multimodal, enabled);
  expect(await translateTranscript(s, 'Hello', 'missing key')).toBe('文本接口翻译');
  expect(calls.vision).not.toHaveBeenCalled();
  expect(calls.text).toHaveBeenCalledWith({
    baseUrl: 'https://old.example/v1', model: 'old-text', apiKey: 'old-key',
  }, expect.any(Array), expect.any(Object), undefined);
});

it('reports the missing selected key without switching to an unrelated account', async () => {
  const s = settings();
  vi.mocked(s.getVisionApiKey).mockReturnValue(undefined);
  await expect(translateTranscript(s, 'Hello', 'missing key')).rejects.toThrow('missing key');
  expect(calls.vision).not.toHaveBeenCalled();
  expect(calls.text).not.toHaveBeenCalled();
});


it('does not silently fall back when interview mode has no enabled service', async () => {
  await expect(translateTranscript(settings(true, false), 'Hello', 'missing key')).rejects.toThrow('No enabled interview service');
  expect(calls.text).not.toHaveBeenCalled();
});

it('routes memo updates through the selected interview account and proxy', async () => {
  const s = settings();
  await updateInterviewMemo(s, 'old memo', 'question', 'answer', 'missing key');
  expect(s.getLlmApiKey).not.toHaveBeenCalled();
  expect(s.getVisionApiKey).toHaveBeenCalledWith('vision-2');
  expect(calls.vision).toHaveBeenCalledTimes(1);
  expect(calls.vision).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'active-key', proxyUrl: '127.0.0.1:7897' }),
    expect.any(Array), undefined, undefined, { maxTokens: 700, temperature: 0.2 });
});

it('keeps text mode memo limits and its own credentials', async () => {
  expect(await updateInterviewMemo(settings(false), '', 'q', 'a', 'missing')).toBe('更新备忘');
  expect(calls.once).toHaveBeenCalledWith(expect.objectContaining({ model: 'old-text', apiKey: 'old-key' }),
    expect.any(Array), expect.objectContaining({ maxTokens: 700, temperature: 0.2 }));
  expect(calls.vision).not.toHaveBeenCalled();
});

it('sends only one request when multiple interview services are enabled', async () => {
  const s = settings();
  const data = s.getPublic();
  data.vision.additional!.push({ ...data.vision.additional![0], model: 'another' });
  s.getPublic = () => data;
  await translateTranscript(s, 'Hello', 'missing');
  expect(calls.vision).toHaveBeenCalledTimes(1);
  expect(s.getVisionApiKey).toHaveBeenCalledWith('vision-2');
});

it('does not issue requests after cancellation', async () => {
  const ac = new AbortController();
  ac.abort();
  await expect(translateTranscript(settings(), 'Hello', 'missing', ac.signal)).rejects.toThrow();
  await expect(updateInterviewMemo(settings(), '', 'q', 'a', 'missing', ac.signal)).rejects.toThrow();
  expect(calls.vision).not.toHaveBeenCalled();
  expect(calls.text).not.toHaveBeenCalled();
});

it('forwards cancellation to the selected transport', async () => {
  const ac = new AbortController();
  await translateTranscript(settings(), 'Hello', 'missing', ac.signal);
  expect(calls.vision.mock.calls[0][2]).toBe(ac.signal);
});

it('fails memo updates without using a different account when the selected key is missing', async () => {
  const s = settings();
  vi.mocked(s.getVisionApiKey).mockReturnValue(undefined);
  await expect(updateInterviewMemo(s, '', 'q', 'a', 'missing')).rejects.toThrow('missing');
  expect(calls.vision).not.toHaveBeenCalled();
  expect(calls.once).not.toHaveBeenCalled();
});

it('passes cancellation through text translation and memo requests', async () => {
  const ac = new AbortController();
  await translateTranscript(settings(false), 'Hello', 'missing', ac.signal);
  await updateInterviewMemo(settings(false), '', 'q', 'a', 'missing', ac.signal);
  expect(calls.text.mock.calls[0][3]).toBe(ac.signal);
  expect(calls.once.mock.calls[0][2].signal).toBe(ac.signal);
});

it('does not fall back for memo updates with no enabled interview service', async () => {
  await expect(updateInterviewMemo(settings(true, false), '', 'q', 'a', 'missing')).rejects.toThrow('No enabled interview service');
  expect(calls.once).not.toHaveBeenCalled();
});

it('redacts selected credentials from service errors', async () => {
  calls.vision.mockRejectedValue(new Error('bad account active-key'));
  await expect(translateTranscript(settings(), 'hello', 'missing')).rejects.toThrow('bad account [redacted]');
});

it('keeps only the English answer and its translation, without making another request', async () => {
  const repair = vi.fn();
  const text = 'I built it.\n\n中文翻译：\n我做的。\n中文备注：请微笑。';
  expect(await completeBilingualAnswer(text, repair)).toBe('I built it.\n\n中文翻译：\n我做的。');
  expect(repair).not.toHaveBeenCalled();
});

it('translates just the spoken answer once when the translation is missing', async () => {
  const repair = vi.fn().mockResolvedValue('我做的。');
  expect(await completeBilingualAnswer('I built it.', repair)).toBe('I built it.\n\n中文翻译：\n我做的。');
  expect(repair.mock.calls[0][0].at(-1).content).toBe('I built it.');
  expect(repair).toHaveBeenCalledTimes(1);
});

it('repairs a Chinese-only response once and rejects a second malformed response', async () => {
  const repair = vi.fn().mockResolvedValue('全是中文。');
  await expect(completeBilingualAnswer('我写代码。\n中文翻译：\n我写代码。', repair)).rejects.toThrow();
  expect(repair).toHaveBeenCalledTimes(1);
});

it('streams English before completion and withholds translation and notes until checked', () => {
  const send = vi.fn();
  const push = interviewDelta(true, send);
  for (const chunk of ['I built', ' it.', '\n中文翻', '译：我做的。', '\n中文备注：请微笑。']) push(chunk);
  expect(send.mock.calls.flat().join('')).toBe('I built it.');
});