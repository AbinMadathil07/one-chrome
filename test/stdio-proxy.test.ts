import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const port = 22316;
const env = Object.fromEntries(
  Object.entries({
    ...process.env,
    CHROME_MCP_PORT: String(port),
    CHROME_MCP_BRIDGE_PORT: '22317',
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);

async function connect(args: string[] = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'dist/cli.js'), 'stdio', ...args],
    env,
    stderr: 'pipe',
    cwd: process.cwd(),
  });
  const client = new Client({ name: 'stdio-proxy-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function hostPid(): Promise<number> {
  const text = await readFile(join(homedir(), '.chrome-mcp', `host-${port}.pid`), 'utf8');
  return Number(text.trim());
}

describe('stdio proxy', () => {
  after(async () => {
    const pid = await hostPid().catch(() => 0);
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already exited.
      }
    }
  });

  it('starts the shared host on first use and reuses it', async () => {
    const first = await connect();
    const chrome = await first.listTools();
    assert.ok(chrome.tools.some((tool) => tool.name === 'chrome_snapshot'));
    assert.equal(chrome.tools.some((tool) => tool.name === 'left_click'), false);
    const pid = await hostPid();
    await first.close();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.ok, true);

    const second = await connect(['--claude']);
    const claude = await second.listTools();
    assert.ok(claude.tools.some((tool) => tool.name === 'navigate'));
    assert.equal(claude.tools.some((tool) => tool.name === 'chrome_snapshot'), false);
    assert.equal(await hostPid(), pid);
    await second.close();
  });
});
