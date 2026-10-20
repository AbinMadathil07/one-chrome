import { z } from 'zod';
import type { ClaudeBrowserExecutor } from '../claude/executor.js';
import { MEMBERS } from '../claude/members.js';
import { renderForMcp } from '../claude/render.js';
import type { ToolContext, ToolDefinition } from './tools.js';

/** Exposes Claude's browser toolset members as MCP tools with the same names and input shapes. */
export function buildClaudeTools(ctx: ToolContext, executor: ClaudeBrowserExecutor): Record<string, ToolDefinition> {
  return Object.fromEntries(
    executor.enabledMembers().map((name) => {
      const spec = MEMBERS[name];
      const tool: ToolDefinition = {
        description: spec.description,
        schema: z.object(spec.shape),
        readOnly: spec.readOnly,
        handler: async (args: Record<string, unknown>) => {
          const result = await executor.execute(ctx.defaultSessionId(), name, args);
          return renderForMcp(name, args, result);
        },
      };
      return [name, tool];
    }),
  );
}
