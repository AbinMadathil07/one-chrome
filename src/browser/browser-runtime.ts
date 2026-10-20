import type { HostConfig } from '../config.js';
import { MutexQueue } from '../concurrency/mutex-queue.js';
import { SessionManager } from '../concurrency/session-manager.js';
import { TabLeaseManager } from '../concurrency/tab-lease-manager.js';
import type { ExtensionBridge } from '../bridge/extension-bridge.js';
import type { DownloadPayload, TabCreatedPayload } from '../bridge/protocol.js';
import { SessionEvents, toDownloadChange } from './session-events.js';
import type {
  BridgeCommandName,
  LeaseInfo,
  SessionId,
  SessionInfo,
  TabId,
  TabSnapshot,
} from '../types.js';

const MAX_TRACKED_DOWNLOADS = 500;
const RECENT_ACTIVITY_MS = 30_000;

export class BrowserRuntime {
  readonly sessions: SessionManager;
  readonly leases: TabLeaseManager;
  readonly events = new SessionEvents();
  private readonly tabQueue = new MutexQueue();
  private readonly downloadOwners = new Map<number, SessionId | null>();

  constructor(
    private readonly config: HostConfig,
    private readonly bridge: ExtensionBridge,
  ) {
    this.sessions = new SessionManager(
      config.maxSessions,
      config.maxTabsPerSession,
      config.idleSessionTtlMs,
    );
    this.leases = new TabLeaseManager(config.leaseTtlMs, config.allowSharedTabs);

    bridge.on('tab_removed', (tabId: number) => {
      this.sessions.detachTabEverywhere(tabId);
      this.leases.releaseTab(tabId);
    });
    bridge.on('tab_created', (payload: TabCreatedPayload) => this.onTabCreated(payload));
    bridge.on('download', (payload: DownloadPayload) => {
      void this.onDownload(payload).catch((error: unknown) => {
        console.error(
          `logName=downloadAttributionFailed, downloadId=${payload.id}, error=${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  private onTabCreated(payload: TabCreatedPayload): void {
    const owner = this.sessions.findOwner(payload.openerTabId);
    if (!owner) return;
    if (this.sessions.adoptTab(owner, payload.tabId)) {
      this.events.recordTabOpened(owner, payload.tabId);
    } else {
      console.error(`logName=popupAdoptionSkipped, reason=maxTabsPerSession, tabId=${payload.tabId}`);
    }
  }

  private async onDownload(payload: DownloadPayload): Promise<void> {
    const known = this.downloadOwners.get(payload.id);
    const owner = known !== undefined ? known : await this.attributeDownload(payload.referrer);
    this.downloadOwners.set(payload.id, owner);
    if (this.downloadOwners.size > MAX_TRACKED_DOWNLOADS) {
      const oldest = this.downloadOwners.keys().next().value;
      if (oldest !== undefined) this.downloadOwners.delete(oldest);
    }
    const sessionExists = owner != null && this.sessions.list().some((s) => s.sessionId === owner);
    this.events.recordDownload(sessionExists ? owner : null, toDownloadChange(payload));
  }

  private async attributeDownload(referrer: string): Promise<SessionId | null> {
    const sessions = this.sessions.list();
    if (sessions.length === 0) return null;
    if (referrer) {
      const tabs = await this.listChromeTabs();
      const origin = (value: string) => {
        try {
          return new URL(value).origin;
        } catch {
          return null;
        }
      };
      const byExact = tabs.find((tab) => tab.url === referrer && this.sessions.findOwner(tab.tabId));
      const byOrigin = tabs.find((tab) => origin(tab.url) === origin(referrer) && this.sessions.findOwner(tab.tabId));
      const match = byExact ?? byOrigin;
      if (match) return this.sessions.findOwner(match.tabId);
    }
    const recent = [...sessions].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    return recent && Date.now() - recent.lastSeenAt < RECENT_ACTIVITY_MS ? recent.sessionId : null;
  }

  createSession(clientId: string, label?: string): SessionInfo {
    return this.sessions.create(clientId, label);
  }

  getSession(sessionId: SessionId): SessionInfo {
    return this.sessions.get(sessionId);
  }

  listSessions(): SessionInfo[] {
    return this.sessions.list();
  }

  async closeSession(sessionId: SessionId, closeOwnedTabs: boolean): Promise<SessionInfo | null> {
    const session = this.sessions.destroy(sessionId);
    this.leases.releaseSession(sessionId);
    this.events.forget(sessionId);
    if (!session) {
      return null;
    }
    if (closeOwnedTabs) {
      await Promise.all(
        session.ownedTabIds.map(async (tabId) => {
          try {
            await this.bridge.sendCommand('close_tab', {}, tabId);
          } catch (error) {
            console.error(
              `logName=closeSessionTabFailed, tabId=${tabId}, error=${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
      );
    }
    return session;
  }

  async openTab(
    sessionId: SessionId,
    options: { url?: string; active?: boolean; devtools?: boolean; group?: boolean } = {},
  ): Promise<TabSnapshot> {
    const session = this.sessions.get(sessionId);
    this.sessions.touch(sessionId);
    const result = (await this.bridge.sendCommand('create_tab', {
      url: options.url,
      active: options.active ?? false,
      devtools: options.devtools ?? true,
      group: options.group === false ? undefined : { key: sessionId, title: session.label },
    })) as TabSnapshot;
    this.sessions.attachTab(sessionId, result.tabId);
    return result;
  }

  /** Runs several commands back to back under one exclusive lease, so no other model can interleave. */
  async runBatch(options: {
    sessionId: SessionId;
    tabId?: TabId | null;
    steps: Array<{ command: BridgeCommandName; args: Record<string, unknown> }>;
    stopOnError: boolean;
  }): Promise<Array<{ step: number; command: string; ok: boolean; result?: unknown; error?: string }>> {
    this.sessions.touch(options.sessionId);
    const tabId = this.sessions.resolveTab(options.sessionId, options.tabId);
    return this.tabQueue.run(`tab:${tabId}`, () =>
      this.withExclusiveLease(options.sessionId, tabId, async () => {
        const results: Array<{ step: number; command: string; ok: boolean; result?: unknown; error?: string }> = [];
        for (const [index, step] of options.steps.entries()) {
          try {
            const result = await this.bridge.sendCommand(step.command, step.args, tabId);
            results.push({ step: index, command: step.command, ok: true, result });
          } catch (error) {
            results.push({
              step: index,
              command: step.command,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
            if (options.stopOnError) break;
          }
        }
        return results;
      }),
    );
  }

  async attachExistingTab(sessionId: SessionId, tabId: TabId): Promise<TabSnapshot> {
    this.sessions.touch(sessionId);
    const tabs = (await this.bridge.sendCommand('list_tabs')) as TabSnapshot[];
    const tab = tabs.find((item) => item.tabId === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} was not found in Chrome`);
    }
    this.sessions.attachTab(sessionId, tabId);
    return tab;
  }

  async closeTab(sessionId: SessionId, tabId?: TabId): Promise<void> {
    const resolved = this.sessions.resolveTab(sessionId, tabId);
    await this.withExclusiveLease(sessionId, resolved, async () => {
      await this.bridge.sendCommand('close_tab', {}, resolved);
    });
    this.sessions.detachTab(sessionId, resolved);
    this.leases.releaseTab(resolved);
  }

  async listChromeTabs(): Promise<TabSnapshot[]> {
    return (await this.bridge.sendCommand('list_tabs')) as TabSnapshot[];
  }

  /** Lock-free tab command for state that does not touch page content (dialogs, tab metadata). */
  async sendUnleased<T>(command: BridgeCommandName, args: Record<string, unknown>, tabId: TabId): Promise<T> {
    return (await this.bridge.sendCommand(command, args, tabId)) as T;
  }

  async runOnTab<T>(options: {
    sessionId: SessionId;
    tabId?: TabId | null;
    exclusive?: boolean;
    command: BridgeCommandName;
    args?: Record<string, unknown>;
  }): Promise<T> {
    this.sessions.touch(options.sessionId);
    const tabId = this.sessions.resolveTab(options.sessionId, options.tabId);
    const exclusive = options.exclusive ?? true;
    const invoke = () =>
      this.bridge.sendCommand(options.command, options.args ?? {}, tabId) as Promise<T>;

    if (exclusive) {
      // Mutations: exclusive lease + per-tab queue so two models never interleave clicks/fills.
      return this.tabQueue.run(`tab:${tabId}`, () =>
        this.withExclusiveLease(options.sessionId, tabId, invoke),
      );
    }

    // Reads: shared leases may overlap when no exclusive holder is active.
    return this.withSharedLease(options.sessionId, tabId, invoke);
  }

  status() {
    return {
      bridgeConnected: this.bridge.isConnected(),
      sessions: this.sessions.list(),
      leases: this.leases.list(),
      queuedTabs: this.tabQueue.pendingKeys(),
      limits: {
        maxSessions: this.config.maxSessions,
        maxTabsPerSession: this.config.maxTabsPerSession,
        leaseTtlMs: this.config.leaseTtlMs,
        allowSharedTabs: this.config.allowSharedTabs,
      },
    };
  }

  private async withExclusiveLease<T>(
    sessionId: SessionId,
    tabId: TabId,
    task: () => Promise<T>,
  ): Promise<T> {
    const lease = await this.leases.acquire(sessionId, tabId, {
      exclusive: true,
      ttlMs: this.config.leaseTtlMs,
      waitMs: this.config.leaseTtlMs,
    });
    return this.runWithLease(lease, task);
  }

  private async withSharedLease<T>(
    sessionId: SessionId,
    tabId: TabId,
    task: () => Promise<T>,
  ): Promise<T> {
    const lease = await this.leases.acquire(sessionId, tabId, {
      exclusive: false,
      ttlMs: this.config.leaseTtlMs,
      waitMs: this.config.leaseTtlMs,
    });
    return this.runWithLease(lease, task);
  }

  private async runWithLease<T>(lease: LeaseInfo, task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } finally {
      this.leases.release(lease.leaseId);
    }
  }
}
