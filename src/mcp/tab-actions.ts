import { z } from 'zod';
import type { BridgeCommandName } from '../types.js';

export type TabAction = {
  command: BridgeCommandName;
  /** Exclusive actions mutate the page and are serialized per tab; shared actions may overlap. */
  exclusive: boolean;
  batchable: boolean;
  description: string;
  args: z.ZodRawShape;
};

const target = z
  .string()
  .min(1)
  .describe('Element to act on: a snapshot ref like "e12" (preferred), a CSS selector, or "text=Sign in"');
const x = z.number().describe('Viewport x coordinate in CSS pixels (from a screenshot or [box=] in a snapshot)');
const y = z.number().describe('Viewport y coordinate in CSS pixels');
const method = z
  .enum(['auto', 'mouse', 'dom'])
  .optional()
  .describe('auto = real CDP mouse input when DevTools is attached, otherwise DOM events');

const NETWORK_PRESETS = ['none', 'Offline', 'Slow 3G', 'Fast 3G', 'Slow 4G', 'Fast 4G'] as const;

function action(spec: Omit<TabAction, 'batchable'> & { batchable?: boolean }): TabAction {
  return { batchable: true, ...spec };
}

export const TAB_ACTIONS = {
  navigate: action({
    command: 'navigate',
    exclusive: true,
    description: 'Navigate the tab to a URL and wait for load. Reports the main document HTTP status when DevTools is attached.',
    args: { url: z.string().url() },
  }),
  reload: action({
    command: 'reload',
    exclusive: true,
    description: 'Reload the tab and wait for load.',
    args: { ignoreCache: z.boolean().optional() },
  }),
  go_back: action({ command: 'go_back', exclusive: true, description: 'Go back in tab history.', args: {} }),
  go_forward: action({ command: 'go_forward', exclusive: true, description: 'Go forward in tab history.', args: {} }),
  activate_tab: action({
    command: 'activate_tab',
    exclusive: true,
    description: 'Bring the tab to the front so a human can watch it. Not needed for automation.',
    args: {},
  }),
  get_page: action({
    command: 'get_page',
    exclusive: false,
    description: 'URL, title, readyState, scroll, viewport, DevTools status, and any open JavaScript dialog.',
    args: {},
  }),
  snapshot: action({
    command: 'snapshot',
    exclusive: false,
    description:
      'Accessibility-style snapshot of the page. Each element gets a stable [ref=eN] you can pass as `target` to click/fill/hover/etc. Prefer this over screenshots for deciding what to do.',
    args: {
      filter: z.enum(['all', 'interactive']).optional().describe('interactive = only links, buttons, inputs, etc.'),
      target: target.optional().describe('Only snapshot this element subtree'),
      depth: z.number().int().positive().optional(),
      boxes: z.boolean().optional().describe('Include [box=x,y,w,h] viewport coordinates'),
      maxChars: z.number().int().positive().optional().describe('Default 40000'),
      includeHidden: z.boolean().optional(),
    },
  }),
  get_text: action({
    command: 'get_text',
    exclusive: false,
    description: 'Visible text of the page or an element.',
    args: { target: target.optional() },
  }),
  get_html: action({
    command: 'get_html',
    exclusive: false,
    description: 'outerHTML of the page or an element.',
    args: { target: target.optional(), maxChars: z.number().int().positive().optional() },
  }),
  screenshot: action({
    command: 'screenshot',
    exclusive: false,
    batchable: false,
    description:
      'Screenshot via DevTools (works on background tabs, no focus stealing). Supports full page, a single element, and png/jpeg/webp.',
    args: {
      target: target.optional().describe('Capture just this element'),
      fullPage: z.boolean().optional(),
      format: z.enum(['png', 'jpeg', 'webp']).optional(),
      quality: z.number().int().min(1).max(100).optional().describe('jpeg/webp only'),
    },
  }),
  click: action({
    command: 'click',
    exclusive: true,
    description: 'Click an element by ref/selector, or at x/y coordinates. Uses trusted CDP mouse events when available.',
    args: {
      target: target.optional(),
      x: x.optional(),
      y: y.optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      doubleClick: z.boolean().optional(),
      clickCount: z.number().int().min(1).max(3).optional().describe('3 = triple click (select a paragraph)'),
      modifiers: z.string().max(40).optional().describe('Held during the click, e.g. "shift" or "ctrl+shift"'),
      method,
    },
  }),
  hover: action({
    command: 'hover',
    exclusive: true,
    description: 'Hover an element (or x/y) to reveal menus and tooltips.',
    args: { target: target.optional(), x: x.optional(), y: y.optional(), method },
  }),
  fill: action({
    command: 'fill',
    exclusive: true,
    description: 'Set the value of an input, textarea, contenteditable, select, checkbox, or radio.',
    args: {
      target,
      value: z.union([z.string(), z.number(), z.boolean()]),
      clear: z.boolean().optional().describe('Replace existing value (default true)'),
    },
  }),
  fill_form: action({
    command: 'fill_form',
    exclusive: true,
    description: 'Fill several form fields in one call.',
    args: {
      fields: z
        .array(
          z.object({
            target,
            value: z.union([z.string(), z.number(), z.boolean()]),
            clear: z.boolean().optional(),
          }),
        )
        .min(1),
    },
  }),
  type: action({
    command: 'type',
    exclusive: true,
    description: 'Type text like a user (trusted keyboard input when DevTools is attached). Optionally press Enter.',
    args: {
      text: z.string(),
      target: target.optional().describe('Focus this element first; defaults to the focused element'),
      clear: z.boolean().optional(),
      submit: z.boolean().optional().describe('Press Enter after typing'),
    },
  }),
  press_key: action({
    command: 'press_key',
    exclusive: true,
    description: 'Press a key or chord, e.g. "Enter", "Escape", "ArrowDown", "Control+A", "Meta+Shift+K".',
    args: {
      key: z.string().min(1),
      target: target.optional(),
      sequence: z.boolean().optional().describe('Treat key as a space-separated sequence, e.g. "Tab Tab Enter"'),
      repeat: z.number().int().min(1).max(100).optional(),
    },
  }),
  select_option: action({
    command: 'select_option',
    exclusive: true,
    description: 'Choose option(s) in a <select> by value or visible label.',
    args: { target, values: z.array(z.string()).min(1) },
  }),
  scroll: action({
    command: 'scroll',
    exclusive: true,
    description: 'Scroll the page, an element, or the scrollable area under x/y.',
    args: {
      target: target.optional(),
      deltaX: z.number().optional(),
      deltaY: z.number().optional(),
      to: z.enum(['top', 'bottom']).optional(),
      x: x.optional(),
      y: y.optional(),
    },
  }),
  drag: action({
    command: 'drag',
    exclusive: true,
    description: 'Drag from one element to another with real mouse events.',
    args: { from: target, to: target },
  }),
  evaluate: action({
    command: 'evaluate',
    exclusive: true,
    description:
      'Run JavaScript in the page. Accepts an expression ("document.title") or a function ("async () => {...}"). Top-level await works. Returns JSON.',
    args: { script: z.string().min(1) },
  }),
  wait_for: action({
    command: 'wait_for',
    exclusive: false,
    description: 'Wait for an element state, text to appear or disappear, or a fixed time (max 30s).',
    args: {
      target: target.optional(),
      state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
      text: z.string().optional(),
      textGone: z.string().optional(),
      time: z.number().positive().max(30).optional().describe('Seconds to wait first'),
      timeoutMs: z.number().int().positive().max(55_000).optional(),
    },
  }),
  fetch: action({
    command: 'fetch',
    exclusive: true,
    description: 'fetch() from inside the page, using its cookies and origin.',
    args: {
      url: z.string().url(),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      maxBodyChars: z.number().int().positive().optional(),
    },
  }),
  console_messages: action({
    command: 'console_messages',
    exclusive: false,
    description: 'Console logs, warnings, errors, and uncaught exceptions since the last navigation.',
    args: {
      types: z.array(z.string()).optional().describe('e.g. ["error","warn"]'),
      includePreserved: z.boolean().optional().describe('Include the previous 3 navigations'),
      includeStackTraces: z.boolean().optional(),
      pageSize: z.number().int().positive().optional(),
      pageIdx: z.number().int().min(0).optional(),
      clear: z.boolean().optional(),
    },
  }),
  network_requests: action({
    command: 'network_requests',
    exclusive: false,
    description: 'Network requests since the last navigation with status, type, timing, and size.',
    args: {
      resourceTypes: z.array(z.string()).optional().describe('e.g. ["XHR","Fetch","Document"]'),
      urlContains: z.string().optional(),
      failedOnly: z.boolean().optional().describe('Only failed or 4xx/5xx requests'),
      includePreserved: z.boolean().optional(),
      pageSize: z.number().int().positive().optional(),
      pageIdx: z.number().int().min(0).optional(),
    },
  }),
  get_network_request: action({
    command: 'get_network_request',
    exclusive: false,
    description: 'Full detail for one request (headers, post data, response body).',
    args: {
      reqid: z.number().int().positive(),
      includeBody: z.boolean().optional(),
      maxBodyChars: z.number().int().positive().optional(),
    },
  }),
  handle_dialog: action({
    command: 'handle_dialog',
    exclusive: true,
    description: 'Accept or dismiss an open alert/confirm/prompt/beforeunload dialog.',
    args: { accept: z.boolean(), promptText: z.string().optional() },
  }),
  emulate: action({
    command: 'emulate',
    exclusive: true,
    description:
      'Per-tab emulation: viewport/mobile, dark/light mode, user agent, network throttling, CPU throttling, geolocation. Does not affect other models’ tabs.',
    args: {
      viewport: z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          deviceScaleFactor: z.number().positive().optional(),
          mobile: z.boolean().optional(),
        })
        .nullable()
        .optional()
        .describe('null clears the override'),
      colorScheme: z.enum(['dark', 'light', 'auto']).optional(),
      userAgent: z.string().optional().describe('Empty string clears'),
      network: z.enum(NETWORK_PRESETS).optional(),
      cpuThrottlingRate: z.number().min(1).max(20).optional(),
      geolocation: z
        .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().optional() })
        .nullable()
        .optional(),
      reset: z.boolean().optional().describe('Clear all emulation first'),
    },
  }),
  performance_metrics: action({
    command: 'performance_metrics',
    exclusive: false,
    description: 'Core Web Vitals (TTFB, FCP, LCP, CLS) plus JS heap, DOM nodes, layout and script time.',
    args: {},
  }),
  devtools_attach: action({
    command: 'devtools_attach',
    exclusive: true,
    batchable: false,
    description: 'Attach DevTools to an attached/existing tab to enable console, network, dialogs, and trusted input.',
    args: {},
  }),
  devtools_detach: action({
    command: 'devtools_detach',
    exclusive: true,
    batchable: false,
    description: 'Detach DevTools (removes Chrome’s debugging banner for this tab).',
    args: {},
  }),
  resize_window: action({
    command: 'resize_window',
    exclusive: true,
    batchable: false,
    description: 'Resize the whole Chrome window. Affects every tab in it; prefer chrome_emulate viewport for one tab.',
    args: { width: z.number().int().min(200), height: z.number().int().min(200) },
  }),
} satisfies Record<string, TabAction>;

export type TabActionName = keyof typeof TAB_ACTIONS;

export const BATCHABLE_ACTIONS = (Object.keys(TAB_ACTIONS) as TabActionName[]).filter(
  (name) => TAB_ACTIONS[name].batchable,
);
