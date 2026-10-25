#!/usr/bin/env node
// Full browser test: serves test/fixtures, launches Chromium with the unpacked extension,
// and drives two concurrent MCP sessions through the main tool surface.
//
// Usage: CHROME_BIN="/path/to/Chrome for Testing" node scripts/e2e.mjs
// (Branded Google Chrome ignores --load-extension; use Chrome for Testing or Chromium.)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const chromeBin = process.env.CHROME_BIN;
const headless = process.env.HEADLESS !== '0';
// By default the test runs its own host on spare ports with a patched extension copy, so it
// never competes with a real browser connected to the default bridge.
const isolated = process.env.E2E_USE_RUNNING_HOST !== '1';
const testMcpPort = Number(process.env.E2E_MCP_PORT || 22306);
const testBridgePort = Number(process.env.E2E_BRIDGE_PORT || 22307);
const mcpUrl = isolated
  ? `http://127.0.0.1:${testMcpPort}/mcp`
  : process.env.CHROME_MCP_URL || 'http://127.0.0.1:12306/mcp';

if (!chromeBin) {
  console.error('Set CHROME_BIN to a Chrome for Testing / Chromium binary.');
  process.exit(1);
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);

async function startFixtureServer() {
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/signup')) {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url.startsWith('/popup')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Pricing</title><h1>Pricing</h1>');
      return;
    }
    if (req.url.startsWith('/download.csv')) {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="prices.csv"' });
      res.end('plan,price\npro,10\n');
      return;
    }
    try {
      const body = await readFile(join(root, 'test/fixtures/playground.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function prepareExtension(workDir) {
  if (!isolated) return join(root, 'extension');
  const ext = join(workDir, 'extension');
  await cp(join(root, 'extension'), ext, { recursive: true });
  const background = join(ext, 'background.js');
  const source = await readFile(background, 'utf8');
  await writeFile(background, source.replace('ws://127.0.0.1:12307/bridge', `ws://127.0.0.1:${testBridgePort}/bridge`));
  return ext;
}

async function startHost() {
  if (!isolated) return null;
  const host = spawn(process.execPath, [join(root, 'dist/cli.js'), 'serve'], {
    env: { ...process.env, CHROME_MCP_PORT: String(testMcpPort), CHROME_MCP_BRIDGE_PORT: String(testBridgePort) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  host.stderr.on('data', (chunk) => {
    if (process.env.E2E_HOST_LOGS === '1') process.stderr.write(chunk);
  });
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${testMcpPort}/health`);
      if (response.ok) return host;
    } catch {
      // Host not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  host.kill();
  throw new Error('Test host did not start; run `npm run build` first');
}

async function launchChrome(profileDir, ext) {
  // Keep test downloads inside the throwaway profile instead of ~/Downloads.
  await mkdir(join(profileDir, 'Default'), { recursive: true });
  await writeFile(
    join(profileDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: join(profileDir, 'downloads'), prompt_for_download: false } }),
  );
  const args = [
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    '--silent-debugger-extension-api',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const child = spawn(chromeBin, args, { stdio: 'ignore' });
  return child;
}

async function waitForBridge(client, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = json(await client.callTool({ name: 'browser_status', arguments: {} }));
    if (status.bridgeConnected) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function connectClient(name, path = '') {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}${path}`)));
  return client;
}

async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${textOf(result)}`);
  return result;
}

const CLAUDE_MEMBERS = [
  'navigate', 'screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'hover', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'mouse_move', 'scroll', 'scroll_to', 'type',
  'key', 'hold_key', 'wait', 'read_page', 'find', 'get_page_text', 'form_input', 'file_upload', 'read_console',
  'read_network', 'javascript_exec', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab',
];

async function runClaudeToolset(fixture, profileDir) {
  console.log('Claude browser toolset over MCP (/mcp/claude)');
  const c = await connectClient('model-c', '/claude');
  const call = (name, args = {}) => c.callTool({ name, arguments: args });
  const ok = async (name, args) => {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name}: ${textOf(result)}`);
    return result;
  };
  const js = async (code) => textOf(await ok('javascript_exec', { text: code })).split('\n\nTab Context:')[0];
  const refFor = (tree, pattern) => tree.match(new RegExp(`${pattern}[^\\n]*?\\[(ref_\\d+)\\]`))?.[1];

  try {
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    check('all 31 Claude members are exposed', CLAUDE_MEMBERS.every((m) => names.includes(m)) && names.length === 31, names.join(','));

    check('list_tabs with no tabs', textOf(await ok('list_tabs')) === 'No tabs available');
    const refused = await call('navigate', { url: 'javascript:alert(1)' });
    check('navigate refuses non-http schemes', refused.isError && textOf(refused) === 'Error: Navigation refused. Only http and https URLs are allowed.', textOf(refused));

    const nav = textOf(await ok('navigate', { url: fixture.url }));
    check('navigate opens a tab and reports tab context', nav.startsWith(`Navigated to ${fixture.url}.`) && /Tab Context:\n- Executed on tab_id: tab-\d+/.test(nav), nav);
    const firstTab = nav.match(/Executed on tab_id: (tab-\d+)/)?.[1];

    const visible = textOf(await ok('read_page', { filter: 'interactive' }));
    const everything = textOf(await ok('read_page', { filter: 'all' }));
    check('read_page tags elements with ref_N', /textbox "Email" \[ref_\d+\]/.test(visible), visible.slice(0, 300));
    check('read_page viewport filter hides off-screen elements', !visible.includes('Far away button') && everything.includes('Far away button'));

    const found = textOf(await ok('find', { query: 'email field' }));
    check('find matches natural language', /^textbox "Email"/.test(found), found);
    const emailRef = refFor(visible, 'textbox "Email"');
    const countryRef = refFor(everything, 'combobox "Country');
    const termsRef = refFor(everything, 'checkbox "Accept terms"');

    await ok('left_click', { target: { type: 'ref', ref: emailRef } });
    await ok('type', { text: 'c@example.com' });
    await ok('form_input', { target: { type: 'ref', ref: countryRef }, value: 'United States' });
    await ok('form_input', { target: { type: 'ref', ref: termsRef }, value: true });
    await ok('left_click', { target: { type: 'ref', ref: emailRef } });
    await ok('key', { text: 'Enter' });
    await ok('wait', { duration: 0.5 });
    check('click + type + form_input + key submitted the form', (await js("document.getElementById('result').textContent")) === 'Created c@example.com (us) terms=true');

    const stale = await call('left_click', { target: { type: 'ref', ref: 'ref_999999' } });
    check('stale ref uses the documented error text', textOf(stale) === 'Error: ref_999999 is stale or not found on the current page. Re-read the page to get fresh references.', textOf(stale));

    const shot = await ok('screenshot');
    const zoom = await ok('zoom', { region: [0, 0, 200, 100] });
    check('screenshot returns image + size text', shot.content.some((b) => b.type === 'image') && /Screenshot captured \(\d+x\d+\)/.test(textOf(shot)));
    check('zoom returns an image without a tab footer', zoom.content.some((b) => b.type === 'image') && !textOf(zoom).includes('Tab Context'));

    await js("document.getElementById('pad').scrollIntoView({ block: 'center' }), 0");
    const pad = JSON.parse(await js("JSON.stringify((() => { const r = document.getElementById('pad').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })())"));
    const at = { type: 'coordinate', x: pad.x, y: pad.y };
    await ok('left_click', { target: at, modifiers: 'shift' });
    await ok('right_click', { target: at });
    await ok('middle_click', { target: at });
    await ok('triple_click', { target: at });
    await ok('double_click', { target: at });
    await ok('left_mouse_down', { target: at });
    await ok('mouse_move', { target: { type: 'coordinate', x: pad.x + 20, y: pad.y } });
    await ok('left_mouse_up', { target: { type: 'coordinate', x: pad.x + 20, y: pad.y } });
    await ok('left_click_drag', { from: at, target: { type: 'coordinate', x: pad.x + 30, y: pad.y + 10 } });
    const padLog = await js("document.getElementById('pad-log').textContent");
    check('coordinate clicks honour modifiers, buttons, and click counts',
      padLog.includes('down:0:shift') && padLog.includes('context') && padLog.includes('aux:1') && padLog.includes('click:3') && padLog.includes('click:2'),
      padLog);
    check('low-level mouse down/move/up and drag dispatched', (padLog.match(/down:0:/g) ?? []).length >= 8 && (padLog.match(/up:0/g) ?? []).length >= 8, padLog);

    const accountRef = refFor(everything, 'button "Account"');
    await ok('hover', { target: { type: 'ref', ref: accountRef } });
    check('hover by ref triggers :hover', (await js("getComputedStyle(document.getElementById('menu')).display")) === 'block');

    const notesRef = refFor(everything, 'textbox "Notes"');
    await ok('left_click', { target: { type: 'ref', ref: notesRef } });
    await ok('type', { text: 'abcd' });
    await ok('key', { text: 'Backspace Backspace' });
    await ok('key', { text: 'BackSpace', repeat: 1 });
    check('key sequences and repeat', (await js("document.getElementById('notes').value")) === 'a');
    await ok('hold_key', { text: 'shift', duration: 0.5 });
    const keyLog = await js("document.getElementById('key-log').textContent");
    const held = Number(keyLog.match(/Shift:(\d+)/)?.[1] ?? 0);
    check('hold_key holds for the duration', held >= 400, keyLog);

    await js('scrollTo(0, 0), 0');
    await ok('scroll', { target: { type: 'coordinate', x: 100, y: 100 }, scroll_direction: 'down', scroll_amount: 5 });
    check('scroll moves the page', Number(await js('scrollY')) > 0);
    const farRef = refFor(everything, 'button "Far away button"');
    await ok('scroll_to', { target: { type: 'ref', ref: farRef } });
    check('scroll_to brings the element into view', (await js("(() => { const r = document.getElementById('far-btn').getBoundingClientRect(); return String(r.top >= 0 && r.bottom <= innerHeight); })()")) === 'true');

    const pageText = textOf(await ok('get_page_text'));
    check('get_page_text prefers main content', pageText.includes('Getting started') && !pageText.includes('Create account'), pageText.slice(0, 200));

    const uploadFile = join(profileDir, 'upload-me.txt');
    await writeFile(uploadFile, 'hello');
    const fileRef = refFor(everything, 'textbox "Attachment"') ?? refFor(everything, 'Attachment');
    await ok('file_upload', { target: { type: 'ref', ref: fileRef }, paths: [uploadFile] });
    check('file_upload sets files', (await js("document.getElementById('file-result').textContent")) === 'upload-me.txt');

    const consoleFirst = textOf(await ok('read_console'));
    const consoleSecond = textOf(await ok('read_console'));
    check('read_console returns entries', consoleFirst.includes('[log] submitting c@example.com'), consoleFirst);
    check('read_console only returns new entries', consoleSecond.startsWith('No new console messages'), consoleSecond);
    const netFirst = textOf(await ok('read_network'));
    const netSecond = textOf(await ok('read_network'));
    check('read_network lists requests with status', /GET 201 http:\/\/127\.0\.0\.1:\d+\/api\/signup\?email=/.test(netFirst), netFirst);
    check('read_network only returns new requests', !netSecond.includes('/api/signup'), netSecond);
    check('javascript_exec returns the last expression', (await js('40 + 2')) === '42' && (await js('document.title')) === 'MCP Playground');

    await js('scrollTo(0, 0), 0');
    const reread = textOf(await ok('read_page', { filter: 'all' }));
    const popupClick = textOf(await ok('left_click', { target: { type: 'ref', ref: refFor(reread, 'link "Open pricing"') } }));
    check('page-opened tab is adopted and reported', (popupClick.match(/• tab_id tab-\d+/g) ?? []).length === 2 && popupClick.includes('"Pricing"'), popupClick);
    const downloadClick = textOf(await ok('left_click', { target: { type: 'ref', ref: refFor(reread, 'link "Download price list"') } }));
    const afterWait = textOf(await ok('wait', { duration: 1 }));
    const downloadText = `${downloadClick}\n${afterWait}`;
    check('downloads reported as state changes', /Download (started|completed) with download_id: dl-\d+, URL: "http:\/\/127\.0\.0\.1:\d+\/download\.csv"/.test(downloadText), downloadText);

    const created = textOf(await ok('new_tab'));
    const newTabId = created.match(/tab_id: (tab-\d+)/)?.[1];
    check('new_tab uses the documented text', /^Created new tab with tab_id: tab-\d+, URL: about:blank\. It is now the current tab\.$/.test(created), created);
    const listed = textOf(await ok('list_tabs'));
    check('list_tabs marks the current tab', listed.startsWith('Available tabs:') && listed.includes(`tab_id ${newTabId}: "about:blank" (about:blank) (current)`), listed);
    check('switch_tab text', textOf(await ok('switch_tab', { tab_id: firstTab })) === `Switched to tab ${firstTab}`);
    check('close_tab text', textOf(await ok('close_tab', { tab_id: newTabId })) === `Closed tab ${newTabId}`);
    const badTab = await call('switch_tab', { tab_id: 'tab-999999' });
    check('unknown tab_id is an error result', badTab.isError && /not an open tab/.test(textOf(badTab)), textOf(badTab));
  } finally {
    await c.close().catch(() => undefined);
  }

  console.log('Claude Messages API executor (POST /claude/execute)');
  const base = new URL(mcpUrl).origin;
  const execute = async (toolUses) => {
    const response = await fetch(`${base}/claude/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'e2e', tool_uses: toolUses }),
    });
    return response.json();
  };
  const turn = await execute([
    { id: 'toolu_1', name: 'navigate', input: { url: fixture.url } },
    { id: 'toolu_2', name: 'left_click', input: { target: { type: 'ref', ref: 'ref_999999' } } },
    { id: 'toolu_3', name: 'key', input: { text: 'Enter' } },
  ]);
  const [first, second, third] = turn.tool_results ?? [];
  const state = first?.content?.find?.((b) => b.type === 'browser_state');
  check('executor result carries toolset_name and browser_state with tab_opened',
    first?.toolset_name === 'browser' && state?.tabs?.[0]?.active === true && state?.state_changes?.[0]?.type === 'tab_opened',
    JSON.stringify(first).slice(0, 400));
  check('executor reports errors as is_error text', second?.is_error === true && /stale or not found/.test(second.content), JSON.stringify(second));
  check('executor halts the rest of the batch', third?.is_error === true && third.content === 'Not executed: an earlier action in this turn failed.', JSON.stringify(third));
  const listing = await execute([{ id: 'toolu_4', name: 'list_tabs', input: {} }]);
  const listContent = listing.tool_results?.[0]?.content;
  check('tab-management results are exactly one browser_state block', Array.isArray(listContent) && listContent.length === 1 && listContent[0].type === 'browser_state', JSON.stringify(listContent));
  const unknown = await execute([{ id: 'toolu_5', name: 'teleport', input: {} }]);
  check('unknown members are error results', unknown.tool_results?.[0]?.is_error === true, JSON.stringify(unknown));
  await fetch(`${base}/claude/sessions/e2e`, { method: 'DELETE' });
}

async function run() {
  const fixture = await startFixtureServer();
  const profileDir = await mkdtemp(join(tmpdir(), 'chrome-mcp-e2e-'));
  const host = await startHost();
  const chrome = await launchChrome(profileDir, await prepareExtension(profileDir));
  const a = await connectClient('model-a');
  const b = await connectClient('model-b');

  try {
    console.log('Bridge');
    check('extension connected to host', await waitForBridge(a));

    console.log('Sessions');
    const sa = json(await tool(a, 'session_ensure', { clientId: 'model-a', label: 'Model A' })).session.sessionId;
    const sb = json(await tool(b, 'session_ensure', { clientId: 'model-b', label: 'Model B' })).session.sessionId;
    const [ta, tb] = await Promise.all([
      tool(a, 'session_open_tab', { sessionId: sa, url: fixture.url }).then(json),
      tool(b, 'session_open_tab', { sessionId: sb, url: fixture.url }).then(json),
    ]);
    check('two sessions opened separate tabs', ta.tab.tabId !== tb.tab.tabId);
    check('devtools attached on open', ta.tab.devtoolsAttached === true, JSON.stringify(ta.tab));
    check('tabs placed in different tab groups', ta.tab.groupId != null && ta.tab.groupId !== tb.tab.groupId, `${ta.tab.groupId} vs ${tb.tab.groupId}`);

    console.log('Snapshot + find');
    const snap = textOf(await tool(a, 'chrome_snapshot', { sessionId: sa }));
    check('snapshot has heading with level', /heading "MCP Playground" \[level=1\]/.test(snap), snap.slice(0, 300));
    check('snapshot labels inputs', /textbox "Email" \[ref=e\d+\]/.test(snap));
    const found = json(await tool(a, 'chrome_find', { sessionId: sa, query: 'create account' }));
    const submitRef = found.matches[0]?.ref;
    check('chrome_find returns a ref', /^e\d+$/.test(submitRef ?? ''), JSON.stringify(found));
    const emailRef = snap.match(/textbox "Email" \[ref=(e\d+)\]/)?.[1];
    const countryRef = snap.match(/combobox "Country.*?\[ref=(e\d+)\]/)?.[1];
    const termsRef = snap.match(/checkbox "Accept terms" \[ref=(e\d+)\]/)?.[1];

    console.log('Concurrent form fills (two models in parallel)');
    await Promise.all([
      tool(a, 'chrome_fill_form', {
        sessionId: sa,
        fields: [
          { target: emailRef, value: 'a@example.com' },
          { target: '#password', value: 'secret' },
          { target: countryRef, value: 'in' },
          { target: termsRef, value: true },
        ],
      }),
      tool(b, 'chrome_type', { sessionId: sb, target: '#email', text: 'b@example.com' }),
    ]);
    await tool(a, 'chrome_click', { sessionId: sa, target: submitRef });
    await tool(a, 'chrome_wait_for', { sessionId: sa, text: 'Created a@example.com' });
    const resultA = json(await tool(a, 'chrome_get_text', { sessionId: sa, target: '#result' }));
    check('model A form submitted with trusted click', resultA.text === 'Created a@example.com (in) terms=true', resultA.text);
    await tool(b, 'chrome_press_key', { sessionId: sb, target: '#email', key: 'Enter' });
    await tool(b, 'chrome_wait_for', { sessionId: sb, text: 'Created b@example.com' });
    const resultB = json(await tool(b, 'chrome_get_text', { sessionId: sb, target: '#result' }));
    check('model B submitted via Enter key, isolated from A', resultB.text.startsWith('Created b@example.com'), resultB.text);

    console.log('Console + network');
    const consoleA = json(await tool(a, 'chrome_console_messages', { sessionId: sa }));
    check('console captured log + warn', consoleA.items.some((m) => m.text.includes('submitting a@example.com')) && consoleA.items.some((m) => m.type === 'warning' || m.type === 'warn'), JSON.stringify(consoleA.items));
    const boom = consoleA.items.find((m) => m.type === 'error' && m.text.includes('playground boom'));
    check('console errors include a message id', Boolean(boom?.msgid), JSON.stringify(boom));
    if (boom) {
      const detail = json(await tool(a, 'chrome_get_console_message', { sessionId: sa, msgid: boom.msgid }));
      check('console message detail keeps the error text', detail.text.includes('playground boom'), detail.text);
    }
    const net = json(await tool(a, 'chrome_network_requests', { sessionId: sa, urlContains: '/api/signup' }));
    check('network captured API call with 201', net.items[0]?.status === 201, JSON.stringify(net.items));
    check('network request includes timing or duration', net.items[0]?.durationMs != null || net.items[0]?.ttfbMs != null, JSON.stringify(net.items[0]));
    if (net.items[0]) {
      const detail = json(await tool(a, 'chrome_get_network_request', { sessionId: sa, reqid: net.items[0].reqid }));
      check('response body available', detail.responseBody === '{"ok":true}', detail.responseBody);
    }

    console.log('Dialogs');
    const clickResult = json(await tool(a, 'chrome_click', { sessionId: sa, target: '#alert-btn' }));
    check('click returned modal state instead of hanging', clickResult.modal?.type === 'confirm', JSON.stringify(clickResult));
    const blocked = await a.callTool({ name: 'chrome_get_text', arguments: { sessionId: sa } });
    check('other actions blocked while dialog open', blocked.isError && /dialog/.test(textOf(blocked)), textOf(blocked));
    await tool(a, 'chrome_handle_dialog', { sessionId: sa, accept: true });
    const dialogText = json(await tool(a, 'chrome_get_text', { sessionId: sa, target: '#dialog-result' }));
    check('dialog accepted', dialogText.text === 'confirmed', dialogText.text);

    console.log('Hover, wait, batch, evaluate');
    await tool(a, 'chrome_hover', { sessionId: sa, target: '#hover-target' });
    const menuVisible = json(await tool(a, 'chrome_evaluate', { sessionId: sa, script: "getComputedStyle(document.getElementById('menu')).display" }));
    check('CSS :hover triggered by real mouse', menuVisible.result === 'block', JSON.stringify(menuVisible));
    await tool(a, 'chrome_wait_for', { sessionId: sa, target: '#late-btn', state: 'visible' });
    check('wait_for element visible', true);
    const batch = json(
      await tool(a, 'chrome_batch', {
        sessionId: sa,
        steps: [
          { action: 'fill', args: { target: '#email', value: 'batch@example.com' } },
          { action: 'select_option', args: { target: '#country', values: ['United States'] } },
          { action: 'evaluate', args: { script: "() => document.getElementById('country').value" } },
        ],
      }),
    );
    check('batch ran 3 steps in order', batch.completed === 3 && batch.results[2].result.result === 'us', JSON.stringify(batch));
    const asyncEval = json(await tool(a, 'chrome_evaluate', { sessionId: sa, script: 'await new Promise(r => setTimeout(() => r(41 + 1), 50))' }));
    check('evaluate supports top-level await', asyncEval.result === 42, JSON.stringify(asyncEval));

    console.log('Emulation, performance, screenshots');
    const probe = "({ w: screen.width, dark: matchMedia('(prefers-color-scheme: dark)').matches })";
    const before = json(await tool(a, 'chrome_evaluate', { sessionId: sa, script: probe })).result;
    const scheme = before.dark ? 'light' : 'dark';
    await tool(b, 'chrome_emulate', { sessionId: sb, viewport: { width: 390, height: 844, mobile: true }, colorScheme: scheme });
    const vb = json(await tool(b, 'chrome_evaluate', { sessionId: sb, script: probe })).result;
    const va = json(await tool(a, 'chrome_evaluate', { sessionId: sa, script: probe })).result;
    check(
      'emulation applies to model B tab only',
      vb.w === 390 && vb.dark === (scheme === 'dark') && va.w === before.w && va.dark === before.dark,
      JSON.stringify({ before, vb, va }),
    );
    const perf = json(await tool(a, 'chrome_performance_metrics', { sessionId: sa }));
    check('performance metrics returned', typeof perf.runtime?.nodes === 'number' && perf.vitals?.url?.startsWith(fixture.url), JSON.stringify(perf));
    const trace = json(await tool(a, 'chrome_performance_start_trace', { sessionId: sa, reload: true, autoStop: true, settleMs: 800 }));
    check(
      'performance trace reports load findings',
      trace.eventCount > 10 && typeof trace.report === 'string' && /LCP|FCP|Load/.test(trace.report),
      trace.report?.slice(0, 400) || JSON.stringify(trace).slice(0, 400),
    );
    const shot = await tool(b, 'chrome_screenshot', { sessionId: sb, fullPage: true, format: 'jpeg', quality: 50 });
    check('full-page screenshot of background tab', shot.content.some((c) => c.type === 'image' && c.data.length > 1000));
    const elementShot = await tool(a, 'chrome_screenshot', { sessionId: sa, target: 'h1' });
    check('element screenshot', elementShot.content.some((c) => c.type === 'image'));

    console.log('Isolation');
    const crossTab = await b.callTool({ name: 'chrome_get_text', arguments: { sessionId: sb, tabId: ta.tab.tabId } });
    check('model B cannot drive model A tab without attaching', crossTab.isError, textOf(crossTab));

    await tool(a, 'session_close', { sessionId: sa });
    await tool(b, 'session_close', { sessionId: sb });
    const tabsAfter = json(await tool(a, 'chrome_list_tabs', {}));
    check('session_close closed owned tabs', !tabsAfter.tabs.some((t) => t.tabId === ta.tab.tabId || t.tabId === tb.tab.tabId));

    await runClaudeToolset(fixture, profileDir);
  } finally {
    await a.close().catch(() => undefined);
    await b.close().catch(() => undefined);
    chrome.kill('SIGTERM');
    host?.kill('SIGTERM');
    fixture.server.close();
    await new Promise((r) => setTimeout(r, 500));
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(`✖ ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
