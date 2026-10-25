export type SessionId = string;
export type TabId = number;
export type LeaseId = string;
export type ClientId = string;

export type TabSnapshot = {
  tabId: TabId;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  status: string;
  groupId?: number;
  devtoolsAttached?: boolean;
};

export type SessionInfo = {
  sessionId: SessionId;
  clientId: ClientId;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  ownedTabIds: TabId[];
  activeTabId: TabId | null;
};

export type LeaseInfo = {
  leaseId: LeaseId;
  tabId: TabId;
  sessionId: SessionId;
  exclusive: boolean;
  acquiredAt: number;
  expiresAt: number;
};

export const BRIDGE_COMMANDS = [
  'ping',
  'list_tabs',
  'create_tab',
  'close_tab',
  'activate_tab',
  'navigate',
  'reload',
  'go_back',
  'go_forward',
  'get_page',
  'snapshot',
  'get_text',
  'get_html',
  'get_interactive_elements',
  'screenshot',
  'click',
  'hover',
  'fill',
  'fill_form',
  'type',
  'press_key',
  'select_option',
  'scroll',
  'drag',
  'evaluate',
  'wait_for',
  'fetch',
  'upload_file',
  'console_messages',
  'get_console_message',
  'network_requests',
  'get_network_request',
  'performance_start_trace',
  'performance_stop_trace',
  'handle_dialog',
  'emulate',
  'performance_metrics',
  'devtools_attach',
  'devtools_detach',
  'resize_window',
  'get_main_text',
  'hold_key',
  'mouse',
] as const;

export type BridgeCommandName = (typeof BRIDGE_COMMANDS)[number];

export type BridgeRequest = {
  id: string;
  type: 'command';
  command: BridgeCommandName;
  tabId?: TabId;
  args?: Record<string, unknown>;
};

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};
