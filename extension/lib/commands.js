import { DevtoolsManager } from './devtools.js';
import { parseModifierChord } from './keys.js';

const devtools = new DevtoolsManager();

const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];

// These still work while a JavaScript dialog is blocking the page.
const ALLOWED_DURING_DIALOG = new Set([
  'ping', 'list_tabs', 'close_tab', 'get_page', 'handle_dialog', 'console_messages',
  'network_requests', 'get_network_request', 'devtools_attach', 'devtools_detach',
]);

const DIALOG_NOTE = 'A JavaScript dialog opened. Call chrome_handle_dialog to accept or dismiss it before other actions.';

function requireTabId(tabId) {
  if (!Number.isFinite(tabId)) {
    throw new Error('tabId is required for this command');
  }
  return Number(tabId);
}

function toSnapshot(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    active: Boolean(tab.active),
    status: tab.status || 'unknown',
    groupId: tab.groupId >= 0 ? tab.groupId : undefined,
  };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => typeof tab.id === 'number').map(toSnapshot);
}

async function helper(tabId, method, ...args) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/page-helpers.js'] });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, params) => globalThis.__chromeMcp.call(name, params),
    args: [method, args],
  });
  const out = injection?.result;
  if (!out) {
    throw new Error('Page helper returned no result (the page may be navigating or restricted, e.g. chrome://)');
  }
  if (!out.ok) {
    throw new Error(out.error);
  }
  return out.value;
}

