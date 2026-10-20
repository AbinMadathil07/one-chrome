import { randomUUID } from 'node:crypto';
import type { LeaseId, LeaseInfo, SessionId, TabId } from '../types.js';

type Waiter = {
  sessionId: SessionId;
  exclusive: boolean;
  resolve: (lease: LeaseInfo) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class LeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseConflictError';
  }
}

export class LeaseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseTimeoutError';
  }
}

/**
 * Tab leasing lets multiple MCP clients share Chrome safely.
 *
 * - Exclusive leases serialize mutate operations on a tab.
 * - Shared (read) leases may coexist when no exclusive holder is active.
 * - Waiters queue FIFO when the requested mode conflicts.
 */
export class TabLeaseManager {
  private readonly leases = new Map<TabId, LeaseInfo[]>();
  private readonly waiters = new Map<TabId, Waiter[]>();

  constructor(
    private readonly defaultTtlMs: number,
    private readonly allowSharedTabs: boolean,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async acquire(
    sessionId: SessionId,
    tabId: TabId,
    options: { exclusive?: boolean; ttlMs?: number; waitMs?: number } = {},
  ): Promise<LeaseInfo> {
    const exclusive = options.exclusive ?? true;
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const waitMs = options.waitMs ?? ttlMs;

    this.expireStale(tabId);

    if (!exclusive && !this.allowSharedTabs) {
      throw new LeaseConflictError(
        'Shared tab leases are disabled. Set CHROME_MCP_ALLOW_SHARED_TABS=true or use an exclusive lease.',
      );
    }

    if (this.canGrant(tabId, exclusive)) {
      return this.grant(sessionId, tabId, exclusive, ttlMs);
    }

    return new Promise<LeaseInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(tabId, waiter);
        reject(
          new LeaseTimeoutError(
            `Timed out waiting ${waitMs}ms for ${exclusive ? 'exclusive' : 'shared'} lease on tab ${tabId}`,
          ),
        );
      }, waitMs);

      const waiter: Waiter = {
        sessionId,
        exclusive,
        resolve,
        reject,
        timer,
      };
      const queue = this.waiters.get(tabId) ?? [];
      queue.push(waiter);
      this.waiters.set(tabId, queue);
    });
  }

  release(leaseId: LeaseId): LeaseInfo | null {
    for (const [tabId, holders] of this.leases.entries()) {
      const index = holders.findIndex((lease) => lease.leaseId === leaseId);
      if (index === -1) {
        continue;
      }
      const [removed] = holders.splice(index, 1);
      if (holders.length === 0) {
        this.leases.delete(tabId);
      }
      this.drain(tabId);
      return removed ?? null;
    }
    return null;
  }

  releaseSession(sessionId: SessionId): LeaseInfo[] {
    const released: LeaseInfo[] = [];
    for (const [tabId, holders] of [...this.leases.entries()]) {
      const remaining = holders.filter((lease) => {
        if (lease.sessionId === sessionId) {
          released.push(lease);
          return false;
        }
        return true;
      });
      if (remaining.length === 0) {
        this.leases.delete(tabId);
      } else {
        this.leases.set(tabId, remaining);
      }
      this.rejectWaitersForSession(tabId, sessionId, 'Session closed');
      this.drain(tabId);
    }

    for (const tabId of this.waiters.keys()) {
      this.rejectWaitersForSession(tabId, sessionId, 'Session closed');
    }

    return released;
  }

  releaseTab(tabId: TabId): void {
    this.leases.delete(tabId);
    const queue = this.waiters.get(tabId) ?? [];
    for (const waiter of queue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Tab ${tabId} was closed`));
    }
    this.waiters.delete(tabId);
  }

  list(): LeaseInfo[] {
    this.expireAll();
    return [...this.leases.values()].flat().map((lease) => ({ ...lease }));
  }

  snapshot(tabId: TabId): { holders: LeaseInfo[]; waiting: number } {
    this.expireStale(tabId);
    return {
      holders: [...(this.leases.get(tabId) ?? [])].map((lease) => ({ ...lease })),
      waiting: this.waiters.get(tabId)?.length ?? 0,
    };
  }

  private canGrant(tabId: TabId, exclusive: boolean): boolean {
    const holders = this.leases.get(tabId) ?? [];
    if (holders.length === 0) {
      return true;
    }
    if (exclusive) {
      return false;
    }
    return holders.every((lease) => !lease.exclusive);
  }

  private grant(
    sessionId: SessionId,
    tabId: TabId,
    exclusive: boolean,
    ttlMs: number,
  ): LeaseInfo {
    const acquiredAt = this.now();
    const lease: LeaseInfo = {
      leaseId: randomUUID(),
      tabId,
      sessionId,
      exclusive,
      acquiredAt,
      expiresAt: acquiredAt + ttlMs,
    };
    const holders = this.leases.get(tabId) ?? [];
    holders.push(lease);
    this.leases.set(tabId, holders);
    return { ...lease };
  }

  private drain(tabId: TabId): void {
    this.expireStale(tabId);
    const queue = this.waiters.get(tabId);
    if (!queue || queue.length === 0) {
      return;
    }

    while (queue.length > 0) {
      const next = queue[0]!;
      if (!this.canGrant(tabId, next.exclusive)) {
        break;
      }
      queue.shift();
      clearTimeout(next.timer);
      const lease = this.grant(next.sessionId, tabId, next.exclusive, this.defaultTtlMs);
      next.resolve(lease);
      if (next.exclusive) {
        break;
      }
    }

    if (queue.length === 0) {
      this.waiters.delete(tabId);
    }
  }

  private expireStale(tabId: TabId): void {
    const holders = this.leases.get(tabId);
    if (!holders) {
      return;
    }
    const now = this.now();
    const remaining = holders.filter((lease) => lease.expiresAt > now);
    if (remaining.length === 0) {
      this.leases.delete(tabId);
    } else {
      this.leases.set(tabId, remaining);
    }
  }

  private expireAll(): void {
    for (const tabId of [...this.leases.keys()]) {
      this.expireStale(tabId);
      this.drain(tabId);
    }
  }

  private removeWaiter(tabId: TabId, waiter: Waiter): void {
    const queue = this.waiters.get(tabId);
    if (!queue) {
      return;
    }
    const index = queue.indexOf(waiter);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    if (queue.length === 0) {
      this.waiters.delete(tabId);
    }
  }

  private rejectWaitersForSession(tabId: TabId, sessionId: SessionId, reason: string): void {
    const queue = this.waiters.get(tabId);
    if (!queue) {
      return;
    }
    const remaining: Waiter[] = [];
    for (const waiter of queue) {
      if (waiter.sessionId === sessionId) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      } else {
        remaining.push(waiter);
      }
    }
    if (remaining.length === 0) {
      this.waiters.delete(tabId);
    } else {
      this.waiters.set(tabId, remaining);
    }
  }
}
