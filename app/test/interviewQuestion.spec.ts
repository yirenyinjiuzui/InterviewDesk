import { describe, expect, it } from 'vitest';
import { actualTranscript, advanceQuestion, autoQuestion, emptyQuestion, isDuplicateFinal, markQuestionHandled } from '../shared/interviewQuestion';
import { isLikelyQuestion } from '../shared/textHeuristics';
import { buildAnswerMessages, buildMemoUpdateMessages } from '../electron/llm/prompts';
import type { TranscriptSegment } from '../shared/transcript';
const seg = (text: string, startTs = 0, speaker: 'me' | 'them' = 'them'): TranscriptSegment => ({ id: startTs, text, startTs, endTs: startTs + 1000, speaker });

describe('complete interview questions', () => {
  it('keeps the project qualifier with the first question and opens the later follow-up separately', () => {
    const first = advanceQuestion(emptyQuestion(), seg('介绍一下你的项目。', 3000));
    const ack = advanceQuestion(first, seg('嗯。', 4200, 'me'));
    const full = advanceQuestion(ack, seg('重点讲你负责的部分。', 4950));
    expect(autoQuestion(full)).toBe('介绍一下你的项目。重点讲你负责的部分。');
    const handled = markQuestionHandled(full, full.block!.text);
    for (const previous of [full, handled]) {
      const next = advanceQuestion(previous, seg('你怎么验证效果？', 8100));
      expect(autoQuestion(next)).toBe('你怎么验证效果？');
      expect(next.block?.startTs).toBe(8100);
    }
    for (const qualifier of ['尤其是你负责的部分。', '重点讲你是怎么解决问题的。']) {
      expect(advanceQuestion(handled, seg(qualifier, 8100)).block?.startTs).toBe(first.block!.startTs);
    }
  });
  it('keeps a later follow-up open when an earlier microphone result arrives out of order', () => {
    const followup = advanceQuestion(emptyQuestion(), seg('你怎么验证效果？', 9420));
    const lateMic = advanceQuestion(followup, seg('文。', 4820, 'me'));
    expect(autoQuestion(lateMic)).toBe('你怎么验证效果？');
    expect(lateMic.seen.at(-1)?.text).toBe('文。');
  });
  it.each([
    ['Could you describe', 'your most recent project?', 'Could you describe your most recent project?'],
    ['请介绍一下', '你的项目，以及你负责的部分？', '请介绍一下你的项目，以及你负责的部分？'],
    ['What was the challenge?', 'And how did you solve it?', 'What was the challenge? And how did you solve it?'],
  ])('merges nearby fragments: %s', (first, second, full) => {
    const state = advanceQuestion(advanceQuestion(emptyQuestion(), seg(first)), seg(second, 1200));
    expect(state.block?.text).toBe(full);
    expect(autoQuestion(state)).toBe(full);
  });
  it.each(['Hi, can you hear me?', '你好，能听到我说话吗？', 'Thank you for your time.', 'Hi, how are you?', 'Are you ready to start?', '网络还好吗？', '我们这边一直在做这个方向的落地，积累了不少经验和数据，之后希望能有更多的交流与合作。'])('does not answer pleasantries or statements: %s', (text) => {
    expect(autoQuestion(advanceQuestion(emptyQuestion(), seg(text)))).toBeUndefined();
  });
  it.each(['Could you describe', 'Can you tell me about', '请介绍一下'])('waits for a clearly incomplete ask: %s', (text) => {
    expect(autoQuestion(advanceQuestion(emptyQuestion(), seg(text)))).toBeUndefined();
  });
  it.each([
    '嗯，我共享一下示例画面。稍等一下，能看清吗？',
    'Can you see my screen?',
  ])('keeps a screen check from replacing or repeating a handled question: %s', (text) => {
    const pending = advanceQuestion(emptyQuestion(), seg('How would you test login?'));
    const done = markQuestionHandled(pending, pending.block!.text);
    const next = advanceQuestion(done, seg(text, 1700));
    expect(autoQuestion(next)).toBeUndefined();
    expect(next.block).toBe(done.block);
    expect(next.seen.at(-1)?.text).toBe(text);
    expect(advanceQuestion(pending, seg(text, 1700)).block).toBe(pending.block);
  });
  it.each([
    '能看清吗？这段代码有哪些隐患？',
    '请找出登录代码的问题。我共享一下，能看清吗？',
    'Can you explain the loop? Can you see my screen?',
    '这个问题怎么验证，能看清吗？',
    '把这两行交换位置。能看清吗？',
    '这段代码有竞态条件？能看清吗？',
  ])('keeps the substantive task alongside a screen check: %s', (text) => {
    expect(autoQuestion(advanceQuestion(emptyQuestion(), seg(text)))).toBe(text);
  });
  it('retains a real question after a greeting', () => {
    expect(isLikelyQuestion('Hello, could you describe your project?')).toBe(true);
  });
  it('ignores repeated final events without changing the pending question', () => {
    const state = advanceQuestion(emptyQuestion(), seg('What is RAG?'));
    expect(isDuplicateFinal(state, seg('What is RAG?', 100))).toBe(true);
    expect(advanceQuestion(state, seg('What is RAG?', 100))).toBe(state);
    const handled = markQuestionHandled(state, state.block!.text);
    expect(autoQuestion(advanceQuestion(handled, seg('What is RAG?', 100)))).toBeUndefined();
  });
  it.each(['Okay.', '嗯。', '好的', 'Got it!'])('keeps the pending question after %s', (ack) => {
    const state = advanceQuestion(emptyQuestion(), seg('Are you available to work part-time?'));
    expect(autoQuestion(advanceQuestion(state, seg(ack, 1100, 'me')))).toBe(state.block!.text);
    const closed = advanceQuestion(state, seg('I can work on Fridays.', 1200, 'me'));
    expect(autoQuestion(advanceQuestion(closed, seg(ack, 2400, 'me')))).toBeUndefined();
  });
  it('closes the block when the candidate answers and accepts a short follow-up', () => {
    let state = advanceQuestion(emptyQuestion(), seg('Tell me about your project'));
    state = advanceQuestion(state, seg('I built a search prototype', 1200, 'me'));
    expect(autoQuestion(state)).toBeUndefined();
    state = advanceQuestion(state, seg('Why?', 2500));
    expect(autoQuestion(state)).toBe('Why?');
    expect(state.block?.text).not.toContain('project');
  });
  it('ends a block at time, topic and length boundaries', () => {
    const state = advanceQuestion(emptyQuestion(), seg('Describe your project'));
    expect(advanceQuestion(state, seg('What was your role?', 4000)).block?.text).toBe('What was your role?');
    expect(advanceQuestion(state, seg('Next question, why this company?', 1200)).block?.text).toBe('Next question, why this company?');
    const long = advanceQuestion(emptyQuestion(), seg('Explain ' + 'x'.repeat(580)));
    expect(advanceQuestion(long, seg('What about memory usage?', 1200)).block?.text).toBe('What about memory usage?');
  });
  it('pauses while editing, then marks the corrected question handled', () => {
    const state = { ...advanceQuestion(emptyQuestion(), seg('Explain rack')), editedText: 'Explain RAG' };
    expect(autoQuestion(state)).toBeUndefined();
    const handled = markQuestionHandled(state, state.editedText);
    expect(handled.block?.text).toBe('Explain RAG');
    expect(autoQuestion(handled)).toBeUndefined();
    expect(autoQuestion(advanceQuestion(handled, seg('and embeddings?', 1200)))).toContain('Explain RAG');
  });
  it('isolates sessions and bounds duplicate tracking', () => {
    const first = advanceQuestion(emptyQuestion(), seg('Why?'));
    expect(emptyQuestion().block).toBeUndefined();
    let other = emptyQuestion();
    for (let i = 0; i < 100; i++) other = advanceQuestion(other, seg('Question ' + i + '?', i * 5000));
    expect(other.seen.length).toBe(24);
    expect(first.block?.text).toBe('Why?');
  });
});

