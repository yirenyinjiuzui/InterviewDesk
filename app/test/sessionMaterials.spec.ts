import { describe, expect, it } from 'vitest';
import { personalInfoContext, PERSONAL_INFO_CATEGORIES } from '../shared/sessionMaterials';
import { buildAnswerMessages, buildPrewarmMessages, buildStablePrefix, buildVisionMessages } from '../electron/llm/prompts';
import type { PersonalInfo } from '../shared/protocol';
describe('confirmed versus pending prompt facts', () => {
  const info: PersonalInfo = { skills: { confirmed: 'Python beginner', pending: 'Expert level not confirmed' }, availability: { confirmed: '', pending: '2026-12-01 start date not confirmed' } };
  it.each(['segment', 'continuous', 'free'] as const)('injects confirmed and pending fields separately in %s mode', (mode) => {
    const msgs = buildAnswerMessages({ mode, question: 'When can you start?', freeQuestion: 'When can you start?', recentTranscript: [], resume: 'Old resume claims expert Python', jd: 'Job requires expertise', personalInfo: info });
    const all = JSON.stringify(msgs);
    expect(all).toContain('【用户本场已确认】'); expect(all).toContain('Python beginner');
    expect(all).toContain('【待确认（不得当作个人事实）】'); expect(all).toContain('2026-12-01');
    expect(all).toContain('岗位要求不是个人经历'); expect(all).toContain('要求澄清');
  });
  it('passes facts into answer rewrites and interview screenshots but not written screenshots', () => {
    const msgs = buildAnswerMessages({ mode: 'segment', recentTranscript: [], personalInfo: info, rewrite: { style: 'rephrase', question: 'q', answer: 'old AI draft' } });
    expect(JSON.stringify(msgs)).toContain('Python beginner');
    expect(JSON.stringify(buildVisionMessages('q', 'image', 'resume', 'interview', 'english', info))).toContain('Python beginner');
    expect(JSON.stringify(buildVisionMessages('q', 'image', undefined, 'written', 'english', info))).not.toContain('Python beginner');
  });
  it('keeps the 8000-character combined material budget and retains short JD alongside long resume', () => {
    const longInfo: PersonalInfo = {};
    for (const key of Object.keys(PERSONAL_INFO_CATEGORIES) as (keyof PersonalInfo)[]) longInfo[key] = { confirmed: 'C'.repeat(500), pending: 'P'.repeat(500) };
    const personal = personalInfoContext(longInfo);
    expect(personal.length).toBeLessThan(2000);
    const prefix = buildStablePrefix('R'.repeat(12000), 'J'.repeat(200), 'english', longInfo);
    expect(prefix).toContain('J'.repeat(200));
    const chars = (prefix.match(/R/g) ?? []).length + 200 + personal.length;
    // Persona may itself contain a few R letters; bound actual material separately.
    const resumePart = prefix.split('【简历】')[1].split('【简历结束】')[0];
    expect(resumePart.match(/R/g)?.length! + 200 + personal.length).toBeLessThanOrEqual(8000);
    expect(chars).toBeLessThan(8100);
    const screenshot = JSON.stringify(buildVisionMessages('q', 'image', undefined, 'interview', 'english', longInfo, { resume: 'R'.repeat(12000), jd: 'J'.repeat(200) }));
    expect(screenshot).toContain('J'.repeat(200));
  });
  it('uses the same stable prefix for prewarm and answers with personal information', () => {
    const prefix = buildStablePrefix('resume', 'jd', 'english', info);
    expect(buildPrewarmMessages(prefix)[0]).toEqual(buildAnswerMessages({ mode: 'segment', question: 'q', recentTranscript: [], resume: 'resume', jd: 'jd', answerLang: 'english', personalInfo: info })[0]);
  });
});
