import { z } from 'zod';

export const coordinateTarget = z
  .object({
    type: z.literal('coordinate'),
    x: z.number().describe('Viewport x in screenshot pixels'),
    y: z.number().describe('Viewport y in screenshot pixels'),
  })
  .describe('A viewport-pixel point, as seen in the latest screenshot');

export const refTarget = z
  .object({
    type: z.literal('ref'),
    ref: z.string().regex(/^ref_\d+$/, 'Refs look like "ref_12"').describe('Element reference from read_page or find'),
  })
  .describe('An element reference from read_page or find');

export const target = z.discriminatedUnion('type', [coordinateTarget, refTarget]);

export type CoordinateTarget = z.infer<typeof coordinateTarget>;
export type RefTarget = z.infer<typeof refTarget>;
export type Target = z.infer<typeof target>;

const tabId = z.string().min(1).max(64).optional().describe('Tab to act on (e.g. "tab-12"); defaults to the active tab');
const modifiers = z
  .string()
  .max(40)
  .optional()
  .describe('Modifier chord held during the click, e.g. "shift" or "ctrl+shift"');
const seconds = z.number().min(0).max(30);

export type MemberSpec = {
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  /** Disabled by default in Claude's toolset; still served here unless listed in CHROME_MCP_DISABLED_TOOLS. */
  optional?: boolean;
};

const clickShape = { target, modifiers, tab_id: tabId };

