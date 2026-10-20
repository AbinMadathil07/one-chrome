import type { ToolContent, ToolResult } from '../types.js';
import type { MemberResult } from './executor.js';
import { renderStateChange, renderTabContext, renderTabList, type BrowserState } from './format.js';
import type { MemberName } from './members.js';

function stateChangeLines(state: BrowserState | undefined): string[] {
  return (state?.state_changes ?? []).map(renderStateChange).filter((line): line is string => line != null);
}

function tabManagementText(name: MemberName, input: Record<string, unknown>, state: BrowserState): string {
  switch (name) {
    case 'new_tab': {
      const active = state.tabs.find((tab) => tab.active);
      return `Created new tab with tab_id: ${active?.tab_id ?? 'unknown'}, URL: ${active?.url ?? 'about:blank'}. It is now the current tab.`;
    }
    case 'switch_tab':
      return `Switched to tab ${String(input.tab_id)}`;
    case 'close_tab':
      return `Closed tab ${String(input.tab_id)}`;
    default:
      return renderTabList(state.tabs);
  }
}

/**
 * Renders a member result the way the Claude API would show it to the model, for MCP clients
 * that cannot consume `browser_state` blocks: tab-management text, download lines, Tab Context footer.
 */
export function renderForMcp(name: MemberName, input: Record<string, unknown>, result: MemberResult): ToolResult {
  if (result.isError) {
    return { content: result.content as ToolContent[], isError: true };
  }
  const state = result.browserState;
  const downloads = stateChangeLines(state);

  if (state && (name === 'new_tab' || name === 'list_tabs' || name === 'switch_tab' || name === 'close_tab')) {
    const text = [tabManagementText(name, input, state), ...(downloads.length ? ['', ...downloads] : [])].join('\n');
    return { content: [{ type: 'text', text }] };
  }

  const content: ToolContent[] = result.content.map((block) => ({ ...block }));
  const textBlocks = content.filter((block): block is { type: 'text'; text: string } => block.type === 'text');
  const extra: string[] = [];
  if (downloads.length) extra.push(downloads.join('\n'));
  if (state && name !== 'zoom' && textBlocks.length > 0) {
    extra.push(renderTabContext(result.executedOn ?? state.tabs.find((tab) => tab.active)?.tab_id ?? null, state.tabs));
  }
  if (extra.length) {
    const last = textBlocks[textBlocks.length - 1];
    if (last) {
      last.text = [last.text, ...extra].join('\n\n');
    } else {
      content.push({ type: 'text', text: extra.join('\n\n') });
    }
  }
  return { content };
}

export type ApiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | BrowserState;

export type ApiToolResult = {
  type: 'tool_result';
  tool_use_id: string;
  toolset_name: 'browser';
  content: string | ApiContentBlock[];
  is_error?: true;
};

/** Builds the Messages API `tool_result` block for a member call, `browser_state` included. */
export function toApiToolResult(toolUseId: string, result: MemberResult): ApiToolResult {
  if (result.isError) {
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    return { type: 'tool_result', tool_use_id: toolUseId, toolset_name: 'browser', content: text, is_error: true };
  }
  const content: ApiContentBlock[] = result.content.map((block) =>
    block.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } }
      : { type: 'text', text: block.text },
  );
  if (result.browserState) content.push(result.browserState);
  return { type: 'tool_result', tool_use_id: toolUseId, toolset_name: 'browser', content };
}
