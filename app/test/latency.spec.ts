import { describe, expect, it } from 'vitest';
import { measuredMs, transcriptLatency, durationText } from '../shared/latency';
import { updateAnswers, stopAnswers } from '../shared/answerState';
import type { StoredSession } from '../shared/protocol';
describe('measured latency', () => {
  it('keeps missing, non-finite and negative intervals unknown', () => {
    expect(measuredMs(undefined, 0)).toBeUndefined(); expect(measuredMs(0, 1)).toBeUndefined(); expect(measuredMs(NaN, 0)).toBeUndefined();
    expect(durationText()).toBe('—'); expect(durationText(-1)).toBe('—'); expect(measuredMs(5, 5)).toBe(0);
  });
  it('separates sentence-start-to-first-text from sentence-end-to-final and pure inference', () => {
    const t = { speechStartTs: 1000, speechEndTs: 2000, vadCloseTs: 2100, inferStartTs: 2000, inferEndTs: 2500, firstTextTs: 1300, timingKind: 'stream' as const };
    expect(transcriptLatency(t, 2600)).toEqual({ firstMs: 300, finalMs: 600, inferMs: undefined });
    expect(transcriptLatency({ ...t, timingValid: false }, 2600).finalMs).toBeUndefined();
  });
  it('times screenshot answers from transport dispatch, including non-streaming providers', () => {
    let sessions: StoredSession[] = [{ id: 's', name: 's', createdAt: 0, turns: [
      { id: 'r', kind: 'vision', label: '', text: '', status: 'streaming', captureStartedAt: 100, imageReadyAt: 330 },
    ] }];
    sessions = updateAnswers(sessions, { requestId: 'r', kind: 'shot-sent', sentAt: 400 }, 410);
    const turn = updateAnswers(sessions, { requestId: 'r', kind: 'done', text: 'answer' }, 1500)[0].turns[0];
    expect(measuredMs(turn.imageReadyAt, turn.captureStartedAt)).toBe(230);
    expect(measuredMs(turn.requestStartedAt, turn.imageReadyAt)).toBe(70);
    expect(turn.firstTokenMs).toBe(1100);
  });
  it('records first answer content once and completion separately; cancellation preserves source', () => {
    let sessions: StoredSession[] = [{ id: 's', name: 's', createdAt: 0, turns: [{ id: 'r', kind: 'free', label: 'q', text: '', status: 'streaming', requestStartedAt: 1000 }] }];
    sessions = updateAnswers(sessions, { requestId: 'r', kind: 'delta', text: '' }, 1050);
    expect(sessions[0].turns[0].firstTokenMs).toBeUndefined();
    sessions = updateAnswers(sessions, { requestId: 'r', kind: 'delta', text: 'first' }, 1200);
    sessions = updateAnswers(sessions, { requestId: 'r', kind: 'delta', text: ' next' }, 1400);
    expect(sessions[0].turns[0].firstTokenMs).toBe(200);
    const stopped = stopAnswers(sessions);
    expect(updateAnswers(stopped, { requestId: 'r', kind: 'done', text: 'late' }, 2000)).toEqual(stopped);
    sessions = updateAnswers(sessions, { requestId: 'r', kind: 'done', text: 'full' }, 2000);
    expect(sessions[0].turns[0]).toMatchObject({ firstTokenMs: 200, completedMs: 1000 });
  });
  it('treats non-streaming first content as its full response and legacy turns as unknown', () => {
    const s: StoredSession[] = [{ id: 's', name: 's', createdAt: 0, turns: [{ id: 'r', kind: 'free', label: 'q', text: '', status: 'streaming', requestStartedAt: 1000 }] }];
    expect(updateAnswers(s, { requestId: 'r', kind: 'done', text: 'full' }, 1500)[0].turns[0]).toMatchObject({ firstTokenMs: 500, completedMs: 500 });
    delete s[0].turns[0].requestStartedAt;
    expect(updateAnswers(s, { requestId: 'r', kind: 'done', text: 'full' }, 1500)[0].turns[0].firstTokenMs).toBeUndefined();
  });
});
