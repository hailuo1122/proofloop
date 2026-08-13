export interface Session {
  userId: string;
  createdAt: number;
}

export interface TokenPayload {
  userId: string;
  exp: number;
}

/**
 * Demo PR head: expired tokens must not create sessions.
 */
export function createSession(token: TokenPayload, now = Date.now()): Session | null {
  if (token.exp <= now) return null;
  return {
    userId: token.userId,
    createdAt: now,
  };
}

export function isSessionActive(session: Session, now = Date.now(), ttlMs = 3_600_000): boolean {
  return now - session.createdAt < ttlMs;
}
