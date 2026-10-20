#!/usr/bin/env node
// End-to-end check: connects as an MCP client, lists tools, and (if the extension is connected)
// opens a tab, snapshots it, finds an element, and closes the session.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.CHROME_MCP_URL || `http://127.0.0.1:${process.env.CHROME_MCP_PORT || 12306}/mcp`;
const token = process.env.CHROME_MCP_TOKEN;
const testUrl = process.argv[2] || 'https://example.com';

function textOf(result) {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${textOf(result)}`);
  }
  return result;
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'chrome-mcp-smoke', version: '1.0.0' });
  await client.connect(transport);
  console.log(`✔ Connected to ${url}`);

  const { tools } = await client.listTools();
  console.log(`✔ ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

  const status = JSON.parse(textOf(await call(client, 'browser_status', {})));
  if (!status.bridgeConnected) {
    console.log('✖ Chrome extension is not connected. Load ./extension in Chrome and click Connect, then rerun.');
    await client.close();
    process.exit(2);
  }
  console.log('✔ Chrome extension connected');

  const { session } = JSON.parse(textOf(await call(client, 'session_ensure', { clientId: 'smoke-test', label: 'Smoke test' })));
  const sessionId = session.sessionId;
  try {
    const opened = JSON.parse(textOf(await call(client, 'session_open_tab', { sessionId, url: testUrl })));
    console.log(`✔ Opened tab ${opened.tab.tabId} (${opened.tab.url}) devtools=${opened.tab.devtoolsAttached}`);

    const snapshot = textOf(await call(client, 'chrome_snapshot', { sessionId, filter: 'interactive' }));
    console.log(`✔ Snapshot:\n${snapshot.split('\n').slice(0, 8).join('\n')}`);

    const found = JSON.parse(textOf(await call(client, 'chrome_find', { sessionId, query: 'link' })));
    console.log(`✔ chrome_find matched ${found.total} line(s)`);

    const evaluated = JSON.parse(textOf(await call(client, 'chrome_evaluate', { sessionId, script: 'document.title' })));
    console.log(`✔ chrome_evaluate -> ${JSON.stringify(evaluated.result)}`);

    if (opened.tab.devtoolsAttached) {
      const network = JSON.parse(textOf(await call(client, 'chrome_network_requests', { sessionId })));
      console.log(`✔ chrome_network_requests -> ${network.total} request(s)`);
    }

    const shot = await call(client, 'chrome_screenshot', { sessionId, format: 'jpeg', quality: 60 });
    const image = shot.content.find((c) => c.type === 'image');
    console.log(`✔ chrome_screenshot -> ${image ? `${Math.round((image.data.length * 3) / 4 / 1024)} KB ${image.mimeType}` : 'no image'}`);
  } finally {
    await call(client, 'session_close', { sessionId, closeTabs: true });
    console.log('✔ Session closed');
    await client.close();
  }
}

main().catch((error) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
