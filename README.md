# One Chrome

One signed-in Chrome for every model you have open.

Cursor, Claude, and OpenCode can drive the same browser at the same time. Each client gets its own tabs and its own tab group. Clicks, typing, and navigation take a lease on the tab, so two models never type into the same field at once. Reads overlap. Tabs stay in the background, so one model does not steal the window from another.

The host speaks two tool dialects:

- **`chrome_*`**, a full browser toolset: snapshots with stable refs, trusted mouse and keyboard input, console, network, dialogs, emulation, and Core Web Vitals.
- **Claude's browser toolset**, all 31 members of [`browser_toolset_20260801`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool), with the same names, `ref_N` targets, error texts, and tab context. A Messages API executor turns a turn of `tool_use` blocks into `tool_result` blocks.

```text
 Cursor / Claude / OpenCode              your own Messages API app
        │  stdio (starts the host)                │  POST /claude/execute
        ▼                                         ▼
 ┌────────────────────────── One Chrome host ───────────────────────────────┐
 │  /mcp   chrome_* tools     /mcp/claude   Claude members    /mcp/all both │
 │  sessions · tab leases · per-tab queues · popup and download tracking    │
 └───────────────────────────────────┬──────────────────────────────────────┘
                                     │  ws://127.0.0.1:12307/bridge
                                     ▼
                    Chrome extension, running in your profile
             debugger · scripting · tab groups · downloads
```

## Install

Requires Node 20+ and Chrome (or Chromium) 120+.

```bash
git clone https://github.com/AbinMadathil07/one-chrome.git
cd one-chrome
npm install
npm run build
```

Load the extension:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the **`extension`** folder inside the clone. The repo root has no manifest, and Chrome will say the manifest is missing if you select it.
3. Open the extension popup and click **Connect**. It reconnects on its own after Chrome restarts.

## Add it to an MCP client

Give the client a command, not a URL. The first client starts the host. Every later client attaches to that same host, so they share one browser. You only need `npm start` when you want the host up before any client connects.

Replace `/path/to/one-chrome` with the clone path.

Cursor and Claude Code (`~/.cursor/mcp.json`, `~/.claude.json`):

```json
{
  "mcpServers": {
    "one-chrome": {
      "command": "node",
      "args": ["/path/to/one-chrome/dist/cli.js", "stdio"]
    },
    "one-chrome-claude": {
      "command": "node",
      "args": ["/path/to/one-chrome/dist/cli.js", "stdio", "--claude"]
    }
  }
}
```

OpenCode (`~/.config/opencode/opencode.jsonc`), version 1.x:

```jsonc
{
  "mcp": {
    "one-chrome": {
      "type": "local",
      "command": ["node", "/path/to/one-chrome/dist/cli.js", "stdio"],
      "enabled": true
    }
  }
}
```

| Command | Tools the model sees |
|---|---|
| `stdio` | `chrome_*`: sessions, snapshots, input, DevTools |
| `stdio --claude` | Claude's 31 browser members |
| `stdio --all` | Both |

Host logs are written to `~/.chrome-mcp/host-12306.log`. Check that the extension is connected with `node dist/cli.js status`, then try: *"Open example.com and tell me the heading."*

## How sharing works

| | One shared tab | One Chrome |
|---|---|---|
| Two models click at once | They race | Each session owns its tabs. Mutations take an exclusive lease and queue per tab |
| Parallel reads | Blocked behind the same lock | Shared read leases overlap |
| Window focus | Every action activates the tab | Tabs open in the background. Focus emulation lets them behave as focused |
| Finding a model's tabs | Guesswork | One Chrome tab group per session, titled with the client name |
| A page opens a popup or a download | Easy to miss | The popup joins the opener's session. The download is reported back to it |
| The client disconnects | Locks stick around | Leases drop when the connection closes. Idle sessions are swept |

A session is created for each MCP connection, so `sessionId` is optional. Call `session_ensure` with a distinct `clientId` when one connection drives several agents. To share a tab on purpose, attach it with `session_attach_tab`: reads overlap, writes wait their turn.

## Claude browser toolset