export const MEMBERS = {
  navigate: {
    description:
      'Load an http(s) URL in the tab, or pass "back", "forward", or "reload" to move through history. A URL without a scheme is treated as https://.',
    shape: { url: z.string().min(1).max(8192), tab_id: tabId },
    readOnly: false,
  },
  screenshot: {
    description: 'Capture the visible viewport. Coordinates in this image are the ones pointer members accept.',
    shape: { tab_id: tabId },
    readOnly: true,
  },
  zoom: {
    description: 'Return a cropped, upscaled image of region [x0, y0, x1, y1] (viewport pixels) to inspect small text or controls.',
    shape: { region: z.tuple([z.number(), z.number(), z.number(), z.number()]), tab_id: tabId },
    readOnly: true,
  },
  left_click: { description: 'Left-click a coordinate or a referenced element.', shape: clickShape, readOnly: false },
  right_click: { description: 'Right-click a coordinate or element.', shape: clickShape, readOnly: false },
  middle_click: { description: 'Middle-click a coordinate or element.', shape: clickShape, readOnly: false },
  double_click: { description: 'Double left-click a coordinate or element.', shape: clickShape, readOnly: false },
  triple_click: {
    description: 'Triple left-click a coordinate or element, which typically selects a line or paragraph.',
    shape: clickShape,
    readOnly: false,
  },
  hover: {
    description: 'Move the pointer over a coordinate or element without clicking.',
    shape: { target, tab_id: tabId },
    readOnly: false,
  },
  left_click_drag: {
    description: 'Press at `from`, drag to `target`, and release.',
    shape: { from: coordinateTarget, target: coordinateTarget, tab_id: tabId },
    readOnly: false,
  },
  left_mouse_down: {
    description: 'Press and hold the left button at a coordinate; pair with left_mouse_up for a custom drag.',
    shape: { target: coordinateTarget, tab_id: tabId },
    readOnly: false,
  },
  left_mouse_up: {
    description: 'Release the left button at a coordinate.',
    shape: { target: coordinateTarget, tab_id: tabId },
    readOnly: false,
  },
  mouse_move: {
    description: 'Move the pointer to a coordinate.',
    shape: { target: coordinateTarget, tab_id: tabId },
    readOnly: false,
  },
  scroll: {
    description: 'Scroll at a viewport position. scroll_amount is in wheel notches (1-10, default 3).',
    shape: {
      target: coordinateTarget,
      scroll_direction: z.enum(['up', 'down', 'left', 'right']),
      scroll_amount: z.number().int().min(1).max(10).optional(),
      tab_id: tabId,
    },
    readOnly: false,
  },
  scroll_to: {
    description: 'Scroll a referenced element into view.',
    shape: { target: refTarget, tab_id: tabId },
    readOnly: false,
  },
  type: {
    description: 'Type a literal string at the current focus.',
    shape: { text: z.string().max(100_000), tab_id: tabId },
    readOnly: false,
  },
  key: {
    description:
      'Press a key or chord: a single key ("Enter"), a chord joined with + ("ctrl+a"), or a space-separated sequence ("Backspace Backspace"). repeat is 1-100.',
    shape: { text: z.string().min(1).max(1000), repeat: z.number().int().min(1).max(100).optional(), tab_id: tabId },
    readOnly: false,
  },
  hold_key: {
    description: 'Hold a key or chord for `duration` seconds (0-30).',
    shape: { text: z.string().min(1).max(100), duration: seconds, tab_id: tabId },
    readOnly: false,
  },
  wait: {
    description: 'Pause for `duration` seconds (0-30).',
    shape: { duration: seconds, tab_id: tabId },
    readOnly: true,
  },
  read_page: {
    description:
      'Return the accessibility tree with each element tagged like [ref_2]. Omit filter for visible elements, "interactive" for visible controls only, "all" to include off-screen elements. depth defaults to 15; ref scopes to a subtree.',
    shape: {
      filter: z.enum(['interactive', 'all']).optional(),
      depth: z.number().int().min(1).max(100).optional(),
      ref: z.string().regex(/^ref_\d+$/).optional(),
      tab_id: tabId,
    },
    readOnly: true,
  },
  find: {
    description: 'Find elements matching a natural-language description, e.g. "search field" or "add to cart button". Returns up to 20 tagged matches.',
    shape: { query: z.string().min(1).max(500), tab_id: tabId },
    readOnly: true,
  },
  get_page_text: {
    description: 'Return the page’s visible text, prioritizing the main article content.',
    shape: { tab_id: tabId },
    readOnly: true,
  },
  form_input: {
    description: 'Set a form element’s value directly. Use a boolean for checkboxes and an option value or label for selects.',
    shape: { target: refTarget, value: z.union([z.string(), z.number(), z.boolean()]), tab_id: tabId },
    readOnly: false,
  },
  file_upload: {
    description: 'Set files on a file input from absolute `paths` and/or staged `document_ids` (at least one).',
    shape: {
      target: refTarget,
      paths: z.array(z.string().min(1)).max(20).optional(),
      document_ids: z.array(z.string().min(1)).max(20).optional(),
      tab_id: tabId,
    },
    readOnly: false,
    optional: true,
  },
  read_console: {
    description: 'Return console entries (log, warning, error) since the last read of this tab, one per line.',
    shape: { tab_id: tabId },
    readOnly: true,
    optional: true,
  },
  read_network: {
    description: 'Return network requests (method, URL, status, MIME type, timing) since the last read of this tab, one per line.',
    shape: { tab_id: tabId },
    readOnly: true,
    optional: true,
  },
  javascript_exec: {
    description: 'Run `text` as JavaScript in the page and return the value of the last expression (write an expression, not a return statement).',
    shape: { text: z.string().min(1).max(100_000), tab_id: tabId },
    readOnly: false,
    optional: true,
  },
  new_tab: { description: 'Open a tab and make it the active tab.', shape: {}, readOnly: false },
  list_tabs: { description: 'Report the tab inventory.', shape: {}, readOnly: true },
  switch_tab: {
    description: 'Make tab_id the active tab.',
    shape: { tab_id: z.string().min(1).max(64) },
    readOnly: false,
  },
  close_tab: { description: 'Close tab_id.', shape: { tab_id: z.string().min(1).max(64) }, readOnly: false },
} satisfies Record<string, MemberSpec>;

export type MemberName = keyof typeof MEMBERS;
export const MEMBER_NAMES = Object.keys(MEMBERS) as MemberName[];
export const TAB_MANAGEMENT_MEMBERS = new Set<MemberName>(['new_tab', 'list_tabs', 'switch_tab', 'close_tab']);

export function isMemberName(name: string): name is MemberName {
  return Object.prototype.hasOwnProperty.call(MEMBERS, name);
}