function waitForComplete(tabId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    const timer = setInterval(async () => {
      if (Date.now() - started > timeoutMs) {
        cleanup();
        reject(new Error(`Timed out waiting for tab ${tabId} to finish loading`));
        return;
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          cleanup();
          resolve();
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    }, 250);
    function cleanup() {
      clearInterval(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function raceDialog(tabId, promise) {
  if (!devtools.isAttached(tabId)) {
    return promise;
  }
  promise.catch(() => undefined);
  const waiter = devtools.waitForDialog(tabId);
  try {
    return await Promise.race([
      promise,
      waiter.promise.then((dialog) => ({ modal: dialog, note: DIALOG_NOTE })),
    ]);
  } finally {
    waiter.cancel();
  }
}

async function useMouse(tabId, method) {
  if (method === 'dom') return false;
  if (method === 'mouse') {
    await devtools.ensure(tabId);
    return true;
  }
  return devtools.isAttached(tabId);
}

function colorFor(key) {
  let hash = 0;
  for (const char of String(key)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

async function addToGroup(tabId, group) {
  const { mcpGroups = {} } = await chrome.storage.session.get('mcpGroups');
  let groupId = mcpGroups[group.key];
  if (groupId != null) {
    try {
      await chrome.tabGroups.get(groupId);
    } catch {
      groupId = undefined;
    }
  }
  groupId = await chrome.tabs.group({ tabIds: [tabId], ...(groupId != null ? { groupId } : {}) });
  await chrome.tabGroups.update(groupId, {
    title: String(group.title || 'MCP').slice(0, 40),
    color: group.color || colorFor(group.key),
  });
  mcpGroups[group.key] = groupId;
  await chrome.storage.session.set({ mcpGroups });
  return groupId;
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForComplete(tabId);
  const tab = toSnapshot(await chrome.tabs.get(tabId));
  return { ...tab, httpStatus: devtools.latestDocumentStatus(tabId) };
}

async function createTab(args) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: args.active === true });
  let devtoolsAttached = false;
  if (args.devtools !== false) {
    devtoolsAttached = await devtools.tryEnsure(tab.id);
  }
  if (args.group?.key) {
    await addToGroup(tab.id, args.group).catch(() => undefined);
  }
  if (args.url && args.url !== 'about:blank') {
    await navigateTab(tab.id, args.url);
  }
  return { ...toSnapshot(await chrome.tabs.get(tab.id)), devtoolsAttached };
}

function clickOptions(args) {
  return {
    button: args.button || 'left',
    clickCount: Number(args.clickCount) || (args.doubleClick ? 2 : 1),
    modifiers: parseModifierChord(args.modifiers),
  };
}

async function click(tabId, args) {
  if (args.x != null && args.y != null) {
    await devtools.ensure(tabId);
    return devtools.mouseClick(tabId, Number(args.x), Number(args.y), clickOptions(args));
  }
  const needsMouse = args.modifiers || (args.button && args.button !== 'left') || Number(args.clickCount) > 2;
  if (await useMouse(tabId, needsMouse ? 'mouse' : args.method)) {
    const point = await helper(tabId, 'point', args.target);
    const result = await devtools.mouseClick(tabId, point.x, point.y, clickOptions(args));
    return { ...result, clicked: point.element, warning: point.obscuredBy ? `Click landed on ${point.obscuredBy}` : undefined };
  }
  return helper(tabId, 'domClick', args.target, Boolean(args.doubleClick));
}

async function hover(tabId, args) {
  if (args.x != null && args.y != null) {
    return devtools.mouseMove(tabId, Number(args.x), Number(args.y));
  }
  if (await useMouse(tabId, args.method)) {
    const point = await helper(tabId, 'point', args.target);
    return { ...(await devtools.mouseMove(tabId, point.x, point.y)), hovered: point.element };
  }
  return helper(tabId, 'domHover', args.target);
}

async function typeText(tabId, args) {
  const text = String(args.text ?? '');
  if (args.atFocus) {
    await devtools.ensure(tabId);
    return devtools.insertText(tabId, text);
  }
  const focused = await helper(tabId, 'focus', args.target ?? null, Boolean(args.clear));
  let result;
  if (devtools.isAttached(tabId)) {
    result = { ...(await devtools.insertText(tabId, text)), ...focused };
  } else {
    result = await helper(tabId, 'domType', null, text);
  }
  if (args.submit) {
    if (devtools.isAttached(tabId)) {
      await devtools.pressKey(tabId, 'Enter');
    } else {
      await helper(tabId, 'domKey', 'Enter');
    }
    result.submitted = true;
  }
  return result;
}

async function pressKey(tabId, args) {
  if (args.target) {
    await helper(tabId, 'focus', args.target, false);
  }
  const combos = args.sequence ? String(args.key).trim().split(/\s+/) : [String(args.key)];
  const repeat = Math.min(Math.max(Number(args.repeat) || 1, 1), 100);
  const viaKeyboard = await useMouse(tabId, combos.length > 1 || repeat > 1 ? 'mouse' : 'auto');
  for (let i = 0; i < repeat; i += 1) {
    for (const combo of combos) {
      if (viaKeyboard) {
        await devtools.pressKey(tabId, combo);
      } else {
        await helper(tabId, 'domKey', combo);
      }
    }
  }
  return { pressed: combos, repeat, method: viaKeyboard ? 'keyboard' : 'dom' };
}

async function mouse(tabId, args) {
  const x = Number(args.x);
  const y = Number(args.y);
  if (args.action === 'move') return devtools.mouseMove(tabId, x, y);
  if (args.action === 'down' || args.action === 'up') return devtools.mouseButton(tabId, args.action, x, y);
  throw new Error(`Unknown mouse action ${args.action}`);
}

const SCROLL_SETTLE_POLL_MS = 60;
const SCROLL_SETTLE_MAX_MS = 1500;

/** Wheel scrolling is animated; report the position once it stops moving. */
async function waitForScrollToSettle(tabId) {
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_POLL_MS * 2));
  let last = await helper(tabId, 'pageInfo');
  let stableReads = 0;
  while (Date.now() - started < SCROLL_SETTLE_MAX_MS && stableReads < 2) {
    await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_POLL_MS));
    const next = await helper(tabId, 'pageInfo');
    stableReads = next.scrollX === last.scrollX && next.scrollY === last.scrollY ? stableReads + 1 : 0;
    last = next;
  }
  return last;
}

async function scroll(tabId, args) {
  if (args.x != null && args.y != null && devtools.isAttached(tabId)) {
    await devtools.mouseWheel(tabId, Number(args.x), Number(args.y), Number(args.deltaX || 0), Number(args.deltaY || 0));
    return waitForScrollToSettle(tabId);
  }
  return helper(tabId, 'scroll', {
    target: args.target ?? null,
    deltaX: args.deltaX ?? 0,
    deltaY: args.deltaY ?? 0,
    to: args.to ?? null,
  });
}

