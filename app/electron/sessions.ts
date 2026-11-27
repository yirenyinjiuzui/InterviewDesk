/**
 * Multi-session store: persists the right-pane conversations to a plain JSON
 * file (never DOM storage). Each session = one meeting/interview with its own
 * turns and knowledge base.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { SessionsFile } from '../shared/protocol';

export class SessionStore {
  private canSave?: boolean;
  constructor(private readonly filePath: string) {}

  load(): SessionsFile {
    this.canSave = false;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<SessionsFile> | null;
      if (!Array.isArray(raw?.sessions) || !raw.sessions.every((s) =>
        s && typeof s.id === 'string' && Array.isArray(s.turns) &&
        (s.segments == null || Array.isArray(s.segments)))) {
        throw new Error('Invalid session history');
      }
      this.canSave = true;
      return { sessions: raw.sessions, currentId: raw.currentId ?? null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.canSave = true;
        return { sessions: [], currentId: null };
      }
      throw new Error(`无法读取会话历史 / Cannot read session history: ${this.filePath}`);
    }
  }

  save(data: SessionsFile): void {
    if (this.canSave === undefined) this.load();
    if (!this.canSave) throw new Error('会话历史尚未恢复，已暂停保存。 / Restore session history before saving.');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
