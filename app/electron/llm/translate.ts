import { bankAnswerText, hasEnglishSpeech, parseBankAnswer, splitSpokenAnswer, validAnswerLanguages } from '../../shared/interviewBank';
import type { SettingsStore } from '../settings';
import { redactSecrets } from '../../shared/redact';
import { interviewService } from '../../shared/interviewService';
import { buildTranslateMessages, buildMemoUpdateMessages, clampMemo } from './prompts';
import { chatStream, chatOnce, type ChatMessage } from './adapter';
import { visionChat } from './vision';

export async function interviewChat(settings: SettingsStore, messages: ChatMessage[], noApiKeyMessage: string,
  signal?: AbortSignal, memo = false): Promise<string> {
  signal?.throwIfAborted();
  const target = interviewService(settings.getPublic());
  if (!target) throw new Error('没有可用的面试接口，请在设置中启用接口并配置地址、模型和密钥。 / No enabled interview service is configured.');
  const apiKey = target.id === 'llm' ? settings.getLlmApiKey() : settings.getVisionApiKey(target.id);
  if (!apiKey) throw new Error(noApiKeyMessage);
  const config = { baseUrl: target.config.baseUrl!, model: target.config.model!, apiKey };
  try {
    if (target.id !== 'llm') {
      return await visionChat({ ...config, proxyUrl: 'proxyUrl' in target.config ? target.config.proxyUrl : undefined },
        messages, signal, undefined, memo ? { maxTokens: 700, temperature: 0.2 } : undefined);
    }
    if (memo) return (await chatOnce(config, messages, { maxTokens: 700, temperature: 0.2, signal })).text;
    return (await chatStream(config, messages, { onDelta: () => {} }, signal)).text;
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(redactSecrets((e as Error).message.split(apiKey).join('[redacted]')));
  }
}

/** Make at most one repair request, using the same provider that produced the answer. */
export async function completeBilingualAnswer(text: string, request: (messages: ChatMessage[]) => Promise<string>) {
  const { english, chinese } = splitSpokenAnswer(text);
  if (validAnswerLanguages(english, chinese)) return bankAnswerText({ english, chinese, materialKey: '' }, 'english');
  const repaired = hasEnglishSpeech(english)
    ? english + '\n\n中文翻译：\n' + await request(buildTranslateMessages(english))
    : await request([{ role: 'system', content: '将给定的面试回答整理为可直接念出的英文答案，再以「中文翻译：」单独起行给出完整简体中文翻译。仅保留回答事实，不添加建议或备注。' }, { role: 'user', content: text }]);
  return bankAnswerText(parseBankAnswer(repaired, ''), 'english');
}

/** Stream English immediately; hold a possible section heading until its role is clear. */
export function interviewDelta(bilingual: boolean, send: (text: string) => void) {
  let buffer = '', sent = 0;
  return (delta: string) => {
    if (!bilingual) { send(delta); return; }
    buffer += delta;
    const { english } = splitSpokenAnswer(buffer);
    const lineStart = english.lastIndexOf('\n') + 1;
    const tail = english.slice(lineStart).trimStart().replace(/^[#*【\s]+/, '').toLowerCase();
    const heading = ['english answer', 'chinese translation', 'notes', 'interview tips', '中文翻译', '中文备注', '中文译文', '提示', '建议'];
    const preview = heading.some((label) => label.startsWith(tail)) || /^\p{Script=Han}/u.test(tail)
      ? english.slice(0, lineStart).trimEnd() : english;
    if (preview.length <= sent || !hasEnglishSpeech(preview)) return;
    send(preview.slice(sent));
    sent = preview.length;
  };
}

export function translateTranscript(settings: SettingsStore, text: string, noApiKeyMessage: string, signal?: AbortSignal): Promise<string> {
  return interviewChat(settings, buildTranslateMessages(text), noApiKeyMessage, signal);
}

export async function updateInterviewMemo(settings: SettingsStore, memo: string, question: string, answer: string,
  noApiKeyMessage: string, signal?: AbortSignal): Promise<string> {
  return clampMemo(await interviewChat(settings, buildMemoUpdateMessages(memo, question, answer), noApiKeyMessage, signal, true));
}
