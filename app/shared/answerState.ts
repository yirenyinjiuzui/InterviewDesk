import { measuredMs } from './latency';
import type { LlmEvent, StoredSession, StoredTurn } from './protocol';

export function updateAnswers(sessions: StoredSession[], event: LlmEvent, now = Date.now()): StoredSession[] {
  return sessions.map((session) => ({
    ...session,
    turns: session.turns.map((turn) => {
      if (turn.id !== event.requestId || turn.status !== 'streaming') return turn;
      if (event.kind === 'shot-sent') return { ...turn, requestStartedAt: event.sentAt };
      if (event.kind === 'model') return { ...turn, modelName: event.modelName, visionSlot: event.visionSlot, bankQuestion: event.bankQuestion };
      if (event.kind === 'delta') return { ...turn, text: turn.text + event.text, firstTokenMs: turn.firstTokenMs ?? (event.text ? measuredMs(now, turn.requestStartedAt) : undefined) };
      if (event.kind === 'done') return { ...turn, text: event.text || turn.text, status: 'done', bankQuestion: event.bankQuestion ?? turn.bankQuestion, completedMs: measuredMs(now, turn.requestStartedAt), firstTokenMs: turn.firstTokenMs ?? ((event.text || turn.text) ? measuredMs(now, turn.requestStartedAt) : undefined) };
      if (event.kind === 'cancelled') return { ...turn, status: 'cancelled', error: event.message };
      return { ...turn, status: 'error', error: event.message };
    }),
  }));
}

export function stopAnswers(sessions: StoredSession[]): StoredSession[] {
  return sessions.map((session) => ({
    ...session,
    turns: session.turns.map((turn) => turn.status === 'streaming' ? { ...turn, status: 'cancelled' } : turn),
  }));
}

export function answerHistory(turns: StoredTurn[], visionSlot?: StoredTurn['visionSlot']): { role: 'user' | 'assistant'; content: string }[] {
  return turns.filter((turn) => turn.status === 'done' && turn.kind !== 'translate' &&
    (!visionSlot || !turn.visionSlot || turn.visionSlot === visionSlot)).slice(-8)
    .flatMap((turn) => [{ role: 'user', content: turn.label }, { role: 'assistant', content: turn.text }]);
}

/** Clearing the reading feed preserves separately saved scripts. */
export function clearSessionAnswers(session: StoredSession): StoredSession {
  return { ...session, turns: [] };
}

export function setQuestionTranslation(session: StoredSession, batchId: string,
  patch: Pick<Partial<StoredTurn>, 'questionTranslation' | 'questionTranslationError' | 'questionTranslating'>): StoredSession {
  return { ...session, turns: session.turns.map((turn) => (turn.batchId ?? turn.id) === batchId ? { ...turn, ...patch } : turn) };
}

export function restoreReadingTurn(turn: StoredTurn): StoredTurn {
  return { ...turn, questionTranslating: false,
    status: turn.status === 'streaming' ? 'cancelled' : turn.status };
}
