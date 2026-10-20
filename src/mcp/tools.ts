import { z } from 'zod';
import type { BrowserRuntime } from '../browser/browser-runtime.js';
import { searchSnapshot } from '../browser/snapshot-search.js';
import { resolveUploadFiles } from '../browser/upload-policy.js';
import { checkUrlPolicy } from '../claude/format.js';
import type { HostConfig } from '../config.js';
import type { ToolContent, ToolResult } from '../types.js';
import { BATCHABLE_ACTIONS, TAB_ACTIONS, type TabActionName } from './tab-actions.js';

export type ToolDefinition = {
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  readOnly: boolean;
  // Arguments are validated by the MCP SDK against `schema` before the handler runs.
  handler: (args: any) => Promise<ToolResult>;
};

/** Per-MCP-connection context; `defaultSessionId` lazily creates this connection's own session. */
export type ToolContext = {
  runtime: BrowserRuntime;
  config: HostConfig;
  defaultSessionId: () => string;
};

type SnapshotResult = { url: string; title: string; refCount: number; truncated: boolean; snapshot: string };
type ScreenshotResult = { data?: string; mimeType?: string; note?: string };

const sessionId = z
  .string()
  .uuid()
  .optional()
  .describe('Session id from session_ensure; omit to use this MCP connection’s own session');
const tabId = z.number().int().positive().optional().describe('Owned tab id; defaults to the session active tab');
const includeSnapshot = z
  .boolean()
  .optional()
  .describe('Return an interactive snapshot of the page after the action');

function text(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    isError,
  };
}

function formatSnapshot(result: SnapshotResult): string {
  return [`Page: ${result.title}`, `URL: ${result.url}`, `Refs: ${result.refCount}`, '', result.snapshot].join('\n');
}

function formatScreenshot(result: ScreenshotResult): ToolResult {
  if (!result?.data) return text(result);
  const content: ToolContent[] = [{ type: 'image', data: result.data, mimeType: result.mimeType ?? 'image/png' }];
  if (result.note) content.unshift({ type: 'text', text: result.note });
  return { content };
}

function resolveSession(ctx: ToolContext, value: unknown): string {
  return typeof value === 'string' && value ? value : ctx.defaultSessionId();
}

function splitCommon(ctx: ToolContext, args: Record<string, unknown>) {
  const { sessionId: sid, tabId: tid, includeSnapshot: snap, ...rest } = args;
  return {
    sessionId: resolveSession(ctx, sid),
    tabId: tid as number | undefined,
    includeSnapshot: Boolean(snap),
    actionArgs: rest,
  };
}

function assertUrlAllowed(ctx: ToolContext, url: unknown): void {
  if (typeof url !== 'string') return;
  const refusal = checkUrlPolicy(url, ctx.config);
  if (refusal) throw new Error(refusal);
}

