import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { resolve, join, sep } from 'path';
import { buildAnswerMessages, buildVisionMessages } from '../electron/llm/prompts';
import { clearSessionAnswers, restoreReadingTurn, setQuestionTranslation, stopAnswers, updateAnswers } from '../shared/answerState';
import { SessionStore } from '../electron/sessions';
import type { RewriteStyle, StoredSession } from '../shared/protocol';
const session = (): StoredSession => ({ id: 's', name: 'old session', createdAt: 0, showChineseQuestion: true,
  turns: [
    { id: 'a', kind: 'segment', label: 'original question', text: 'original answer', status: 'done', batchId: 'batch', visionSlot: 'vision' },
    { id: 'b', kind: 'segment', label: 'original question', text: 'other model answer', status: 'streaming', batchId: 'batch', visionSlot: 'vision-2' },
    { id: 'c', kind: 'free', label: 'other question', text: 'other answer', status: 'done' },
  ], scripts: [{ id: 'script', title: 'Self introduction', text: 'Confirmed script.', collapsed: true, sourceTurnId: 'a' }] });

describe('selected answer revisions', () => {
  for (const answerLang of ['english', 'chinese'] as const) {
    it.each(['shorter', 'expand', 'rephrase'] as RewriteStyle[])('rewrites %s in ' + answerLang + ' from the selected complete source', (style) => {
      const source = 'original source\n```python\n' + 'print(1)\n'.repeat(300) + '``` END SOURCE';
      const msgs = buildAnswerMessages({ mode: 'segment', question: 'unrelated latest question', recentTranscript: ['候选人实际发言：I built a prototype'],
        history: [{ role: 'assistant', content: 'unrelated answer' }], answerLang,
        rewrite: { style, question: 'selected question', answer: source } });
      expect(msgs[0].content).toContain(answerLang === 'english' ? '用【英文】输出' : '用【中文】输出');
      expect(msgs[1].content).toContain(source);
      expect(msgs[1].content).toContain('selected question');
      expect(msgs[1].content).not.toContain('unrelated latest question');
      expect(msgs[1].content).not.toContain('unrelated answer');
      expect(msgs[1].content).toContain('AI 建议（未实际说出）');
      if (style === 'shorter') expect(msgs[1].content).toContain('不强制截断');
    });
  }
  it('asks for short spoken answers without changing written screenshots', () => {
    expect(buildAnswerMessages({ mode: 'segment', question: 'q', recentTranscript: [], answerLang: 'english' })[0].content).toContain('60 至 100');
    expect(buildVisionMessages('', 'image', undefined, 'written')[0].content).not.toContain('60 至 100');
  });
  it('cancels a revision and ignores late output while preserving its original', () => {
    const s = session();
    s.turns.push({ id: 'rewrite', kind: 'segment', label: 'original question', text: 'partial', status: 'streaming', rewriteOf: 'a', rewriteStyle: 'shorter' });
    const stopped = stopAnswers([s]);
    expect(stopped[0].turns[0]).toEqual(s.turns[0]);
    expect(updateAnswers(stopped, { requestId: 'rewrite', kind: 'done', text: 'late' })).toEqual(stopped);
    expect(stopped[0].turns.at(-1)).toMatchObject({ status: 'cancelled', text: 'partial' });
  });
});

describe('independent question translation', () => {
  it('shares a batch translation across models without changing answer content or status', () => {
    const original = session();
    const changed = setQuestionTranslation(original, 'batch', { questionTranslation: '原问题', questionTranslating: false });
    expect(changed.turns.slice(0, 2).every((t) => t.questionTranslation === '原问题')).toBe(true);
    expect(changed.turns.map((t) => [t.text, t.status])).toEqual(original.turns.map((t) => [t.text, t.status]));
    expect(changed.turns[2]).toEqual(original.turns[2]);
    expect(original.turns[0].questionTranslation).toBeUndefined();
  });
  it('keeps a successful answer when translation fails', () => {
    const changed = setQuestionTranslation(session(), 'batch', { questionTranslationError: 'failed', questionTranslating: false });
    expect(changed.turns[0]).toMatchObject({ status: 'done', text: 'original answer', questionTranslationError: 'failed' });
  });
  it('does not resurrect cleared turns when a late translation completes', () => {
    const cleared = clearSessionAnswers(session());
    expect(setQuestionTranslation(cleared, 'batch', { questionTranslation: 'late' }).turns).toEqual([]);
  });
});

describe('pinned scripts and older sessions', () => {
  it('preserves pinned scripts, collapse state and reading preference when clearing', () => {
    const original = session();
    const cleared = clearSessionAnswers(original);
    expect(cleared.turns).toEqual([]);
    expect(cleared.scripts).toEqual(original.scripts);
    expect(cleared.showChineseQuestion).toBe(true);
    expect(original.turns).toHaveLength(3);
  });
  it('recovers interrupted answer/translation state without losing text or optional fields', () => {
    const old = session().turns[1];
    expect(restoreReadingTurn({ ...old, questionTranslating: true, questionTranslation: '已译' })).toMatchObject({ status: 'cancelled', questionTranslating: false, questionTranslation: '已译', text: 'other model answer' });
    expect(restoreReadingTurn(session().turns[0]).status).toBe('done');
  });
  it('round-trips scripts and independent sessions through the existing file store', () => {
    const root = resolve('..', 'work');
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'reading-store-'));
    try {
      const store = new SessionStore(join(dir, 'sessions.json'));
      const older: StoredSession = { id: 'old', name: 'legacy', createdAt: 0, turns: [] };
      store.save({ sessions: [clearSessionAnswers(session()), older], currentId: 's' });
      const loaded = store.load();
      expect(loaded.sessions[0].scripts?.[0]).toMatchObject({ collapsed: true, text: 'Confirmed script.' });
      expect(loaded.sessions[1]).toEqual(older);
      loaded.sessions[0].scripts![0].text = 'edited copy';
      expect(store.load().sessions[0].scripts![0].text).toBe('Confirmed script.');
    } finally {
      if (!resolve(dir).startsWith(root + sep)) throw new Error('Test directory escaped workspace');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('English answer routes require a complete translation and forbid notes while written mode stays unchanged', () => {
 for (const mode of ['segment','continuous','free'] as const) {
  const sys=buildAnswerMessages({mode,question:'Introduce yourself',freeQuestion:'Introduce yourself',recentTranscript:[],answerLang:'english'})[0].content as string;
  expect(sys).toContain('完整简体中文翻译');expect(sys).toContain('不输出中文备注');
 }
 const rewrite=buildAnswerMessages({mode:'segment',recentTranscript:[],answerLang:'english',rewrite:{style:'shorter',question:'q',answer:'a'}})[0].content as string;
 expect(rewrite).toContain('中文翻译：');
 expect(buildVisionMessages('q','image',undefined,'interview','english')[0].content).toContain('完整简体中文翻译');
 expect(buildVisionMessages('q','image',undefined,'written','english')[0].content).not.toContain('中文翻译：');
});
