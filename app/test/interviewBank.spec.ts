import { expect, it } from 'vitest';
import { bankAnswerText, bankMaterialKey, matchBankAnswer, parseBankAnswer } from '../shared/interviewBank';
import type { InterviewLibrary } from '../shared/protocol';
const key = bankMaterialKey('cv', 'jd');
const answer = { english: 'I built a prototype.', chinese: '我开发了一个原型。', materialKey: key };
const library: InterviewLibrary = { resumeName: 'cv', resumeText: 'cv', resumeSource: '', questions: ['介绍你的项目。 / Describe your project?', 'What is RAG?'], answers: { '介绍你的项目。 / Describe your project?': answer, 'What is RAG?': { ...answer, english: 'RAG retrieves evidence.' } } };
it('all prepared questions match without manual selection, with bilingual aliases and harmless punctuation', () => {
 expect(matchBankAnswer('Could you describe your project?', library, key)?.answer.english).toBe(answer.english);
 expect(matchBankAnswer('介绍你的项目？', library, key)?.answer.english).toBe(answer.english);
 expect(matchBankAnswer('Next question, what is RAG?', library, key)?.answer.english).toBe('RAG retrieves evidence.');
});
it('does not reuse answers for unknown questions, short follow-ups, negations or changed numbers', () => {
 for (const q of ['Why?', 'What is RAG not?', 'Describe your project and explain your next project?', 'What is reinforcement learning?']) expect(matchBankAnswer(q, library, key)).toBeUndefined();
 const q='What would change with 100 users?';
 expect(matchBankAnswer('What would change with 200 users?', {...library,questions:[q],answers:{[q]:answer}},key)).toBeUndefined();
});
it('refuses ambiguous or outdated answers and ignores empty entries', () => {
 expect(matchBankAnswer('Describe your project?',library,bankMaterialKey('new cv','jd'))).toBeUndefined();
 expect(matchBankAnswer('Describe your project?',{...library,answers:{}},key)).toBeUndefined();
 expect(matchBankAnswer('Describe your project?',{...library,questions:[...library.questions,'Describe your project?'],answers:{...library.answers,'Describe your project?':answer}},key)).toBeUndefined();
});
it('material key is stable across names, missing versus empty facts, and changes on real facts', () => {
 expect(bankMaterialKey(' cv ','jd',{})).toBe(key);
 expect(bankMaterialKey('cv','jd',{education:{confirmed:'Student',pending:''}})).not.toBe(key);
 expect(bankMaterialKey('cv','other jd')).not.toBe(key);
});
it('stores and formats only English answer and corresponding Chinese translation', () => {
 expect(parseBankAnswer('I built a prototype.\n\n中文翻译：\n我开发了一个原型。',key)).toEqual(answer);
 expect(bankAnswerText(answer,'english')).toBe('I built a prototype.\n\n中文翻译：\n我开发了一个原型。');
 expect(bankAnswerText(answer,'chinese')).toBe('我开发了一个原型。');
 for (const text of ['', 'English only.', 'English\n中文备注：不确定', 'English\n中文翻译：']) expect(()=>parseBankAnswer(text,key)).toThrow();
});

it('matches a short Chinese exact question and distinguishes technical symbols', () => {
 const qs = ['自我介绍', 'Could you explain C++ memory management?', 'Explain TCP/IP?'];
 const bank = {...library, questions:qs, answers:Object.fromEntries(qs.map(q => [q, answer]))};
 expect(matchBankAnswer('自我介绍？', bank, key)?.question).toBe(qs[0]);
 expect(matchBankAnswer('Could you explain C# memory management?', bank, key)).toBeUndefined();
 expect(matchBankAnswer('Explain TCP/IP?', bank, key)?.question).toBe(qs[2]);
});

it('reuses role-independent preparation only for its original resume and approved question', async () => {
 const {generalBankKey} = await import('../shared/interviewBank');
 const q = '如何减少大模型幻觉？ / How would you reduce LLM hallucinations?';
 const general = generalBankKey('cv');
 const bank = {...library, questions:[q], answers:{[q]:{...answer, materialKey:general}}};
 expect(matchBankAnswer('How would you reduce LLM hallucinations?',bank,bankMaterialKey('cv','B'),general)?.question).toBe(q);
 expect(matchBankAnswer(q,bank,key,generalBankKey('another CV'))).toBeUndefined();
});
