import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export type HostConfig = {
  host: string;
  mcpPort: number;
  bridgePort: number;
  authToken: string | null;
  maxSessions: number;
  maxTabsPerSession: number;
  leaseTtlMs: number;
  commandTimeoutMs: number;
  idleSessionTtlMs: number;
  allowSharedTabs: boolean;
  /** When set, uploads (and Claude `document_ids`) may only come from inside this directory. */
  uploadDir: string | null;
  /** Hostnames (or `*.suffix` patterns) navigation may reach; empty means any host. */
  allowedHosts: string[];
  blockPrivateNetworks: boolean;
  screenshotMaxEdge: number;
  disabledTools: Set<string>;
};

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}=${raw}; expected a positive number`);
  }
  return Math.floor(value);
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === '1' || raw.toLowerCase() === 'true') {
    return true;
  }
  if (raw === '0' || raw.toLowerCase() === 'false') {
    return false;
  }
  throw new Error(`Invalid ${name}=${raw}; expected true/false`);
}

function readList(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readDir(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const expanded = raw.startsWith('~/') ? `${homedir()}${raw.slice(1)}` : raw;
  if (!isAbsolute(expanded)) {
    throw new Error(`Invalid ${name}=${raw}; expected an absolute path`);
  }
  return resolve(expanded);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  return {
    host: env.CHROME_MCP_HOST || '127.0.0.1',
    mcpPort: readPositiveInt(env, 'CHROME_MCP_PORT', 12306),
    bridgePort: readPositiveInt(env, 'CHROME_MCP_BRIDGE_PORT', 12307),
    authToken: env.CHROME_MCP_TOKEN?.trim() || null,
    maxSessions: readPositiveInt(env, 'CHROME_MCP_MAX_SESSIONS', 16),
    maxTabsPerSession: readPositiveInt(env, 'CHROME_MCP_MAX_TABS_PER_SESSION', 8),
    leaseTtlMs: readPositiveInt(env, 'CHROME_MCP_LEASE_TTL_MS', 120_000),
    commandTimeoutMs: readPositiveInt(env, 'CHROME_MCP_COMMAND_TIMEOUT_MS', 60_000),
    idleSessionTtlMs: readPositiveInt(env, 'CHROME_MCP_IDLE_SESSION_TTL_MS', 1_800_000),
    allowSharedTabs: readBool(env, 'CHROME_MCP_ALLOW_SHARED_TABS', true),
    uploadDir: readDir(env, 'CHROME_MCP_UPLOAD_DIR'),
    allowedHosts: readList(env, 'CHROME_MCP_ALLOWED_HOSTS').map((h) => h.toLowerCase()),
    blockPrivateNetworks: readBool(env, 'CHROME_MCP_BLOCK_PRIVATE_NETWORKS', false),
    screenshotMaxEdge: readPositiveInt(env, 'CHROME_MCP_SCREENSHOT_MAX_EDGE', 1568),
    disabledTools: new Set(readList(env, 'CHROME_MCP_DISABLED_TOOLS')),
  };
}