`stdio --claude` exposes the members Claude's [browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool) defines.

| Group | Members |
|---|---|
| Navigation and capture | `navigate` (`back`, `forward`, `reload`, or a URL), `screenshot`, `zoom` |
| Pointer | `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click` (each takes `modifiers`), `hover`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `mouse_move`, `scroll`, `scroll_to` |
| Keyboard and timing | `type`, `key` (chords, sequences, `repeat`), `hold_key`, `wait` |
| Reading | `read_page` (visible, `interactive`, `all`, `depth`, `ref`), `find`, `get_page_text` |
| Forms and files | `form_input`, `file_upload` |
| Diagnostics | `read_console`, `read_network` (new entries since the last read, secrets redacted), `javascript_exec` |
| Tabs | `new_tab`, `list_tabs`, `switch_tab`, `close_tab` |

Targets are `{"type":"ref","ref":"ref_3"}` or `{"type":"coordinate","x":120,"y":340}`. Refs come from `read_page` and `find` and stay valid until the page navigates. A stale ref returns `Error: ref_3 is stale or not found on the current page. Re-read the page to get fresh references.` Screenshots are CSS pixels, so a coordinate read off the image is the coordinate to click. Viewports wider than 1568px are scaled down, and incoming coordinates are scaled back up. Results include the tab-context footer, opened tabs, and download lines in the form Claude's API renders.

If you call the Messages API yourself, post each turn's browser `tool_use` blocks to the host:

```bash
curl -s http://127.0.0.1:12306/claude/execute \
  -H 'content-type: application/json' \
  -d '{
    "session": "my-agent",
    "tool_uses": [
      { "id": "toolu_1", "name": "navigate", "input": { "url": "example.com" } },
      { "id": "toolu_2", "name": "read_page", "input": { "filter": "interactive" } }
    ]
  }'
```

The response is `{ "tool_results": [...] }`, one block per call, with `toolset_name: "browser"` and a `browser_state` block. Calls run in order. After a failure, the rest of the turn gets `Not executed: an earlier action in this turn failed.` `DELETE /claude/sessions/my-agent` closes that session and its tabs.

[`examples/claude-browser-agent.mjs`](examples/claude-browser-agent.mjs) is a full agent loop:

```bash
ANTHROPIC_API_KEY=sk-ant-... node examples/claude-browser-agent.mjs "Open example.com and summarize it"
```

## `chrome_*` toolset