describe('actual dialogue versus AI suggestions', () => {
  it.each(['continuous', 'segment', 'free'] as const)('labels both speakers and draft history in %s mode', (mode) => {
    const transcript = actualTranscript([seg('Tell me about search'), seg('I built only a prototype, not a production system.', 1200, 'me'), seg('Why?', 2500)]);
    const msgs = buildAnswerMessages({ mode, question: 'Why?', freeQuestion: 'Why?', recentTranscript: transcript,
      history: [{ role: 'user', content: 'Tell me about search' }, { role: 'assistant', content: 'I operated a system with one million users.' }], memo: 'old AI draft' });
    const all = JSON.stringify(msgs);
    expect(all).toContain('面试官实际发言 / Interviewer');
    expect(all).toContain('候选人实际发言 / Candidate');
    expect(all).toContain('AI 建议（未实际说出）：I operated');
    expect(all).toContain('以实际发言和用户确认资料为准');
    expect(msgs.filter((m) => m.role === 'assistant').every((m) => !String(m.content).includes('million'))).toBe(true);
  });
  it('treats legacy transcript and memo provenance as uncertain', () => {
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'Why?', recentTranscript: ['legacy line'], memo: '我已声称：三年经验' });
    expect(JSON.stringify(msgs)).toContain('说话人未知');
    expect(JSON.stringify(msgs)).toContain('不能作为个人事实');
    expect(JSON.stringify(buildMemoUpdateMessages('old', 'question', 'AI draft'))).toContain('不是候选人实际发言');
  });
});
