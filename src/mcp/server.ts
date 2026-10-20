import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { HostConfig } from '../config.js';
import type { BrowserRuntime } from '../browser/browser-runtime.js';
import { ClaudeBrowserExecutor } from '../claude/executor.js';
import { toApiToolResult, type ApiToolResult } from '../claude/render.js';
import { buildClaudeTools } from './claude-tools.js';
import { buildToolHandlers, type ToolContext, type ToolDefinition } from './tools.js';

export const HOST_VERSION = '2.2.0';
const MAX_BODY_BYTES = 10 * 1024 * 1024;

type Toolset = 'chrome' | 'claude';

const MCP_ROUTES: Record<string, Toolset[]> = {
  '/mcp': ['chrome'],
  '/mcp/claude': ['claude'],
  '/mcp/all': ['chrome', 'claude'],
};

type ActiveTransport = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  closeSession: () => void;
};

const executeRequestSchema = z.object({
  session: z
    .string()
    .regex(/^[\w.-]{1,64}$/, 'session must be 1-64 characters of letters, digits, ".", "_" or "-"')
    .default('default'),
  tool_uses: z
    .array(
      z.object({
        type: z.literal('tool_use').optional(),
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(100),
        toolset_name: z.string().optional(),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(50),
});

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function authorize(req: IncomingMessage, config: HostConfig): boolean {
  if (!config.authToken) {
    return true;
  }
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && header.slice(7) === config.authToken) {
    return true;
  }
  const url = new URL(req.url ?? '/', `http://${config.host}`);
  return url.searchParams.get('token') === config.authToken;
}

export class ChromeMcpHost {
  private httpServer: HttpServer | null = null;
  private readonly transports = new Map<string, ActiveTransport>();
  private readonly executor: ClaudeBrowserExecutor;
  /** Sessions for the HTTP executor endpoint, keyed by the caller-chosen `session` string. */
  private readonly executorSessions = new Map<string, string>();

  constructor(
    private readonly config: HostConfig,
    private readonly runtime: BrowserRuntime,
  ) {
    this.executor = new ClaudeBrowserExecutor(runtime, config);
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    this.httpServer = createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.config.mcpPort, this.config.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const active of this.transports.values()) {
      await active.transport.close().catch(() => undefined);
      await active.server.close().catch(() => undefined);
    }
    this.transports.clear();

    await new Promise<void>((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    this.httpServer = null;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${this.config.host}`);

      if (url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'chrome-mcp',
          version: HOST_VERSION,
          ...this.runtime.status(),
        });
        return;
      }

      if (!authorize(req, this.config)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const toolsets = MCP_ROUTES[url.pathname];
      if (toolsets) {
        await this.handleMcp(req, res, toolsets);
        return;
      }

      if (url.pathname === '/status') {
        sendJson(res, 200, this.runtime.status());
        return;
      }

      if (url.pathname === '/claude/members' && req.method === 'GET') {
        sendJson(res, 200, { toolset: 'browser_toolset_20260801', enabled: this.executor.enabledMembers() });
        return;
      }

      if (url.pathname === '/claude/execute' && req.method === 'POST') {
        await this.handleExecute(req, res);
        return;
      }

      const sessionRoute = url.pathname.match(/^\/claude\/sessions\/([\w.-]{1,64})$/);
      if (sessionRoute && req.method === 'DELETE') {
        const sessionId = this.executorSessions.get(sessionRoute[1]!);
        this.executorSessions.delete(sessionRoute[1]!);
        const closed = sessionId ? await this.runtime.closeSession(sessionId, true) : null;
        sendJson(res, 200, { closed: Boolean(closed) });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`logName=httpRequestFailed, path=${req.url?.split('?')[0]}, error=${message}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      }
    }
  }

  private executorSession(key: string): string {
    const existing = this.executorSessions.get(key);
    if (existing && this.runtime.listSessions().some((s) => s.sessionId === existing)) {
      return existing;
    }
    const session = this.runtime.createSession(`claude-api:${key}`, `Claude ${key}`.slice(0, 40));
    this.executorSessions.set(key, session.sessionId);
    return session.sessionId;
  }

  /**
   * Runs one assistant turn's browser member calls in order and returns their `tool_result`
   * blocks; after the first failure, later calls get the halt text, as the toolset requires.
   */
  private async handleExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = executeRequestSchema.safeParse(await readBody(req));
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid request', issues: parsed.error.issues });
      return;
    }
    const sessionId = this.executorSession(parsed.data.session);
    const results: ApiToolResult[] = [];
    let halted = false;
    for (const call of parsed.data.tool_uses) {
      const result = halted ? this.executor.haltResult() : await this.executor.execute(sessionId, call.name, call.input);
      if (result.isError) halted = true;
      results.push(toApiToolResult(call.id, result));
    }
    console.error(`logName=claudeExecuteTurn, calls=${results.length}, halted=${halted}`);
    sendJson(res, 200, { tool_results: results });
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse, toolsets: Toolset[]): Promise<void> {
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId || !this.transports.has(sessionId)) {
        sendJson(res, 400, { error: 'Invalid or missing MCP session' });
        return;
      }
      const active = this.transports.get(sessionId)!;
      await active.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await readBody(req);

    if (sessionId && this.transports.has(sessionId)) {
      const active = this.transports.get(sessionId)!;
      await active.transport.handleRequest(req, res, body);
      return;
    }

    const { server, closeSession } = this.createMcpServer(toolsets);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.transports.set(id, { transport, server, closeSession });
      },
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        this.transports.delete(id);
      }
      closeSession();
      void server.close();
    };
  }

  private createMcpServer(toolsets: Toolset[]): { server: McpServer; closeSession: () => void } {
    const server = new McpServer({
      name: 'chrome-mcp',
      version: HOST_VERSION,
    });

    let defaultSession: string | null = null;
    const ctx: ToolContext = {
      runtime: this.runtime,
      config: this.config,
      defaultSessionId: () => {
        if (defaultSession && this.runtime.listSessions().some((s) => s.sessionId === defaultSession)) {
          return defaultSession;
        }
        const client = server.server.getClientVersion()?.name || 'mcp-client';
        defaultSession = this.runtime.createSession(client, client.slice(0, 40)).sessionId;
        return defaultSession;
      },
    };

    const tools: Record<string, ToolDefinition> = {
      ...(toolsets.includes('chrome') ? buildToolHandlers(ctx) : {}),
      ...(toolsets.includes('claude') ? buildClaudeTools(ctx, this.executor) : {}),
    };
    for (const [name, tool] of Object.entries(tools)) {
      if (this.config.disabledTools.has(name)) continue;
      server.registerTool(
        name,
        {
          description: tool.description,
          inputSchema: tool.schema,
          annotations: { readOnlyHint: tool.readOnly },
        },
        async (args: Record<string, unknown>) => tool.handler(args),
      );
    }

    // Keep the connection's tabs for the user to inspect; only its leases and session state go.
    const closeSession = () => {
      if (defaultSession) void this.runtime.closeSession(defaultSession, false);
    };
    return { server, closeSession };
  }
}
