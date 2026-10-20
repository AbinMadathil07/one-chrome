#!/usr/bin/env node
// Minimal agent loop: Claude's browser_toolset_20260801 on the Messages API, executed by this host.
//
// Usage:
//   ANTHROPIC_API_KEY=... node examples/claude-browser-agent.mjs "Open example.com and summarize it"
//
// Optional env: CHROME_MCP_URL (default http://127.0.0.1:12306), CHROME_MCP_TOKEN,
// CLAUDE_MODEL (default claude-opus-5-5), AGENT_SESSION (executor session key, default "agent").

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('logName=requiredEnvVarMissing, envVar=ANTHROPIC_API_KEY');
  process.exit(1);
}

const hostUrl = process.env.CHROME_MCP_URL || 'http://127.0.0.1:12306';
const hostToken = process.env.CHROME_MCP_TOKEN || '';
const model = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const session = process.env.AGENT_SESSION || 'agent';
const maxTurns = Number(process.env.AGENT_MAX_TURNS) || 25;
const task = process.argv.slice(2).join(' ').trim();

if (!task) {
  console.error('Pass the task as an argument, e.g. node examples/claude-browser-agent.mjs "Find the pricing page on example.com"');
  process.exit(1);
}

const tools = [
  {
    type: 'browser_toolset_20260801',
    // The host implements every member; opt in to the four that are off by default.
    configs: {
      read_console: { enabled: true },
      read_network: { enabled: true },
    },
  },
];

async function callClaude(messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 4096, tools, messages }),
  });
  if (!response.ok) {
    throw new Error(`Messages API returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function executeBrowserCalls(toolUses) {
  const response = await fetch(`${hostUrl}/claude/execute`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(hostToken ? { authorization: `Bearer ${hostToken}` } : {}),
    },
    body: JSON.stringify({ session, tool_uses: toolUses }),
  });
  if (!response.ok) {
    throw new Error(`chrome-mcp executor returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).tool_results;
}

async function main() {
  const messages = [{ role: 'user', content: task }];
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const reply = await callClaude(messages);
    messages.push({ role: 'assistant', content: reply.content });

    for (const block of reply.content) {
      if (block.type === 'text') console.log(block.text);
    }
    const browserCalls = reply.content.filter((b) => b.type === 'tool_use' && b.toolset_name === 'browser');
    if (reply.stop_reason !== 'tool_use' || browserCalls.length === 0) return;

    for (const call of browserCalls) console.error(`→ ${call.name} ${JSON.stringify(call.input)}`);
    messages.push({ role: 'user', content: await executeBrowserCalls(browserCalls) });
  }
  console.error(`Stopped after ${maxTurns} turns`);
}

main().catch((error) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
