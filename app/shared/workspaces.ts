import type { StoredSession } from './protocol';

export function sessionWorkspace(session: StoredSession) {
  return session.workspace ?? 'interview';
}
