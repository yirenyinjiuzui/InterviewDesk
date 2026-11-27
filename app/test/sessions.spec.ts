import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SessionStore } from '../electron/sessions';

let dir: string;
let file: string;
const empty = { sessions: [], currentId: null };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mc-history-')); file = join(dir, 'sessions.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it.each(['{"sessions":[', '{"other":[]}', '{"sessions":[null]}'])('preserves unreadable history and rejects saves (%s)', (raw) => {
  writeFileSync(file, raw);
  const store = new SessionStore(file);
  expect(() => store.load()).toThrow();
  expect(() => store.save(empty)).toThrow();
  expect(readFileSync(file, 'utf8')).toBe(raw);
  writeFileSync(file, JSON.stringify(empty));
  expect(store.load()).toEqual(empty);
  expect(() => store.save(empty)).not.toThrow();
});

it('treats an inaccessible file as a failed restore', () => {
  mkdirSync(file);
  const store = new SessionStore(file);
  expect(() => store.load()).toThrow();
  expect(() => store.save(empty)).toThrow();
});

it('initializes missing history and round trips legacy session data', () => {
  const store = new SessionStore(file);
  expect(store.load()).toEqual(empty);
  const history = { sessions: [{ id: 'A', name: 'A', createdAt: 1, turns: [], kbText: 'synthetic', jdText: 'Role A' }], currentId: 'A' };
  store.save(history);
  expect(new SessionStore(file).load()).toEqual(history);
});