async function dragPoint(tabId, spec) {
  if (spec && typeof spec === 'object' && spec.x != null && spec.y != null) {
    return { x: Number(spec.x), y: Number(spec.y) };
  }
  return helper(tabId, 'point', spec);
}

async function drag(tabId, args) {
  await devtools.ensure(tabId);
  const from = await dragPoint(tabId, args.from);
  const to = await dragPoint(tabId, args.to);
  return devtools.mouseDrag(tabId, { x: from.x, y: from.y }, { x: to.x, y: to.y });
}

async function evaluate(tabId, args) {
  const script = String(args.script || '');
  if (await devtools.tryEnsure(tabId)) {
    return devtools.evaluate(tabId, script);
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (body) => {
      try {
        // Fallback when DevTools cannot attach; subject to the page's CSP.
        // eslint-disable-next-line no-new-func
        const value = await Function(`"use strict"; return (async () => (${body}))();`)();
        return { result: typeof value === 'function' ? await value() : value };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    args: [script],
  });
  if (injection?.result?.error) throw new Error(injection.result.error);
  return { result: injection?.result?.result ?? null };
}

async function screenshot(tabId, args) {
  const format = args.format || 'png';
  if (args.viewportCss) {
    return devtools.viewportShot(tabId, { format, quality: args.quality, ...args.viewportCss });
  }
  if (await devtools.tryEnsure(tabId)) {
    try {
      let clip;
      if (args.target) {
        const point = await helper(tabId, 'point', args.target);
        clip = point.pageRect;
      }
      return await devtools.screenshot(tabId, { format, quality: args.quality, clip, fullPage: args.fullPage });
    } catch (error) {
      if (args.target || args.fullPage) throw error;
    }
  }
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const captureFormat = format === 'jpeg' ? 'jpeg' : 'png';
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: captureFormat,
    ...(captureFormat === 'jpeg' && args.quality ? { quality: Number(args.quality) } : {}),
  });
  return { data: dataUrl.split(',')[1], mimeType: `image/${captureFormat}`, note: 'Captured via visible tab (tab was activated)' };
}

async function pageFetch(tabId, args) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (url, method, headers, body, maxChars) => {
      const response = await fetch(url, { method, headers: headers || undefined, body: body || undefined, credentials: 'include' });
      const text = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
      };
    },
    args: [String(args.url), String(args.method || 'GET'), args.headers || null, args.body || null, Number(args.maxBodyChars) || 100_000],
  });
  return injection?.result;
}

async function getPage(tabId) {
  const tab = toSnapshot(await chrome.tabs.get(tabId));
  const dialog = devtools.dialog(tabId);
  const info = dialog ? {} : await helper(tabId, 'pageInfo').catch(() => ({}));
  return { ...tab, ...info, devtoolsAttached: devtools.isAttached(tabId), modal: dialog || undefined };
}

