import type { InterviewBankAnswer, InterviewLibrary, PersonalInfo } from './protocol';
import { PERSONAL_INFO_CATEGORIES } from './sessionMaterials';

/** Invalidate prepared answers when the actual resume, JD or confirmed facts change. */
export function bankMaterialKey(resume = '', jd = '', info?: PersonalInfo): string {
  const text = JSON.stringify([resume.trim(), jd.trim(), Object.keys(PERSONAL_INFO_CATEGORIES).map((key) => {
    const entry = info?.[key as keyof PersonalInfo];
    return [entry?.confirmed.trim() ?? '', entry?.pending.trim() ?? ''];
  })]);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}

const translationHeading = /(?:^|\n)\s*[#*【\s]*(?:中文翻译|中文译文|Chinese translation)\s*(?:】|[:：]|\n|$)[* \t]*/i;
const noteHeading = /(?:^|\n|(?<=[。.!?！？])\s*)[ \t#*【]*(?:中文备注|备注|提示|建议|补充说明|面试小贴士|interview tips?|notes?)\s*[:：】][* \t]*/i;

export function splitSpokenAnswer(text: string) {
  const [spoken, translation = ''] = text.split(translationHeading);
  const english = spoken.split(noteHeading)[0].replace(/^\s*[*#【]*(?:英文答案|English answer|Answer in English)\s*[:：】][*\s]*/i, '').trim();
  return { english, chinese: translation.split(noteHeading)[0].trim() };
}

export function hasEnglishSpeech(text: string): boolean {
  const words = text.match(/[a-z]{2,}|\b[ai]\b/gi)?.length ?? 0;
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  return words > 0 && (han === 0 || words > han);
}

export function validAnswerLanguages(english: string, chinese: string): boolean {
  return hasEnglishSpeech(english) && /\p{Script=Han}/u.test(chinese);
}

export function parseBankAnswer(text: string, materialKey: string): InterviewBankAnswer {
  const { english, chinese } = splitSpokenAnswer(text);
  if (!validAnswerLanguages(english, chinese)) {
    throw new Error('服务未返回完整英文答案和中文翻译，请重试。');
  }
  return { english, chinese, materialKey };
}

export function bankAnswerText(answer: InterviewBankAnswer, lang: 'english' | 'chinese'): string {
  return lang === 'english' ? `${answer.english.trim()}\n\n中文翻译：\n${answer.chinese.trim()}` : answer.chinese.trim();
}

/** Only these built-in prompts have a deliberately job-independent preparation. */
const reusableQuestions = new Set([
  '介绍你最熟悉的项目，你具体负责什么？ / Describe your project and your own contribution.',
  '讲一次失败或犯错，以及你学到了什么。 / Tell me about a failure and what you learned.',
  '解释 RAG 的流程，以及如何评估检索质量。 / Explain RAG and retrieval evaluation.',
  '如何减少大模型幻觉？ / How would you reduce LLM hallucinations?',
  '训练集、验证集和测试集有什么区别？ / Explain training, validation and test sets.',
  '解释一个你熟悉的算法及时间复杂度。 / Explain an algorithm and its complexity.',
]);
export function prepareWithoutJob(question: string) { return reusableQuestions.has(question); }
export function generalBankKey(resume?: string, info?: PersonalInfo) { return 'general:' + bankMaterialKey(resume, '', info); }

export function answerForMaterial(library: Pick<InterviewLibrary, 'answers' | 'answerHistory'>, question: string, materialKey: string, generalKey?: string) {
  const latest = library.answers?.[question];
  const history = library.answerHistory;
  const versions = [latest, ...(history && Object.hasOwn(history, question) ? history[question] : [])];
  return versions.find((a) => a?.materialKey === materialKey)
    ?? (generalKey && prepareWithoutJob(question) ? versions.find((a) => a?.materialKey === generalKey) : undefined);
}

export function readyBankAnswers(library: InterviewLibrary, materialKey: string, generalKey?: string) {
  return library.questions.flatMap((question) => {
    const answer = answerForMaterial(library, question, materialKey, generalKey);
    if (!answer || !validAnswerLanguages(answer.english, answer.chinese)) return [];
    const clean = splitSpokenAnswer(bankAnswerText(answer, 'english'));
    return validAnswerLanguages(clean.english, clean.chinese) ? [{ question, answer: { ...answer, ...clean } }] : [];
  });
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/^(?:(?:(?:next question|okay|ok|so|well|please|could you|can you|would you)\b|接下来|下一个问题|请问|请)[,，:：\s]*)+/i, '')
    .replace(/\.(?=\s|$)/gu, '').replace(/[\s,!?，。！？、:：;；“”"‘’']+/gu, '');
}
function questionAliases(text: string): string[] {
  // Slashes inside a technical term (TCP/IP, CI/CD) belong to the question.
  return text.split(/\s+\/\s*|\s*\/\s+|(?<=[?!？。！])\/|(?<=[\p{Script=Han}])\/(?=[a-z])|(?<=[a-z])\/(?=[\p{Script=Han}])|\n|\s+\|\s+/iu);
}

export function compatibleBankTerms(question: string, entry: string): boolean {
  const tokens = (s: string) => (s.toLowerCase().match(/\bc(?:\+\+|#)(?!\w)|[<>]=?|[!=]=/g) ?? []).sort().join(' ');
  return questionAliases(entry).some((alias) => tokens(alias) === tokens(question));
}

function technicalSymbols(text: string): string { return text.replace(/[\p{L}\p{N}]/gu, ''); }
function grams(text: string): Set<string> { return new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2))); }

/** Exact aliases, then conservative near-duplicates; ambiguous and follow-up questions miss. */
export function matchBankAnswer(question: string, library: InterviewLibrary, materialKey: string, generalKey?: string) {
  const needle = normalize(question);
  if (!needle) return;
  const ranked = readyBankAnswers(library, materialKey, generalKey).map((entry) => ({ ...entry, score: Math.max(...questionAliases(entry.question).map((alias) => {
    const text = normalize(alias);
    if (text === needle) return 1;
    if (needle.length < 6 || text.length < 6 || technicalSymbols(text) !== technicalSymbols(needle)) return 0;
    if (!text || Math.min(text.length, needle.length) / Math.max(text.length, needle.length) < 0.85) return 0;
    // Do not collapse differing numbers or negated variants into a cached answer.
    if (JSON.stringify(text.match(/\d+/g)) !== JSON.stringify(needle.match(/\d+/g))) return 0;
    if (/\b(?:not|never|without)\b|不|没|无法|不能/i.test(question) !== /\b(?:not|never|without)\b|不|没|无法|不能/i.test(alias)) return 0;
    const a = grams(needle), b = grams(text);
    return 2 * [...a].filter((v) => b.has(v)).length / (a.size + b.size);
  })) })).sort((a, b) => b.score - a.score);
  if (ranked[0]?.score === 1) return ranked[1]?.score === 1 ? undefined : ranked[0];
  if (ranked[0]?.score >= 0.9 && (!ranked[1] || ranked[0].score - ranked[1].score >= 0.08)) return ranked[0];
}
