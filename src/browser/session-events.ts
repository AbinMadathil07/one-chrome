import type { DownloadPayload } from '../bridge/protocol.js';
import type { SessionId, TabId } from '../types.js';

export type DownloadChange =
  | { type: 'download_started'; download_id: string; url: string }
  | { type: 'download_completed'; download_id: string; url: string; path?: string; size_bytes?: number }
  | { type: 'download_failed'; download_id: string; url: string; error?: string };

type Pending = { tabsOpened: TabId[]; downloads: Map<string, DownloadChange> };

function stripQuery(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw;
  }
}

export function toDownloadChange(payload: DownloadPayload): DownloadChange {
  const downloadId = `dl-${payload.id}`;
  const url = stripQuery(payload.url);
  if (payload.state === 'complete') {
    return {
      type: 'download_completed',
      download_id: downloadId,
      url,
      ...(payload.filename ? { path: payload.filename } : {}),
      ...(payload.fileSize != null ? { size_bytes: payload.fileSize } : {}),
    };
  }
  if (payload.state === 'interrupted') {
    return { type: 'download_failed', download_id: downloadId, url, ...(payload.error ? { error: payload.error } : {}) };
  }
  return { type: 'download_started', download_id: downloadId, url };
}

/**
 * Side effects the browser produced for a session between member calls (popups, downloads).
 * Drained into `state_changes` on the next successful result, one entry per download id.
 */
export class SessionEvents {
  private readonly pending = new Map<SessionId, Pending>();
  private readonly recentDownloads: DownloadChange[] = [];

  constructor(private readonly maxRecent = 50) {}

  private bucket(sessionId: SessionId): Pending {
    let bucket = this.pending.get(sessionId);
    if (!bucket) {
      bucket = { tabsOpened: [], downloads: new Map() };
      this.pending.set(sessionId, bucket);
    }
    return bucket;
  }

  recordTabOpened(sessionId: SessionId, tabId: TabId): void {
    const bucket = this.bucket(sessionId);
    if (!bucket.tabsOpened.includes(tabId)) bucket.tabsOpened.push(tabId);
  }

  recordDownload(sessionId: SessionId | null, change: DownloadChange): void {
    this.recentDownloads.push(change);
    if (this.recentDownloads.length > this.maxRecent) this.recentDownloads.shift();
    if (sessionId) this.bucket(sessionId).downloads.set(change.download_id, change);
  }

  drain(sessionId: SessionId): { tabsOpened: TabId[]; downloads: DownloadChange[] } {
    const bucket = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    return { tabsOpened: bucket?.tabsOpened ?? [], downloads: [...(bucket?.downloads.values() ?? [])] };
  }

  /** Puts drained events back when the call they were meant for failed. */
  restore(sessionId: SessionId, drained: { tabsOpened: TabId[]; downloads: DownloadChange[] }): void {
    const bucket = this.bucket(sessionId);
    for (const tabId of drained.tabsOpened) {
      if (!bucket.tabsOpened.includes(tabId)) bucket.tabsOpened.unshift(tabId);
    }
    for (const change of drained.downloads) {
      if (!bucket.downloads.has(change.download_id)) bucket.downloads.set(change.download_id, change);
    }
  }

  forget(sessionId: SessionId): void {
    this.pending.delete(sessionId);
  }

  downloads(): DownloadChange[] {
    return [...this.recentDownloads];
  }
}
