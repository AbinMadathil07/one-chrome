#!/usr/bin/env node
import { loadConfig } from './config.js';
import { ExtensionBridge } from './bridge/extension-bridge.js';
import { BrowserRuntime } from './browser/browser-runtime.js';
import { ChromeMcpHost } from './mcp/server.js';
import { clearHostPid, runStdioProxy, writeHostPid } from './mcp/stdio-proxy.js';

function printHelp(): void {
  console.log(`chrome-mcp — scalable Chrome MCP host

Usage:
  chrome-mcp serve            Start MCP HTTP + extension WebSocket bridge
  chrome-mcp stdio            Speak MCP on stdin and start the host if it is not running
  chrome-mcp stdio --claude   Same, for the Claude browser toolset
  chrome-mcp status           Print local health endpoints
  chrome-mcp help             Show this help

Environment:
  CHROME_MCP_HOST                 bind address (default 127.0.0.1)
  CHROME_MCP_PORT                 MCP HTTP port (default 12306)
  CHROME_MCP_BRIDGE_PORT          extension bridge port (default 12307)
  CHROME_MCP_TOKEN                optional shared secret
  CHROME_MCP_MAX_SESSIONS         concurrent MCP browser sessions (default 16)
  CHROME_MCP_MAX_TABS_PER_SESSION tabs owned per session (default 8)
  CHROME_MCP_LEASE_TTL_MS         tab lease TTL (default 120000)
  CHROME_MCP_COMMAND_TIMEOUT_MS   bridge command timeout (default 60000)
  CHROME_MCP_IDLE_SESSION_TTL_MS  idle session cleanup (default 1800000)
  CHROME_MCP_ALLOW_SHARED_TABS    allow shared read leases (default true)
  CHROME_MCP_UPLOAD_DIR           only allow uploads from this directory (default: any absolute path)
  CHROME_MCP_ALLOWED_HOSTS        comma list of hosts navigation may reach, e.g. "*.example.com"
  CHROME_MCP_BLOCK_PRIVATE_NETWORKS  refuse loopback/private hosts (default false)
  CHROME_MCP_SCREENSHOT_MAX_EDGE  longest side of Claude toolset screenshots (default 1568)
  CHROME_MCP_DISABLED_TOOLS       comma list of tool names to hide, e.g. "javascript_exec,file_upload"

Endpoints:
  /mcp          chrome_* toolset (sessions, leases, DevTools)
  /mcp/claude   Claude browser_toolset_20260801 members (navigate, left_click, read_page, …)
  /mcp/all      both toolsets
  POST /claude/execute  run Messages API browser tool_use blocks, get tool_result blocks back
`);
}

async function serve(): Promise<void> {
  const config = loadConfig();
  const bridge = new ExtensionBridge(config);
  const runtime = new BrowserRuntime(config, bridge);
  const host = new ChromeMcpHost(config, runtime);

  const shutdown = async (signal: string) => {
    console.error(`logName=shutdown, signal=${signal}`);
    clearHostPid(config.mcpPort);
    await host.stop();
    await bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await bridge.start();
  await host.start();
  writeHostPid(config.mcpPort);

  console.error(
    `logName=chromeMcpStarted, mcp=http://${config.host}:${config.mcpPort}/mcp, claudeMcp=http://${config.host}:${config.mcpPort}/mcp/claude, bridge=ws://${config.host}:${config.bridgePort}/bridge, maxSessions=${config.maxSessions}`,
  );
  console.error(
    'logName=waitingForExtension, hint=Load ./extension in Chrome and click Connect',
  );
}

async function status(): Promise<void> {
  const config = loadConfig();
  const mcp = await fetch(`http://${config.host}:${config.mcpPort}/health`).then((r) => r.json()).catch((error) => ({
    error: String(error),
  }));
  const bridge = await fetch(`http://${config.host}:${config.bridgePort}/health`).then((r) => r.json()).catch((error) => ({
    error: String(error),
  }));
  console.log(JSON.stringify({ mcp, bridge }, null, 2));
}

function stdioEndpoint(args: string[]): string {
  if (args.includes('--all')) return '/mcp/all';
  if (args.includes('--claude')) return '/mcp/claude';
  return '/mcp';
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  switch (command) {
    case 'serve':
      await serve();
      break;
    case 'stdio':
      await runStdioProxy(loadConfig(), stdioEndpoint(process.argv.slice(3)));
      break;
    case 'status':
      await status();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`logName=fatal, error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
