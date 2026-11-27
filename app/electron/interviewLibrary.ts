import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { InterviewBankAnswer, InterviewLibrary, InterviewLibraryUpdate, StoredSession } from '../shared/protocol';
import { DEFAULT_INTERVIEW_QUESTIONS } from '../shared/interviewLibrary';

/** Local-only database. Sessions and encrypted API settings remain in their existing files. */
export class InterviewLibraryStore {
  private db: DatabaseSync;
  constructor(file: string, sessions: StoredSession[] = []) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK(id=1), resume_name TEXT NOT NULL, resume_text TEXT NOT NULL, resume_source TEXT NOT NULL); CREATE TABLE IF NOT EXISTS questions (position INTEGER PRIMARY KEY, text TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS answer_history (question TEXT NOT NULL, material_key TEXT NOT NULL, english TEXT NOT NULL, chinese TEXT NOT NULL, PRIMARY KEY(question, material_key))');
    const columns = this.db.prepare('PRAGMA table_info(profile)').all().map((row) => row.name);
    for (const column of ['jd_name', 'jd_text', 'jd_source']) {
      if (!columns.includes(column)) this.db.exec(`ALTER TABLE profile ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
    const questionColumns = this.db.prepare('PRAGMA table_info(questions)').all().map((row) => row.name);
    for (const column of ['english', 'chinese', 'material_key']) {
      if (!questionColumns.includes(column)) this.db.exec(`ALTER TABLE questions ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
    if (!this.db.prepare('SELECT id FROM profile WHERE id=1').get()) {
      const source = sessions.filter((s) => (s.workspace ?? 'interview') === 'interview' && (s.resumeText ?? s.kbText)?.trim()).sort((a, b) => b.createdAt - a.createdAt)[0];
      this.save({ resumeName: source?.resumeName || source?.kbName || '',
        resumeText: source?.resumeText || source?.kbText || '',
        resumeSource: source?.name ?? '',
        questions: [...DEFAULT_INTERVIEW_QUESTIONS] });
    }
  }
  get(): InterviewLibrary {
    const row = this.db.prepare('SELECT resume_name, resume_text, resume_source, jd_name, jd_text, jd_source FROM profile WHERE id=1').get()!;
    const questions = this.db.prepare('SELECT text, english, chinese, material_key FROM questions ORDER BY position').all();
    const answers = Object.fromEntries(questions.filter((r) => r.english || r.chinese).map((r) => [String(r.text), { english: String(r.english), chinese: String(r.chinese), materialKey: String(r.material_key) }]));
    const answerHistory: Record<string, InterviewBankAnswer[]> = Object.create(null);
    for (const prior of this.db.prepare('SELECT question, material_key, english, chinese FROM answer_history').all()) {
      (answerHistory[String(prior.question)] ??= []).push({
        english: String(prior.english), chinese: String(prior.chinese), materialKey: String(prior.material_key),
      });
    }
    return { answers, answerHistory, jdName: String(row.jd_name), jdText: String(row.jd_text), jdSource: String(row.jd_source), resumeName: String(row.resume_name), resumeText: String(row.resume_text), resumeSource: String(row.resume_source),
      questions: questions.map((r) => String(r.text)) };
  }
  save(value: InterviewLibraryUpdate): InterviewLibrary {
    if (!value || !Array.isArray(value.questions) || !value.questions.every((q) => typeof q === 'string')) throw new Error('Invalid interview library');
    const preparing = 'mode' in value && value.mode === 'prepare';
    const profile = !preparing && 'resumeName' in value ? value : undefined;
    if (profile && [profile.resumeName, profile.resumeText, profile.resumeSource].some((v) => typeof v !== 'string')) throw new Error('Invalid interview library');
    if (profile && [profile.jdName, profile.jdText, profile.jdSource].some((v) => v !== undefined && typeof v !== 'string')) throw new Error('Invalid job material');
    const existing = this.db.prepare('SELECT id FROM profile WHERE id=1').get() ? this.get() : undefined;
    const supplied = value.answers ?? (preparing ? {} : existing?.answers) ?? {};
    if (Object.values(supplied).some((a) => !a || typeof a.english !== 'string' || typeof a.chinese !== 'string' || typeof a.materialKey !== 'string')) throw new Error('Invalid bank answer');
    const requested = [...new Set(value.questions.map((q) => q.trim()).filter(Boolean))];
    // Preparing an answer is a checkpoint, not confirmation of edits to the global question list.
    const completed = preparing ? requested.filter((q) => Object.hasOwn(supplied, q)) : requested;
    const questions = preparing ? [...new Set([...(existing?.questions ?? []), ...completed])] : requested;
    const answers = preparing ? { ...existing?.answers, ...Object.fromEntries(completed.map((q) => [q, supplied[q]])) } : supplied;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (profile) this.db.prepare('INSERT OR REPLACE INTO profile (id, resume_name, resume_text, resume_source, jd_name, jd_text, jd_source) VALUES (1, ?, ?, ?, ?, ?, ?)').run(profile.resumeName, profile.resumeText, profile.resumeSource, profile.jdName ?? '', profile.jdText ?? '', profile.jdSource ?? '');
      // Archive the previous per-question slots before replacing them, including 0.3.17 data.
      this.db.exec("INSERT OR REPLACE INTO answer_history SELECT text, material_key, english, chinese FROM questions WHERE english <> '' OR chinese <> ''");
      this.db.exec('DELETE FROM questions');
      const insert = this.db.prepare('INSERT INTO questions (position, text, english, chinese, material_key) VALUES (?, ?, ?, ?, ?)');
      questions.forEach((q, i) => insert.run(i, q, answers[q]?.english ?? '', answers[q]?.chinese ?? '', answers[q]?.materialKey ?? ''));
      this.db.exec(`DELETE FROM answer_history WHERE question NOT IN (SELECT text FROM questions)
        OR EXISTS (SELECT 1 FROM questions WHERE text = answer_history.question AND material_key = answer_history.material_key)`);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.get();
  }
  close(): void { this.db.close(); }
}
