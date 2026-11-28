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

it('does not overwrite history changed by another instance after loading', () => {
  const original = { sessions: [{ id: 'A', name: 'A', createdAt: 1, turns: [] }], currentId: 'A' };
  const newer = { sessions: [{ id: 'B', name: 'B', createdAt: 2, turns: [] }], currentId: 'B' };
  const first = new SessionStore(file);
  first.save(original);
  const second = new SessionStore(file);
  expect(second.load()).toEqual(original);
  second.save(newer);
  const saved = readFileSync(file);
  expect(() => first.save(empty)).toThrow();
  expect(readFileSync(file)).toEqual(saved);
  expect(() => first.save(original)).toThrow();
  expect(first.load()).toEqual(newer);
  expect(() => first.save(newer)).not.toThrow();
});

it('does not overwrite corrupted, deleted or newly created history after a successful load', () => {
  const store = new SessionStore(file);
  store.save(empty);
  writeFileSync(file, '{"sessions":[');
  expect(() => store.save(empty)).toThrow();
  expect(readFileSync(file, 'utf8')).toBe('{"sessions":[');
  writeFileSync(file, JSON.stringify(empty));
  store.load();
  rmSync(file);
  expect(() => store.save(empty)).toThrow();
  const missing = new SessionStore(file);
  expect(missing.load()).toEqual(empty);
  writeFileSync(file, JSON.stringify(empty));
  expect(() => missing.save(empty)).toThrow();
  expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(empty));
});