async function snapshotAfter(runtime: BrowserRuntime, sid: string, tid?: number): Promise<string> {
  try {
    const snap = await runtime.runOnTab<SnapshotResult>({
      sessionId: sid,
      tabId: tid,
      exclusive: false,
      command: 'snapshot',
      args: { filter: 'interactive' },
    });
    return formatSnapshot(snap);
  } catch (error) {
    return `Snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildActionTool(ctx: ToolContext, name: TabActionName): ToolDefinition {
  const spec = TAB_ACTIONS[name];
  const shape: z.ZodRawShape = spec.exclusive
    ? { sessionId, tabId, ...spec.args, includeSnapshot }
    : { sessionId, tabId, ...spec.args };

  return {
    description: spec.description,
    schema: z.object(shape),
    readOnly: !spec.exclusive,
    handler: async (args: Record<string, unknown>) => {
      const common = splitCommon(ctx, args);
      if (name === 'navigate') assertUrlAllowed(ctx, common.actionArgs.url);
      const result = await ctx.runtime.runOnTab<unknown>({
        sessionId: common.sessionId,
        tabId: common.tabId,
        exclusive: spec.exclusive,
        command: spec.command,
        args: common.actionArgs,
      });

      if (name === 'screenshot') return formatScreenshot(result as ScreenshotResult);
      if (name === 'snapshot') return text(formatSnapshot(result as SnapshotResult));

      if (!common.includeSnapshot) return text(result);
      const snap = await snapshotAfter(ctx.runtime, common.sessionId, common.tabId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, { type: 'text', text: snap }] };
    },
  };
}

function sessionTools(ctx: ToolContext): Record<string, ToolDefinition> {
  const { runtime } = ctx;
  return {
    session_ensure: {
      description:
        'Create (or reuse) an isolated browser session. Optional: every tool falls back to this connection’s own session. Use it when one connection drives several agents, giving each its own clientId so tabs, leases, and tab groups stay separate.',
      schema: z.object({
        clientId: z.string().min(1).max(64).describe('Stable id for the calling model/agent, e.g. "cursor-agent-a"'),
        label: z.string().max(40).optional().describe('Shown as the Chrome tab group title'),
        sessionId: z.string().uuid().optional().describe('Reuse this session if it still exists'),
      }),
      readOnly: false,
      handler: async (args: { clientId: string; label?: string; sessionId?: string }) => {
        if (args.sessionId) {
          try {
            const existing = runtime.getSession(args.sessionId);
            runtime.sessions.touch(existing.sessionId);
            return text({ reused: true, session: existing });
          } catch {
            // Expired or unknown session ids fall through to a fresh session.
          }
        }
        return text({ reused: false, session: runtime.createSession(args.clientId, args.label ?? args.clientId) });
      },
    },
    session_list: {
      description: 'List active browser sessions and the tabs each one owns.',
      schema: z.object({}),
      readOnly: true,
      handler: async () => text({ sessions: runtime.listSessions() }),
    },
    session_close: {
      description: 'Close a session, release its leases, and (by default) close its tabs.',
      schema: z.object({ sessionId, closeTabs: z.boolean().optional() }),
      readOnly: false,
      handler: async (args: { sessionId?: string; closeTabs?: boolean }) =>
        text({ closed: await runtime.closeSession(resolveSession(ctx, args.sessionId), args.closeTabs ?? true) }),
    },
    session_open_tab: {
      description:
        'Open a new tab owned by this session, placed in the session’s Chrome tab group. Opens in the background by default so parallel models do not steal focus.',
      schema: z.object({
        sessionId,
        url: z.string().url().optional(),
        active: z.boolean().optional().describe('Focus the tab (default false)'),
        devtools: z.boolean().optional().describe('Attach DevTools for console/network/trusted input (default true)'),
        group: z.boolean().optional().describe('Add to the session tab group (default true)'),
      }),
      readOnly: false,
      handler: async (args: { sessionId?: string; url?: string; active?: boolean; devtools?: boolean; group?: boolean }) => {
        assertUrlAllowed(ctx, args.url);
        const sid = resolveSession(ctx, args.sessionId);
        const tab = await runtime.openTab(sid, args);
        return text({ tab, session: runtime.getSession(sid) });
      },
    },
    session_attach_tab: {
      description:
        'Take an existing Chrome tab into this session (e.g. one the user opened). Shared reads overlap; writes queue behind a lease.',
      schema: z.object({ sessionId, tabId: z.number().int().positive() }),
      readOnly: false,
      handler: async (args: { sessionId?: string; tabId: number }) => {
        const sid = resolveSession(ctx, args.sessionId);
        const tab = await runtime.attachExistingTab(sid, args.tabId);
        return text({ tab, session: runtime.getSession(sid) });
      },
    },
    session_switch_tab: {
      description: 'Make one of this session’s tabs the default target for later calls.',
      schema: z.object({ sessionId, tabId: z.number().int().positive() }),
      readOnly: false,
      handler: async (args: { sessionId?: string; tabId: number }) =>
        text({ session: runtime.sessions.setActiveTab(resolveSession(ctx, args.sessionId), args.tabId) }),
    },
    session_close_tab: {
      description: 'Close a tab owned by this session.',
      schema: z.object({ sessionId, tabId }),
      readOnly: false,
      handler: async (args: { sessionId?: string; tabId?: number }) => {
        const sid = resolveSession(ctx, args.sessionId);
        await runtime.closeTab(sid, args.tabId);
        return text({ ok: true, session: runtime.getSession(sid) });
      },
    },
    browser_status: {
      description: 'Host health: extension connection, sessions, active leases, and queued tabs.',
      schema: z.object({}),
      readOnly: true,
      handler: async () => text(runtime.status()),
    },
    chrome_list_tabs: {
      description: 'List every Chrome tab (all sessions and the user’s own tabs).',
      schema: z.object({}),
      readOnly: true,
      handler: async () => text({ tabs: await runtime.listChromeTabs() }),
    },
    chrome_downloads: {
      description: 'Recent downloads seen by the browser (started, completed, failed), newest last.',
      schema: z.object({}),
      readOnly: true,
      handler: async () => text({ downloads: runtime.events.downloads() }),
    },
  };
}

function compositeTools(ctx: ToolContext): Record<string, ToolDefinition> {
  const { runtime } = ctx;
  return {
    chrome_find: {
      description:
        'Search the page snapshot for text or a regex and return matching elements with refs and nearby context. Much cheaper than reading a full snapshot.',
      schema: z.object({
        sessionId,
        tabId,
        query: z.string().min(1).describe('Words that must all appear, e.g. "sign in button"'),
        regex: z.boolean().optional(),
        limit: z.number().int().positive().max(100).optional(),
        contextLines: z.number().int().min(0).max(5).optional(),
      }),
      readOnly: true,
      handler: async (args: { sessionId?: string; tabId?: number; query: string; regex?: boolean; limit?: number; contextLines?: number }) => {
        const snap = await runtime.runOnTab<SnapshotResult>({
          sessionId: resolveSession(ctx, args.sessionId),
          tabId: args.tabId,
          exclusive: false,
          command: 'snapshot',
          args: { filter: 'all', maxChars: 2_000_000 },
        });
        const found = searchSnapshot(snap.snapshot, args.query, args);
        return text({ url: snap.url, title: snap.title, ...found });
      },
    },
    chrome_batch: {
      description:
        'Run several actions in order under one tab lease, so no other model can interleave. Each step is {action, args} where action is a chrome_* tool name without the prefix, e.g. {"action":"fill","args":{"target":"e5","value":"hi"}}.',
      schema: z.object({
        sessionId,
        tabId,
        steps: z
          .array(
            z.object({
              action: z.enum(BATCHABLE_ACTIONS as [TabActionName, ...TabActionName[]]),
              args: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .min(1)
          .max(25),
        stopOnError: z.boolean().optional().describe('Default true'),
        includeSnapshot,
      }),
      readOnly: false,
      handler: async (args: {
        sessionId?: string;
        tabId?: number;
        steps: Array<{ action: TabActionName; args?: Record<string, unknown> }>;
        stopOnError?: boolean;
        includeSnapshot?: boolean;
      }) => {
        const sid = resolveSession(ctx, args.sessionId);
        const steps = args.steps.map((step, index) => {
          const spec = TAB_ACTIONS[step.action];
          const parsed = z.object(spec.args).strict().safeParse(step.args ?? {});
          if (!parsed.success) {
            throw new Error(`Step ${index} (${step.action}) has invalid args: ${parsed.error.message}`);
          }
          if (step.action === 'navigate') assertUrlAllowed(ctx, parsed.data.url);
          return { command: spec.command, args: parsed.data as Record<string, unknown> };
        });
        const results = await runtime.runBatch({
          sessionId: sid,
          tabId: args.tabId,
          steps,
          stopOnError: args.stopOnError ?? true,
        });
        const failed = results.some((r) => !r.ok);
        const content: ToolContent[] = [{ type: 'text', text: JSON.stringify({ completed: results.length, total: steps.length, results }, null, 2) }];
        if (args.includeSnapshot) {
          content.push({ type: 'text', text: await snapshotAfter(runtime, sid, args.tabId) });
        }
        return { content, isError: failed && (args.stopOnError ?? true) };
      },
    },
    chrome_upload_file: {
      description:
        'Set files on an <input type="file"> using absolute paths on this machine (restricted to CHROME_MCP_UPLOAD_DIR when set).',
      schema: z.object({
        sessionId,
        tabId,
        target: z.string().min(1).describe('Ref or selector of the file input'),
        paths: z.array(z.string().min(1)).min(1).max(20),
      }),
      readOnly: false,
      handler: async (args: { sessionId?: string; tabId?: number; target: string; paths: string[] }) => {
        const files = await resolveUploadFiles(args.paths, [], ctx.config.uploadDir);
        const result = await runtime.runOnTab({
          sessionId: resolveSession(ctx, args.sessionId),
          tabId: args.tabId,
          exclusive: true,
          command: 'upload_file',
          args: { target: args.target, paths: files },
        });
        return text(result);
      },
    },
  };
}

export function buildToolHandlers(ctx: ToolContext): Record<string, ToolDefinition> {
  const actionTools = Object.fromEntries(
    (Object.keys(TAB_ACTIONS) as TabActionName[]).map((name) => [`chrome_${name}`, buildActionTool(ctx, name)]),
  );
  return { ...sessionTools(ctx), ...actionTools, ...compositeTools(ctx) };
}