| Area | Tools |
|---|---|
| Sessions | `session_ensure`, `session_list`, `session_close`, `session_open_tab`, `session_attach_tab`, `session_switch_tab`, `session_close_tab`, `browser_status`, `chrome_list_tabs`, `chrome_downloads` |
| Navigation | `chrome_navigate`, `chrome_reload`, `chrome_go_back`, `chrome_go_forward`, `chrome_activate_tab` |
| Reading | `chrome_snapshot` (refs like `e12`), `chrome_find`, `chrome_get_page`, `chrome_get_text`, `chrome_get_html`, `chrome_screenshot` (element, full page, background tabs) |
| Input | `chrome_click` (button, click count, modifiers, or x/y), `chrome_hover`, `chrome_fill`, `chrome_fill_form`, `chrome_type`, `chrome_press_key`, `chrome_select_option`, `chrome_scroll`, `chrome_drag`, `chrome_upload_file` |
| Scripting | `chrome_evaluate` (expression, function, or top-level await), `chrome_fetch` (uses the page's cookies), `chrome_wait_for` |
| DevTools | `chrome_console_messages`, `chrome_network_requests`, `chrome_get_network_request`, `chrome_handle_dialog`, `chrome_emulate` (viewport, color scheme, user agent, network, CPU, geolocation), `chrome_performance_metrics` |
| Batching | `chrome_batch`, up to 25 steps under one exclusive lease |

Pass `includeSnapshot: true` on a mutating tool to get the page's interactive elements back with the result. If an action opens a JavaScript dialog, the call returns `{ modal }` instead of hanging, and other commands wait until `chrome_handle_dialog`.

## Configuration

Every variable is optional. Defaults are safe for a machine you control.

| Variable | Default | Meaning |
|---|---|---|
| `CHROME_MCP_HOST` | `127.0.0.1` | Bind address |
| `CHROME_MCP_PORT` | `12306` | MCP and executor port |
| `CHROME_MCP_BRIDGE_PORT` | `12307` | Extension WebSocket port |
| `CHROME_MCP_TOKEN` | empty | Shared secret. Clients send `Authorization: Bearer …` |
| `CHROME_MCP_MAX_SESSIONS` | `16` | Concurrent sessions |
| `CHROME_MCP_MAX_TABS_PER_SESSION` | `8` | Tabs one session may own |
| `CHROME_MCP_LEASE_TTL_MS` | `120000` | Lease lifetime and wait budget |
| `CHROME_MCP_COMMAND_TIMEOUT_MS` | `60000` | Bridge command timeout |
| `CHROME_MCP_IDLE_SESSION_TTL_MS` | `1800000` | Idle session sweep |
| `CHROME_MCP_ALLOW_SHARED_TABS` | `true` | Allow overlapping read leases |
| `CHROME_MCP_UPLOAD_DIR` | empty | Uploads must resolve inside this directory. Required for Claude `document_ids` |
| `CHROME_MCP_ALLOWED_HOSTS` | empty | Hosts navigation may reach, for example `*.example.com,docs.test`. Checked again after redirects |
| `CHROME_MCP_BLOCK_PRIVATE_NETWORKS` | `false` | Refuse localhost, private, and link-local hosts |
| `CHROME_MCP_SCREENSHOT_MAX_EDGE` | `1568` | Longest side of a Claude toolset screenshot |
| `CHROME_MCP_DISABLED_TOOLS` | empty | Tools to hide, for example `javascript_exec,file_upload` |

See [`.env.example`](.env.example).

## Security

The browser is your real profile, with its cookies and accounts, and any page can contain text written to steer a model.

- Leave the host on `127.0.0.1`. Set `CHROME_MCP_TOKEN` if other local processes can reach the ports.
- For untrusted sites, use a separate Chrome profile with no accounts, set `CHROME_MCP_ALLOWED_HOSTS`, set `CHROME_MCP_BLOCK_PRIVATE_NETWORKS=true`, and point `CHROME_MCP_UPLOAD_DIR` at a folder that holds only files meant for upload.
- `javascript_exec`, `chrome_evaluate`, `chrome_fetch`, and uploads run with the page's privileges. Hide the ones you do not need with `CHROME_MCP_DISABLED_TOOLS`.
- Console and network output is redacted for tokens, keys, JWTs, and credential query parameters. Treat the rest as untrusted.
- Chrome shows a debugging banner while DevTools is attached. `chrome_devtools_detach` removes it for that tab.

## Development

```bash
npm run dev        # rebuild and serve on change
npm test           # leases, sessions, Claude formatting, uploads
npm run typecheck
npm run build
npm run smoke      # round trip against the running host and your Chrome
CHROME_BIN="/path/to/Google Chrome for Testing" npm run e2e
```

`npm run e2e` serves a fixture page, starts its own host on ports 22306 and 22307, and launches Chrome for Testing with a copy of the extension. It does not touch a host or browser you already have open. It drives two concurrent sessions through the `chrome_*` tools and the full Claude toolset, both over MCP and through `/claude/execute`. Branded Chrome ignores `--load-extension`, so use [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) or Chromium. `HEADLESS=0` shows the window.

```text
src/
  cli.ts            serve, stdio, status
  config.ts         environment variables, defaults, validation
  concurrency/      sessions, tab leases, per-tab queues
  bridge/           WebSocket protocol
  browser/          runtime, uploads, downloads, snapshot search
  claude/           Claude toolset executor
  mcp/              HTTP server, both toolsets, stdio launcher
extension/          MV3 extension. Load this folder.
examples/           Messages API agent loop
scripts/            smoke and end-to-end tests
test/               unit tests and the browser fixture
```

## Credits

The idea of driving a real Chrome profile from MCP comes from [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) (MIT). One Chrome is an independent rewrite built around sharing that browser across models.

## License

[MIT](LICENSE)
