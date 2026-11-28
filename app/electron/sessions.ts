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
  private lastRead: Buffer | null = null;
  constructor(private readonly filePath: string) {}

  load(): SessionsFile {
    this.canSave = false;
    try {
      const bytes = readFileSync(this.filePath);
      const raw = JSON.parse(bytes.toString('utf8')) as Partial<SessionsFile> | null;
      if (!Array.isArray(raw?.sessions) || !raw.sessions.every((s) =>
        s && typeof s.id === 'string' && Array.isArray(s.turns) &&
        (s.segments == null || Array.isArray(s.segments)))) {
        throw new Error('Invalid session history');
      }
      this.lastRead = bytes;
      this.canSave = true;
      return { sessions: raw.sessions, currentId: raw.currentId ?? null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lastRead = null;
        this.canSave = true;
        return { sessions: [], currentId: null };
      }
      throw new Error(`无法读取会话历史 / Cannot read session history: ${this.filePath}`);
    }
  }

  save(data: SessionsFile): void {
    if (this.canSave === undefined) this.load();
    if (!this.canSave) throw new Error('会话历史尚未恢复，已暂停保存。 / Restore session history before saving.');
    this.checkUnchanged();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const bytes = Buffer.from(JSON.stringify(data), 'utf8');
    writeFileSync(tmp, bytes);
    this.checkUnchanged();
    renameSync(tmp, this.filePath);
    this.lastRead = bytes;
  }

  private checkUnchanged(): void {
    let current: Buffer | null = null;
    try {
      current = readFileSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.canSave = false;
        throw new Error('无法核对会话历史，已暂停保存。请备份后重新启动。 / Cannot verify session history; saving paused. Back up and restart.');
      }
    }
    const unchanged = current === null ? this.lastRead === null : this.lastRead !== null && current.equals(this.lastRead);
    if (!unchanged) {
      this.canSave = false;
      throw new Error('会话历史已在外部更改，已暂停保存。请备份后重新启动。 / Session history changed on disk; saving paused. Back up and restart.');
    }
  }
}
