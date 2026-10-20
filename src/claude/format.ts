export type BrowserTab = { tab_id: string; title: string; url: string; active?: true };

export type StateChange =
  | { type: 'tab_opened'; tab_id: string }
  | { type: 'download_started'; download_id: string; url: string }
  | { type: 'download_completed'; download_id: string; url: string; path?: string; size_bytes?: number }
  | { type: 'download_failed'; download_id: string; url: string; error?: string };

export type BrowserState = { type: 'browser_state'; tabs: BrowserTab[]; state_changes?: StateChange[] };

const MAX_FIELD = 4096;
const MAX_TITLE = 300;
const TAB_ID_PATTERN = /^(?:tab-)?(\d{1,10})$/;
// Control characters plus Unicode line/paragraph separators, which the API rejects in browser_state fields.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const SENSITIVE_PARAM = /(token|key|secret|password|passwd|pwd|auth|session|sig|signature|code|credential|jwt|bearer)/i;
const JWT_PATTERN = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE_PATTERN =
  /\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|authorization)[\w-]*)(["']?\s*[:=]\s*["']?)([^\s"'&,;}]{4,})/gi;

export const PRIVATE_HOST_PATTERNS = [
  /^localhost$/,
  /\.localhost$/,
  /\.local$/,
  /\.internal$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

export function formatTabId(tabId: number): string {
  return `tab-${tabId}`;
}

export function parseTabId(value: string): number {
  const match = String(value).trim().match(TAB_ID_PATTERN);
  if (!match) {
    throw new Error(`Invalid tab_id ${JSON.stringify(String(value).slice(0, 80))}. Use a tab_id from list_tabs, such as "tab-12".`);
  }
  return Number(match[1]);
}

export function sanitizeText(value: string, max = MAX_FIELD): string {
  const clean = String(value ?? '').replace(UNSAFE_CHARS, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Drops embedded credentials (and optionally the query) from page-supplied URLs. */
export function sanitizeUrl(raw: string, { stripQuery = false } = {}): string {
  const value = sanitizeText(raw);
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    if (stripQuery) {
      url.search = '';
      url.hash = '';
    } else {
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, 'REDACTED');
      }
    }
    return sanitizeText(url.toString());
  } catch {
    return value;
  }
}

export function sanitizeTitle(raw: string): string {
  return sanitizeText(raw, MAX_TITLE);
}

/** Escapes the way the Claude API renders quoted values, for our own text rendering. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderTabLine(tab: BrowserTab, markCurrent: boolean): string {
  const current = markCurrent && tab.active ? ' (current)' : '';
  return `  • tab_id ${tab.tab_id}: ${quote(tab.title)} (${tab.url})${current}`;
}

export function renderTabList(tabs: BrowserTab[]): string {
  if (tabs.length === 0) return 'No tabs available';
  return ['Available tabs:', ...tabs.map((tab) => renderTabLine(tab, true))].join('\n');
}

export function renderTabContext(executedOn: string | null, tabs: BrowserTab[]): string {
  const lines = ['Tab Context:'];
  if (executedOn) lines.push(`- Executed on tab_id: ${executedOn}`);
  lines.push('- Available tabs:', ...tabs.map((tab) => renderTabLine(tab, false)));
  return lines.join('\n');
}

export function renderStateChange(change: StateChange): string | null {
  switch (change.type) {
    case 'download_started':
      return `Download started with download_id: ${change.download_id}, URL: ${quote(change.url)}.`;
    case 'download_completed': {
      const parts = [`Download completed with download_id: ${change.download_id}, URL: ${quote(change.url)}.`];
      if (change.path) parts.push(`Saved to ${quote(change.path)}.`);
      if (change.size_bytes != null) parts.push(`Size: ${change.size_bytes} bytes.`);
      return parts.join(' ');
    }
    case 'download_failed':
      return `Download failed with download_id: ${change.download_id}, URL: ${quote(change.url)}.${change.error ? ` Error: ${quote(change.error)}.` : ''}`;
    default:
      return null;
  }
}

/** Converts our snapshot lines (`- role "name" [ref=e3]`) into Claude's `[ref_3]` tagged tree. */
export function toClaudeTree(snapshot: string): string {
  return snapshot
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('… truncated'))
    .map((line) => line.replace(/^(\s*)- /, '$1').replace(/\[ref=e(\d+)\]/g, '[ref_$1]'))
    .join('\n');
}

export function redactSecrets(text: string): string {
  return String(text)
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(BEARER_PATTERN, '$1 [REDACTED]')
    .replace(KEY_VALUE_PATTERN, '$1$2[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => sanitizeUrl(url));
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class NavigationRefusedError extends Error {
  constructor(message = 'Navigation refused. Only http and https URLs are allowed.') {
    super(message);
    this.name = 'NavigationRefusedError';
  }
}

export type NavigateTarget = { kind: 'history'; action: 'back' | 'forward' | 'reload' } | { kind: 'url'; url: string };

const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const OPAQUE_SCHEMES = /^(javascript|data|file|about|chrome|chrome-extension|mailto|blob|view-source|vbscript|ftp|ws|wss|edge|devtools):/i;

export function parseNavigateUrl(raw: string): NavigateTarget {
  const value = String(raw ?? '').trim();
  const lower = value.toLowerCase();
  if (lower === 'back' || lower === 'forward' || lower === 'reload') {
    return { kind: 'history', action: lower as 'back' | 'forward' | 'reload' };
  }
  if (!value) throw new NavigationRefusedError('Navigation refused: the URL is empty.');
  const candidate = EXPLICIT_SCHEME.test(value) || OPAQUE_SCHEMES.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new NavigationRefusedError(`Navigation refused: ${JSON.stringify(truncate(value, 200))} is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NavigationRefusedError();
  }
  return { kind: 'url', url: url.toString() };
}

export function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) || host === pattern.slice(2);
  }
  return host === pattern;
}

/** Returns a refusal reason, or null when the URL may be visited under the configured policy. */
export function checkUrlPolicy(
  rawUrl: string,
  policy: { allowedHosts: string[]; blockPrivateNetworks: boolean },
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (policy.blockPrivateNetworks && PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    return `Navigation refused: ${host} is a private or loopback address.`;
  }
  if (policy.allowedHosts.length && !policy.allowedHosts.some((pattern) => hostMatches(host, pattern))) {
    return `Navigation refused: ${host} is not in the allowed host list.`;
  }
  return null;
}
