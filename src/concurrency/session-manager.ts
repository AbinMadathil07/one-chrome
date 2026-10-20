import { randomUUID } from 'node:crypto';
import type { ClientId, SessionId, SessionInfo, TabId } from '../types.js';

export class SessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLimitError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionManager {
  private readonly sessions = new Map<SessionId, SessionInfo>();

  constructor(
    private readonly maxSessions: number,
    private readonly maxTabsPerSession: number,
    private readonly idleSessionTtlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  create(clientId: ClientId, label = 'anonymous'): SessionInfo {
    this.sweepIdle();
    if (this.sessions.size >= this.maxSessions) {
      throw new SessionLimitError(
        `Max concurrent sessions reached (${this.maxSessions}). Close idle MCP clients or raise CHROME_MCP_MAX_SESSIONS.`,
      );
    }

    const session: SessionInfo = {
      sessionId: randomUUID(),
      clientId,
      label,
      createdAt: this.now(),
      lastSeenAt: this.now(),
      ownedTabIds: [],
      activeTabId: null,
    };
    this.sessions.set(session.sessionId, session);
    return { ...session, ownedTabIds: [...session.ownedTabIds] };
  }

  get(sessionId: SessionId): SessionInfo {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return { ...session, ownedTabIds: [...session.ownedTabIds] };
  }

  touch(sessionId: SessionId): void {
    const session = this.require(sessionId);
    session.lastSeenAt = this.now();
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => ({
      ...session,
      ownedTabIds: [...session.ownedTabIds],
    }));
  }

  destroy(sessionId: SessionId): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    this.sessions.delete(sessionId);
    return { ...session, ownedTabIds: [...session.ownedTabIds] };
  }

  attachTab(sessionId: SessionId, tabId: TabId): SessionInfo {
    const session = this.require(sessionId);
    if (!session.ownedTabIds.includes(tabId)) {
      if (session.ownedTabIds.length >= this.maxTabsPerSession) {
        throw new SessionLimitError(
          `Session ${sessionId} already owns ${this.maxTabsPerSession} tabs. Close one before creating another.`,
        );
      }
      session.ownedTabIds.push(tabId);
    }
    session.activeTabId = tabId;
    session.lastSeenAt = this.now();
    return this.get(sessionId);
  }

  /** Adds a tab the page opened (popup, target=_blank) without moving the session's active tab. */
  adoptTab(sessionId: SessionId, tabId: TabId): boolean {
    const session = this.require(sessionId);
    if (session.ownedTabIds.includes(tabId)) return true;
    if (session.ownedTabIds.length >= this.maxTabsPerSession) return false;
    session.ownedTabIds.push(tabId);
    return true;
  }

  findOwner(tabId: TabId): SessionId | null {
    for (const session of this.sessions.values()) {
      if (session.ownedTabIds.includes(tabId)) return session.sessionId;
    }
    return null;
  }

  detachTab(sessionId: SessionId, tabId: TabId): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.ownedTabIds = session.ownedTabIds.filter((id) => id !== tabId);
    if (session.activeTabId === tabId) {
      session.activeTabId = session.ownedTabIds[session.ownedTabIds.length - 1] ?? null;
    }
  }

  detachTabEverywhere(tabId: TabId): SessionId[] {
    const affected: SessionId[] = [];
    for (const session of this.sessions.values()) {
      if (session.ownedTabIds.includes(tabId)) {
        this.detachTab(session.sessionId, tabId);
        affected.push(session.sessionId);
      }
    }
    return affected;
  }

  setActiveTab(sessionId: SessionId, tabId: TabId): SessionInfo {
    const session = this.require(sessionId);
    if (!session.ownedTabIds.includes(tabId)) {
      throw new Error(`Tab ${tabId} is not owned by session ${sessionId}`);
    }
    session.activeTabId = tabId;
    session.lastSeenAt = this.now();
    return this.get(sessionId);
  }

  resolveTab(sessionId: SessionId, tabId?: TabId | null): TabId {
    const session = this.require(sessionId);
    if (tabId != null) {
      if (!session.ownedTabIds.includes(tabId)) {
        throw new Error(
          `Tab ${tabId} is not owned by session ${sessionId}. Use session_open_tab or attach an owned tab first.`,
        );
      }
      return tabId;
    }
    if (session.activeTabId == null) {
      throw new Error(
        `Session ${sessionId} has no active tab. Call session_open_tab first so this model gets its own browser context.`,
      );
    }
    return session.activeTabId;
  }

  sweepIdle(now = this.now()): SessionInfo[] {
    const expired: SessionInfo[] = [];
    for (const session of this.sessions.values()) {
      if (now - session.lastSeenAt > this.idleSessionTtlMs) {
        expired.push(this.destroy(session.sessionId)!);
      }
    }
    return expired;
  }

  private require(sessionId: SessionId): SessionInfo {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  }
}
