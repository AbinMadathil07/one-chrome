import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { HostConfig } from '../config.js';

const START_TIMEOUT_MS = 15_000;
const STALE_LOCK_MS = 30_000;

function runtimeDir(): string {
  return join(homedir(), '.chrome-mcp');
}

export function pidFilePath(port: number): string {
  return join(runtimeDir(), `host-${port}.pid`);
}

function logFilePath(port: number): string {
  return join(runtimeDir(), `host-${port}.log`);
}

async function isHealthy(config: HostConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.host}:${config.mcpPort}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Records the host pid so a later stdio launch can see a start already in progress. */
export function writeHostPid(port: number): void {
  mkdirSync(runtimeDir(), { recursive: true });
  writeFileSync(pidFilePath(port), `${process.pid}\n`);
}

export function clearHostPid(port: number): void {
  try {
    if (readFileSync(pidFilePath(port), 'utf8').trim() === String(process.pid)) {
      unlinkSync(pidFilePath(port));
    }
  } catch {
    // Another host owns the file, or it was already removed.
  }
}

/**
 * Starts the shared host in the background when nothing is listening yet.
 * Several MCP clients can call this at once; only one of them spawns the process.
 */
export async function ensureHost(config: HostConfig): Promise<void> {
  if (await isHealthy(config)) return;

  mkdirSync(runtimeDir(), { recursive: true });
  const lock = join(runtimeDir(), `start-${config.mcpPort}.lock`);
  let ownsLock = false;
  try {
    const fd = openSync(lock, 'wx');
    closeSync(fd);
    ownsLock = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age > STALE_LOCK_MS) {
      unlinkSync(lock);
      return ensureHost(config);
    }
  }

  if (ownsLock) {
    const logFd = openSync(logFilePath(config.mcpPort), 'a');
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'serve'], {
      cwd: dirname(dirname(cli)),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.unref();
    closeSync(logFd);
  }

  const started = Date.now();
  while (Date.now() - started < START_TIMEOUT_MS) {
    if (await isHealthy(config)) {
      if (ownsLock) unlinkSync(lock);
      return;
    }
    await sleep(200);
  }
  if (ownsLock) unlinkSync(lock);
  throw new Error(
    `chrome-mcp host did not start on port ${config.mcpPort}. See ${logFilePath(config.mcpPort)}`,
  );
}

function protocolVersionOf(message: JSONRPCMessage): string | undefined {
  if (!('result' in message) || !message.result || typeof message.result !== 'object') return undefined;
  const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
  return typeof version === 'string' ? version : undefined;
}

/** Speaks MCP on stdin/stdout and forwards it to the shared HTTP host, starting that host first. */
export async function runStdioProxy(config: HostConfig, endpointPath: string): Promise<void> {
  await ensureHost(config);
  const url = new URL(`http://${config.host}:${config.mcpPort}${endpointPath}`);
  const http = new StreamableHTTPClientTransport(url, {
    requestInit: config.authToken ? { headers: { authorization: `Bearer ${config.authToken}` } } : undefined,
  });
  const stdio = new StdioServerTransport();

  let closing = false;
  const closeBoth = () => {
    if (closing) return;
    closing = true;
    void http.terminateSession().catch(() => undefined).finally(() => {
      void http.close().catch(() => undefined);
      void stdio.close().catch(() => undefined);
    });
  };

  stdio.onmessage = (message) => {
    void http.send(message).catch((error: unknown) => {
      console.error(`logName=stdioProxySendFailed, error=${error instanceof Error ? error.message : String(error)}`);
      closeBoth();
    });
  };
  http.onmessage = (message) => {
    const version = protocolVersionOf(message);
    if (version) http.setProtocolVersion(version);
    void stdio.send(message).catch((error: unknown) => {
      console.error(`logName=stdioProxyReplyFailed, error=${error instanceof Error ? error.message : String(error)}`);
      closeBoth();
    });
  };
  stdio.onclose = closeBoth;
  http.onclose = closeBoth;
  http.onerror = (error) => console.error(`logName=stdioProxyHttpError, error=${error.message}`);
  stdio.onerror = (error) => console.error(`logName=stdioProxyStdioError, error=${error.message}`);

  await http.start();
  await stdio.start();
  console.error(`logName=stdioProxyReady, endpoint=${endpointPath}`);
}
