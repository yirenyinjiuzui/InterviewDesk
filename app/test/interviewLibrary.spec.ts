import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { resolve, join, sep } from 'path';
import { InterviewLibraryStore } from '../electron/interviewLibrary';
import { bankMaterialKey, matchBankAnswer } from '../shared/interviewBank';
import { LEGACY_GLOBAL_SOURCE, withDefaultResume } from '../shared/interviewLibrary';
import type { StoredSession } from '../shared/protocol';
const session = (id: string, createdAt: number, resumeText?: string): StoredSession => ({ id, createdAt, name: id, turns: [], resumeText, resumeName: id + '.md' });
function folder() { const root=resolve('../work');mkdirSync(root,{recursive:true});return {root,dir:mkdtempSync(join(root,'library-test-'))}; }
it('seeds once from latest interview resume without migrating dialogue or job claims', () => {
 const {root,dir}=folder();let store: InterviewLibraryStore | undefined;
 try {
  store=new InterviewLibraryStore(join(dir,'library.sqlite'),[session('old',1,'old resume'),session('new',2,'new resume'),{...session('written',3,'wrong'),workspace:'written'}]);
  expect(store.get()).toMatchObject({resumeText:'new resume',resumeSource:'new'});expect(store.get().questions.length).toBeGreaterThan(10);
  store.save({resumeName:'edited',resumeSource:'manual',resumeText:'updated resume',questions:['One?', 'One?', 'Two?',' ']});store.close();
  store=new InterviewLibraryStore(join(dir,'library.sqlite'),[session('newer',4,'should not overwrite')]);
  expect(store.get()).toMatchObject({resumeText:'updated resume',questions:['One?','Two?']});
 } finally {store?.close();if(!resolve(dir).startsWith(root+sep))throw Error('invalid path');rmSync(dir,{recursive:true,force:true});}
});
it('new interview sessions inherit a snapshot while existing resumes, jobs, and written tests stay separate', () => {
 const lib={resumeName:'cv',resumeText:'my resume',resumeSource:'manual',questions:['Q?']};const old=session('old',1,'own resume');
 expect(withDefaultResume(old,lib)).toBe(old);expect(withDefaultResume({...old,resumeText:undefined,workspace:'written'},lib).resumeText).toBeUndefined();
 const created=withDefaultResume(session('new',2),lib);lib.resumeText='changed';expect(created.resumeText).toBe('my resume');expect(created.jdText).toBeUndefined();expect(created.turns).toEqual([]);
});
it('keeps a legacy auto-seeded resume available for import and preserves an explicitly empty default', () => {
 const {root,dir}=folder();let store: InterviewLibraryStore | undefined;
 try {
  const file = join(dir, 'library.sqlite');
  store = new InterviewLibraryStore(file);
  store.save({resumeName:'knowledge.md', resumeText:'legacy resume', resumeSource:LEGACY_GLOBAL_SOURCE, questions:[]});
  store.close();
  store = new InterviewLibraryStore(file);
  expect(store.get().resumeText).toBe('legacy resume');
  expect(withDefaultResume(session('empty', 1), store.get()).resumeText).toBeUndefined();
  store.save({resumeName:'',resumeText:'',resumeSource:'',questions:[]});store.close();store=new InterviewLibraryStore(file,[session('old',1,'old resume')]);expect(store.get().resumeText).toBe('');expect(store.get().questions).toEqual([]);
 }finally{store?.close();if(!resolve(dir).startsWith(root+sep))throw Error('invalid path');rmSync(dir,{recursive:true,force:true});}
});

it('migrates an existing resume database without losing resume or questions and persists JD', () => {
 const {root,dir}=folder(); let store: InterviewLibraryStore | undefined;
 try {
  const file=join(dir,'old.sqlite'); const db=new DatabaseSync(file);
  db.exec("CREATE TABLE profile (id INTEGER PRIMARY KEY, resume_name TEXT, resume_text TEXT, resume_source TEXT); INSERT INTO profile VALUES(1,'old','original resume','old source'); CREATE TABLE questions(position INTEGER PRIMARY KEY,text TEXT); INSERT INTO questions VALUES(0,'Original question?')"); db.close();
  store=new InterviewLibraryStore(file); expect(store.get()).toMatchObject({resumeText:'original resume',questions:['Original question?'],jdText:''});
  store.save({...store.get(),jdName:'role.md',jdText:'Selected role',jdSource:'manual'}); store.close(); store=new InterviewLibraryStore(file);
  expect(store.get()).toMatchObject({resumeText:'original resume',jdText:'Selected role',questions:['Original question?']});
  const created=withDefaultResume(session('fresh',2),store.get()); expect(created.jdText).toBeUndefined();
  expect(withDefaultResume({...created,jdText:'own role'},store.get()).jdText).toBe('own role');
  expect(withDefaultResume({...session('written',2),workspace:'written'},store.get()).jdText).toBeUndefined();
  store.save({...store.get(),jdText:''});store.close();store=new InterviewLibraryStore(file);expect(store.get().jdText).toBe('');
 } finally {store?.close();if(!resolve(dir).startsWith(root+sep))throw Error('invalid path');rmSync(dir,{recursive:true,force:true});}
});

