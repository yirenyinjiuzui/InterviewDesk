import { appendSegment, type TranscriptSegment } from './transcript';
import { isLikelyQuestion, isOnlySmalltalk } from './textHeuristics';

export interface InterviewQuestionState {
  block?: TranscriptSegment;
  closed?: boolean;
  editedText?: string;
  handledKey?: string;
  seen: TranscriptSegment[];
}
export const emptyQuestion = (): InterviewQuestionState => ({ seen: [] });
const normalize = (text: string) => text.toLowerCase().replace(/[\s.,!?，。！？]/g, '');
export function questionKey(state: InterviewQuestionState): string {
  return state.block ? `${state.block.startTs}:${normalize(state.editedText ?? state.block.text)}` : '';
}

/** Final ASR events may be replayed; do not append them to transcript or retrigger. */
export function isDuplicateFinal(state: InterviewQuestionState, seg: TranscriptSegment): boolean {
  return state.seen.some((old) => (old.speaker ?? 'them') === (seg.speaker ?? 'them') &&
    normalize(old.text) === normalize(seg.text) && Math.abs(old.startTs - seg.startTs) <= 750 &&
    Math.abs(old.endTs - seg.endTs) <= 750);
}

/** A brief acknowledgement is still recorded in the transcript. */
export function isAcknowledgement(text: string): boolean {
  return /^(?:ok(?:ay)?|uh[ -]?huh|mm[ -]?hmm|got it|うん|응|嗯+|嗯好|好的?|收到|明白了)$/i.test(text.trim().replace(/[.!?,，。！？、\s]+$/u, ''));
}

// Only suppress a visibility check when the other clauses are setup or narration.
// Keep mixed technical requests, including imperatives without a question mark.
function isScreenCheckOnly(text: string): boolean {
  const check = /(?:^|(?<=[，,。.!！?？;；]))\s*(?:(?:你(?:那边)?|您(?:那边)?)?(?:能+|可以)?看(?:得清(?:楚)?|清(?:楚)?|得到|到)(?:我(?:共享)?的?(?:屏幕|画面))?(?:了)?吗|can you see (?:my|the shared) screen(?: clearly)?)(?:$|[，,。.!！?？;；])/iu;
  if (!check.test(text.trim())) return false;
  const rest = text.trim().replace(check, ' ').replace(/[，,]\s*对吧[？?]/gu, '。');
  const setup = /(?:我(?:来|先)?(?:共享|分享|给你看)|\b(?:let me share|sharing my screen)\b)/iu.test(rest);
  if (!setup && !isOnlySmalltalk(rest.replace(/稍等(?:一下)?|等一下|one moment|hold on/giu, ''))) return false;
  return !isLikelyQuestion(rest) &&
    !/(?:请|找出|指出|解释|分析|设计|验证|实现|排查|比较|对比|演示|举例|讲一下|说一下|\b(?:please|compare|find|identify|review|debug|test|implement|design|show me|walk me through)\b)/iu.test(rest);
}

export const QUESTION_SETTLE_MS = 1100;

export function startsSeparateQuestion(previous: TranscriptSegment, text: string, startTs?: number): boolean {
  // A punctuation mark alone cannot distinguish a follow-up from a qualifier.
  return startTs !== undefined && startTs - previous.endTs >= QUESTION_SETTLE_MS &&
    !/^(?:重点|尤其|具体来说|特别是|specifically\b|in particular\b|with\b)/i.test(text.trim()) &&
    isLikelyQuestion(previous.text) && isLikelyQuestion(text.trim().replace(/[?？.!。！]+$/u, '')) &&
    !isScreenCheckOnly(text);
}

/** Reuse transcript merging, with explicit turn/topic boundaries. No model calls. */
export function advanceQuestion(state: InterviewQuestionState, seg: TranscriptSegment): InterviewQuestionState {
  if (!seg.text.trim() || isDuplicateFinal(state, seg)) return state;
  const seen = [...state.seen.slice(-23), seg];
  if (seg.speaker === 'me') {
    if (state.block && seg.endTs <= state.block.startTs) return { ...state, seen };
    return { ...state, seen, closed: state.closed || !isAcknowledgement(seg.text) };
  }
  if (isOnlySmalltalk(seg.text) || isAcknowledgement(seg.text) || isScreenCheckOnly(seg.text)) return { ...state, seen };
  const topicChange = /(?:next question|moving on|another question|change (?:the )?topic|下一个问题|换个话题|另外一个问题)/i.test(seg.text);
  const merged = state.block && !state.closed && !topicChange && !startsSeparateQuestion(state.block, seg.text, seg.startTs)
    ? appendSegment([state.block], seg) : [seg];
  const continuing = merged.length === 1 && !!state.block && !state.closed && !topicChange && merged[0] !== seg;
  return { block: merged[merged.length - 1], seen, closed: false,
    handledKey: state.handledKey, editedText: continuing ? state.editedText : undefined };
}

export function markQuestionHandled(state: InterviewQuestionState, text: string): InterviewQuestionState {
  const block = state.block ? { ...state.block, text } : { id: -1, text, startTs: Date.now(), endTs: Date.now() };
  const next = { ...state, block, editedText: undefined };
  return { ...next, handledKey: questionKey(next) };
}

export function autoQuestion(state: InterviewQuestionState): string | undefined {
  if (!state.block || state.closed || state.editedText !== undefined || state.handledKey === questionKey(state)) return;
  return isLikelyQuestion(state.block.text) ? state.block.text : undefined;
}

export function actualTranscript(segments: readonly TranscriptSegment[]): string[] {
  return segments.slice(-30).map((seg) => `${seg.speaker === 'me' ? '候选人实际发言 / Candidate' : '面试官实际发言 / Interviewer'}：${seg.text}`);
}
