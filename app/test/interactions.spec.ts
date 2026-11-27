import { describe, expect, it } from 'vitest';
import { answerHistory, stopAnswers, updateAnswers } from '../shared/answerState';
import { resolveHotkeys, validateHotkeys } from '../shared/hotkeys';
import { createScreenshotGate } from '../electron/screenshot';
import { createWindowMover } from '../electron/windowMovement';
import { normalizeProviderError } from '../electron/providerErrors';
import { testRoute } from '../shared/providerDiagnostics';
import type { StoredSession } from '../shared/protocol';

function sessions(): StoredSession[] {
  return [{ id: 'one', name: 'one', createdAt: 0, turns: [
    { id: 'active', kind: 'free', label: 'question', text: 'partial', status: 'streaming' },
    { id: 'finished', kind: 'free', label: 'old question', text: 'complete', status: 'done' },
  ] }, { id: 'two', name: 'two', createdAt: 0, turns: [
    { id: 'other', kind: 'vision', label: 'image', text: '', status: 'streaming' },
  ] }];
}

describe('answer lifecycle', () => {
  it('stops all sessions, preserving partial text and excluding it from history', () => {
    const stopped = stopAnswers(sessions());
    expect(stopped[0].turns[0]).toMatchObject({ status: 'cancelled', text: 'partial' });
    expect(stopped[1].turns[0].status).toBe('cancelled');
    expect(answerHistory(stopped[0].turns)).toEqual([
      { role: 'user', content: 'old question' }, { role: 'assistant', content: 'complete' },
    ]);
  });
  it('ignores late output and completion after cancellation', () => {
    const stopped = stopAnswers(sessions());
    expect(updateAnswers(stopped, { requestId: 'active', kind: 'delta', text: 'late' })).toEqual(stopped);
    expect(updateAnswers(stopped, { requestId: 'active', kind: 'done', text: 'late' })).toEqual(stopped);
  });
  it('allows a fresh request and preserves its final answer', () => {
    const fresh = updateAnswers(sessions(), { requestId: 'active', kind: 'done', text: 'final' });
    expect(fresh[0].turns[0]).toMatchObject({ text: 'final', status: 'done' });
  });
  it('explains ignored duplicate captures without marking them complete', () => {
    const result = updateAnswers(sessions(), { requestId: 'other', kind: 'cancelled', message: 'duplicate' });
    expect(result[1].turns[0]).toMatchObject({ status: 'cancelled', error: 'duplicate' });
  });
});

describe('screenshot deduplication', () => {
  it('deduplicates only identical short-interval captures in the same session', () => {
    let time = 0;
    const accept = createScreenshotGate(() => time);
    expect(accept('image', 'question', 'material', 'one')).toBe(true);
    expect(accept('image', 'question', 'material', 'one')).toBe(false);
    accept.clear();
    expect(accept('image', 'question', 'material', 'one')).toBe(true);
    expect(accept('image', 'question', 'material', 'two')).toBe(true);
    expect(accept('image', 'different question', 'material', 'one')).toBe(true);
    expect(accept('image', 'question', 'different material', 'one')).toBe(true);
    expect(accept('different image', 'question', 'material', 'one')).toBe(true);
    time = 700;
    expect(accept('image', 'question', 'material', 'one')).toBe(true);
  });
});

describe('shortcut configuration', () => {
  it('preserves existing keys, fills new defaults, and supports disabling', () => {
    const config = resolveHotkeys({ hotkeyToggle: 'Alt+Q', hotkeyClear: '' });
    expect(config.hotkeyToggle).toBe('Alt+Q');
    expect(config.hotkeyStop).toBe('Control+Alt+S');
    expect(config.hotkeyClear).toBe('');
    expect(() => validateHotkeys(config)).not.toThrow();
  });
  it('rejects modifier-order aliases, reserved keys, and plain character shortcuts', () => {
    expect(() => validateHotkeys(resolveHotkeys({ hotkeyClear: 'Alt+Ctrl+S' }))).toThrow(/Duplicate/);
    expect(() => validateHotkeys(resolveHotkeys({ hotkeyStop: 'Ctrl+Alt+Delete' }))).toThrow(/reserved/);
    expect(() => validateHotkeys(resolveHotkeys({ hotkeyStop: 'S' }))).toThrow();
  });
});

describe('DPI movement regression', () => {
  it('keeps the requested size stable and stops issuing calls at desktop edges', () => {
    let bounds = { x: 100, y: 100, width: 940, height: 560 };
    let calls = 0;
    const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
      getBounds: () => ({ ...bounds }), setBounds: (next: typeof bounds) => { calls++; bounds = { ...next, width: next.width + 1, height: next.height + 1 }; } };
    const move = createWindowMover();
    const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
    for (let i = 0; i < 100; i++) move(window, areas, i % 2 ? 40 : -40, 0);
    expect(bounds).toMatchObject({ width: 941, height: 561 });
    bounds = { ...bounds, x: 0, y: 0 };
    const before = calls;
    for (let i = 0; i < 100; i++) { move(window, areas, -40, 0); move(window, areas, 0, -40); }
    expect(calls).toBe(before);
    bounds = { x: 100, y: 100, width: 1100, height: 700 };
    move(window, areas, 40, 0);
    expect(bounds).toMatchObject({ width: 1101, height: 701 });
  });
});

describe('provider diagnostic details', () => {
  it('retains HTTP and provider reasons while redacting credentials', () => {
    const result = normalizeProviderError(new Error('HTTP 403: forbidden ul-test12345 arbitrary-secret'),
      { capability: 'vision', providerId: 'custom' }, ['arbitrary-secret']);
    expect(result.httpStatus).toBe(403);
    expect(result.upstreamMessage).toContain('forbidden');
    expect(result.upstreamMessage).not.toContain('ul-test12345');
    expect(result.upstreamMessage).not.toContain('arbitrary-secret');
  });
  it('describes the actual route without URL credentials or query secrets', () => {
    expect(testRoute({ capability: 'vision', providerId: 'custom', baseUrl: 'https://user:password@example.com/v1?api_key=hidden', model: 'vision' }))
      .toMatchObject({ endpoint: 'https://example.com/v1', proxyRoute: 'DIRECT' });
    expect(testRoute({ capability: 'vision', providerId: 'custom', baseUrl: 'https://example.com/v1', model: 'vision', proxyUrl: '127.0.0.1:7890' }).proxyRoute)
      .toBe('http://127.0.0.1:7890/');
  });
});