it('preserves the legacy default JD when a resume-only client omits the optional JD fields', () => {
  const { root, dir } = folder();
  const file = join(dir, 'materials.sqlite');
  let store = new InterviewLibraryStore(file);
  try {
    store.save({ ...store.get(), resumeName: 'Original CV', resumeText: 'Synthetic resume', resumeSource: 'manual',
      jdName: 'Old role', jdText: 'Synthetic legacy role', jdSource: 'old-default', questions: ['Q?'] });
    store.save({ resumeName: 'Updated CV', resumeText: 'Updated synthetic resume', resumeSource: 'manual', questions: ['Q?'] });
    store.close();
    store = new InterviewLibraryStore(file);
    expect(store.get()).toMatchObject({ resumeName: 'Updated CV', resumeText: 'Updated synthetic resume',
      jdName: 'Old role', jdText: 'Synthetic legacy role', jdSource: 'old-default', questions: ['Q?'] });
    // The previous default remains opt-in, never automatically applied to a new interview.
    expect(withDefaultResume(session('new', 2), store.get()).jdText).toBeUndefined();
    store.save({ ...store.get(), jdName: '', jdText: '', jdSource: '' });
    expect(store.get()).toMatchObject({ jdName: '', jdText: '', jdSource: '' });
  } finally {
    store.close();
    if (!resolve(dir).startsWith(root + sep)) throw Error('invalid path');
    rmSync(dir, { recursive: true, force: true });
  }
});

it('retains prepared bilingual answers across migration, old-client saves and reopen, and prunes removed questions', () => {
 const {root,dir}=folder();let store: InterviewLibraryStore | undefined;
 try {
  const file=join(dir,'bank.sqlite');store=new InterviewLibraryStore(file);
  store.save({...store.get(),questions:['Question A?','Question B?'],answers:{'Question A?':{english:'English answer',chinese:'中文翻译',materialKey:'key'}}});
  store.close();store=new InterviewLibraryStore(file);
  expect(store.get().answers?.['Question A?']).toEqual({english:'English answer',chinese:'中文翻译',materialKey:'key'});
  const {answers,...legacy}=store.get();store.save(legacy);expect(store.get().answers).toEqual(answers);
  expect(()=>store!.save({...store!.get(),answers:{bad:{english:123} as never}})).toThrow();expect(store.get().questions).toEqual(['Question A?','Question B?']);
  store.save({...store.get(),questions:['Question B?']});expect(store.get().answers).toEqual({});
 }finally{store?.close();if(!resolve(dir).startsWith(root+sep))throw Error('invalid path');rmSync(dir,{recursive:true,force:true});}
});

it('restores both job-specific answers after preparing the same question for a second job', () => {
  const { root, dir } = folder();
  const file = join(dir, 'roles.sqlite');
  const question = 'Why this role?';
  const answer = (role: string) => ({ english: 'I like ' + role, chinese: '我喜欢这个岗位。', materialKey: bankMaterialKey('Synthetic CV', role) });
  let store = new InterviewLibraryStore(file);
  try {
    for (const role of ['Role A', 'Role B']) {
      store.save({ ...store.get(), questions: [question], answers: { [question]: answer(role) } });
    }
    store.close();
    store = new InterviewLibraryStore(file);
    for (const role of ['Role A', 'Role B']) {
      expect(matchBankAnswer(question, store.get(), answer(role).materialKey)?.answer).toEqual(answer(role));
    }
    expect(matchBankAnswer(question, store.get(), answer('Role C').materialKey)).toBeUndefined();
    store.save({ ...store.get(), questions: [] });
    store.save({ ...store.get(), questions: [question] });
    expect(matchBankAnswer(question, store.get(), answer('Role A').materialKey)).toBeUndefined();
  } finally {
    store.close();
    if (!resolve(dir).startsWith(root + sep)) throw Error('invalid path');
    rmSync(dir, { recursive: true, force: true });
  }
});

it('preparing a reduced draft preserves the other role and its saved question across reopen', () => {
  const { root, dir } = folder();
  const file = join(dir, 'draft-roles.sqlite');
  const shared = 'Why this role?', remaining = 'Describe your prototype?';
  const answer = (role: string) => ({ english: 'I prepared for ' + role, chinese: '这是该岗位的答案。', materialKey: bankMaterialKey('Synthetic CV', role) });
  let store = new InterviewLibraryStore(file);
  try {
    store.save({ questions: [shared, remaining], answers: { [shared]: answer('Role A') } });
    store.save({ questions: [shared, remaining], answers: { [shared]: answer('Role B') } });
    // B removes the shared question only from the draft, then prepares the remaining one.
    store.save({ mode: 'prepare', questions: [remaining], answers: { [remaining]: answer('Role B') } });
    store.close();
    store = new InterviewLibraryStore(file);
    expect(store.get().questions).toEqual([shared, remaining]);
    expect(matchBankAnswer(shared, store.get(), answer('Role A').materialKey)?.answer).toEqual(answer('Role A'));
    expect(matchBankAnswer(shared, store.get(), answer('Role B').materialKey)?.answer).toEqual(answer('Role B'));
    expect(matchBankAnswer(remaining, store.get(), answer('Role B').materialKey)?.answer).toEqual(answer('Role B'));
    expect(matchBankAnswer(shared, store.get(), answer('Role C').materialKey)).toBeUndefined();
    // A newly prepared question is still added, while an explicit full save retains deletion semantics.
    const added = 'A new question?';
    store.save({ mode: 'prepare', questions: [added], answers: { [added]: answer('Role B') } });
    expect(store.get().questions).toEqual([shared, remaining, added]);
    store.save({ questions: [remaining, added], answers: store.get().answers });
    expect(store.get().questions).toEqual([remaining, added]);
  } finally {
    store.close();
    if (!resolve(dir).startsWith(root + sep)) throw Error('invalid path');
    rmSync(dir, { recursive: true, force: true });
  }
});