const handlers = {
  ping: async () => ({ ok: true, ts: Date.now(), version: chrome.runtime.getManifest().version }),
  list_tabs: async () => listTabs(),
  create_tab: async (_tabId, args) => createTab(args),
  close_tab: async (tabId) => {
    await chrome.tabs.remove(requireTabId(tabId));
    return { closed: tabId };
  },
  activate_tab: async (tabId) => {
    const tab = await chrome.tabs.update(requireTabId(tabId), { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return toSnapshot(tab);
  },
  navigate: async (tabId, args) => raceDialog(tabId, navigateTab(tabId, String(args.url))),
  reload: async (tabId, args) =>
    raceDialog(tabId, (async () => {
      await chrome.tabs.reload(tabId, { bypassCache: Boolean(args.ignoreCache) });
      await waitForComplete(tabId);
      return { ...toSnapshot(await chrome.tabs.get(tabId)), httpStatus: devtools.latestDocumentStatus(tabId) };
    })()),
  go_back: async (tabId) => {
    await chrome.tabs.goBack(tabId);
    await waitForComplete(tabId, 10_000).catch(() => undefined);
    return toSnapshot(await chrome.tabs.get(tabId));
  },
  go_forward: async (tabId) => {
    await chrome.tabs.goForward(tabId);
    await waitForComplete(tabId, 10_000).catch(() => undefined);
    return toSnapshot(await chrome.tabs.get(tabId));
  },
  get_page: async (tabId) => getPage(tabId),
  snapshot: async (tabId, args) =>
    helper(tabId, 'snapshot', {
      filter: args.filter,
      depth: args.depth,
      target: args.target,
      boxes: args.boxes,
      maxChars: args.maxChars,
      includeHidden: args.includeHidden,
      viewportOnly: args.viewportOnly,
    }),
  get_text: async (tabId, args) => helper(tabId, 'text', args.target ?? null),
  get_main_text: async (tabId, args) => helper(tabId, 'mainText', args.maxChars ?? 100_000),
  get_html: async (tabId, args) => helper(tabId, 'html', args.target ?? null, args.maxChars ?? 200_000),
  get_interactive_elements: async (tabId, args) => helper(tabId, 'interactive', args.limit ?? 100),
  screenshot: async (tabId, args) => screenshot(tabId, args),
  click: async (tabId, args) => raceDialog(tabId, click(tabId, args)),
  hover: async (tabId, args) => raceDialog(tabId, hover(tabId, args)),
  fill: async (tabId, args) => raceDialog(tabId, helper(tabId, 'fill', args.target, args.value, args.clear !== false)),
  fill_form: async (tabId, args) => raceDialog(tabId, helper(tabId, 'fillForm', args.fields || [])),
  type: async (tabId, args) => raceDialog(tabId, typeText(tabId, args)),
  press_key: async (tabId, args) => raceDialog(tabId, pressKey(tabId, args)),
  hold_key: async (tabId, args) =>
    raceDialog(tabId, devtools.holdKey(tabId, String(args.key), Math.min(Math.max(Number(args.durationMs) || 0, 0), 30_000))),
  mouse: async (tabId, args) => raceDialog(tabId, mouse(tabId, args)),
  select_option: async (tabId, args) => raceDialog(tabId, helper(tabId, 'selectOption', args.target, args.values || [])),
  scroll: async (tabId, args) => scroll(tabId, args),
  drag: async (tabId, args) => raceDialog(tabId, drag(tabId, args)),
  evaluate: async (tabId, args) => raceDialog(tabId, evaluate(tabId, args)),
  wait_for: async (tabId, args) =>
    helper(tabId, 'waitFor', {
      target: args.target,
      state: args.state,
      text: args.text,
      textGone: args.textGone,
      time: args.time,
      timeoutMs: args.timeoutMs,
    }),
  fetch: async (tabId, args) => pageFetch(tabId, args),
  upload_file: async (tabId, args) => {
    const selector = await helper(tabId, 'refSelector', args.target);
    return devtools.uploadFiles(tabId, selector, args.paths || []);
  },
  console_messages: async (tabId, args) => devtools.consoleMessages(tabId, args),
  network_requests: async (tabId, args) => devtools.networkRequests(tabId, args),
  get_network_request: async (tabId, args) => devtools.networkRequest(tabId, args.reqid, args),
  handle_dialog: async (tabId, args) => devtools.handleDialog(tabId, args.accept, args.promptText),
  emulate: async (tabId, args) => devtools.emulate(tabId, args),
  performance_metrics: async (tabId) => devtools.performanceMetrics(tabId),
  devtools_attach: async (tabId) => {
    await devtools.ensure(tabId);
    return { attached: true, tabId };
  },
  devtools_detach: async (tabId) => devtools.detach(tabId),
  resize_window: async (tabId, args) => {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.update(tab.windowId, {
      state: 'normal',
      width: Number(args.width),
      height: Number(args.height),
    });
    return { windowId: win.id, width: win.width, height: win.height };
  },
};

const TAB_FREE_COMMANDS = new Set(['ping', 'list_tabs', 'create_tab']);

export async function executeCommand(command, args = {}, tabId) {
  const handler = handlers[command];
  if (!handler) {
    throw new Error(`Unsupported command: ${command}`);
  }
  const id = TAB_FREE_COMMANDS.has(command) ? tabId : requireTabId(tabId);
  if (id != null && !ALLOWED_DURING_DIALOG.has(command)) {
    const dialog = devtools.dialog(id);
    if (dialog) {
      throw new Error(`Blocked by ${dialog.type} dialog "${dialog.message}". ${DIALOG_NOTE}`);
    }
  }
  return handler(id, args);
}
