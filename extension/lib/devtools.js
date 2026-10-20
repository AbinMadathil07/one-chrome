import { parseKeyCombo } from './keys.js';

const PROTOCOL_VERSION = '1.3';
const MAX_CONSOLE = 1000;
const MAX_NETWORK = 1000;
const MAX_POST_DATA = 4000;
const PRESERVED_NAVIGATIONS = 3;

const NETWORK_PRESETS = {
  Offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'Slow 3G': { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  'Fast 3G': { offline: false, latency: 563, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  'Slow 4G': { offline: false, latency: 150, downloadThroughput: 400_000, uploadThroughput: 150_000 },
  'Fast 4G': { offline: false, latency: 60, downloadThroughput: 1_125_000, uploadThroughput: 375_000 },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

function previewRemoteObject(obj) {
  if (!obj) return '';
  if (obj.type === 'string') return obj.value;
  if ('value' in obj) {
    try {
      return typeof obj.value === 'object' ? JSON.stringify(obj.value) : String(obj.value);
    } catch {
      return String(obj.value);
    }
  }
  if (obj.unserializableValue) return obj.unserializableValue;
  if (obj.preview?.properties) {
    const props = obj.preview.properties.map((p) => `${p.name}: ${p.value ?? p.type}`).join(', ');
    return obj.subtype === 'array' ? `[${props}]` : `{${props}${obj.preview.overflow ? ', …' : ''}}`;
  }
  return obj.description || obj.type;
}

function formatStack(stackTrace) {
  if (!stackTrace?.callFrames?.length) return undefined;
  return stackTrace.callFrames
    .slice(0, 10)
    .map((f) => `${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`);
}

function paginate(items, pageSize, pageIdx) {
  if (!pageSize) return { items, total: items.length };
  const start = (pageIdx || 0) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, pageIdx: pageIdx || 0, pageSize };
}

function checkEvaluation(response) {
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    throw new Error(details.exception?.description || details.text || 'Evaluation failed');
  }
  return response.result || { type: 'undefined' };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class DevtoolsManager {
  constructor() {
    this.tabs = new Map();
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId != null) this.onEvent(source.tabId, method, params || {});
    });
    chrome.debugger.onDetach.addListener((source, reason) => {
      const state = this.tabs.get(source.tabId);
      if (state) {
        state.attached = false;
        state.detachReason = reason;
        state.dialog = null;
      }
    });
    chrome.tabs.onRemoved.addListener((tabId) => this.tabs.delete(tabId));
  }

  state(tabId) {
    let state = this.tabs.get(tabId);
    if (!state) {
      state = {
        attached: false,
        attaching: null,
        detachReason: null,
        nav: 0,
        consoleSeq: 0,
        console: [],
        nextReqId: 1,
        network: new Map(),
        networkOrder: [],
        requestIdToReqid: new Map(),
        dialog: null,
        dialogWaiters: new Set(),
      };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  isAttached(tabId) {
    return Boolean(this.tabs.get(tabId)?.attached);
  }

  dialog(tabId) {
    return this.tabs.get(tabId)?.dialog || null;
  }

  async ensure(tabId) {
    const state = this.state(tabId);
    if (state.attached) return state;
    if (!state.attaching) {
      state.attaching = (async () => {
        try {
          await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/already attached/i.test(message)) {
            throw new Error(`Could not attach DevTools to tab ${tabId}: ${message}`);
          }
        }
        state.attached = true;
        state.detachReason = null;
        await Promise.all([
          this.send(tabId, 'Runtime.enable'),
          this.send(tabId, 'Page.enable'),
          this.send(tabId, 'Log.enable'),
          this.send(tabId, 'Network.enable', { maxPostDataSize: MAX_POST_DATA }),
        ]);
        // Lets background tabs behave as focused so several models can work in parallel tabs.
        await this.send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
      })().finally(() => {
        state.attaching = null;
      });
    }
    await state.attaching;
    return state;
  }

  async tryEnsure(tabId) {
    try {
      await this.ensure(tabId);
      return true;
    } catch {
      return false;
    }
  }

  async detach(tabId) {
    const state = this.tabs.get(tabId);
    if (!state?.attached) return { detached: false };
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    state.attached = false;
    return { detached: true };
  }

  send(tabId, method, params = {}) {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  /** Resolves when a JS dialog opens on the tab; used to unblock actions that triggered it. */
  waitForDialog(tabId) {
    const state = this.state(tabId);
    let entry;
    const promise = new Promise((resolve) => {
      entry = resolve;
      state.dialogWaiters.add(entry);
    });
    return { promise, cancel: () => state.dialogWaiters.delete(entry) };
  }

  onEvent(tabId, method, params) {
    const state = this.state(tabId);
    switch (method) {
      case 'Page.frameNavigated':
        if (!params.frame?.parentId) state.nav += 1;
        break;
      case 'Page.javascriptDialogOpening':
        state.dialog = {
          type: params.type,
          message: params.message,
          defaultPrompt: params.defaultPrompt,
          url: params.url,
        };
        for (const resolve of state.dialogWaiters) resolve(state.dialog);
        state.dialogWaiters.clear();
        break;
      case 'Page.javascriptDialogClosed':
        state.dialog = null;
        break;
      case 'Runtime.consoleAPICalled':
        this.pushConsole(state, {
          type: params.type === 'warning' ? 'warn' : params.type,
          text: (params.args || []).map(previewRemoteObject).join(' '),
          stack: formatStack(params.stackTrace),
          source: 'console',
        });
        break;
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails || {};
        this.pushConsole(state, {
          type: 'error',
          text: details.exception?.description || details.text || 'Uncaught exception',
          stack: formatStack(details.stackTrace),
          source: 'exception',
          url: details.url,
        });
        break;
      }
      case 'Log.entryAdded':
        this.pushConsole(state, {
          type: params.entry?.level === 'warning' ? 'warn' : params.entry?.level || 'info',
          text: params.entry?.text || '',
          source: params.entry?.source || 'log',
          url: params.entry?.url,
        });
        break;
      case 'Network.requestWillBeSent':
        this.onRequest(state, params);
        break;
      case 'Network.responseReceived': {
        const entry = this.entryFor(state, params.requestId);
        if (entry) {
          const r = params.response || {};
          Object.assign(entry, {
            status: r.status,
            statusText: r.statusText,
            mimeType: r.mimeType,
            responseHeaders: r.headers,
            protocol: r.protocol,
            fromCache: Boolean(r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache),
            resourceType: params.type || entry.resourceType,
          });
        }
        break;
      }
      case 'Network.loadingFinished': {
        const entry = this.entryFor(state, params.requestId);
        if (entry) {
          entry.finished = true;
          entry.encodedDataLength = params.encodedDataLength;
          entry.durationMs = Math.round((params.timestamp - entry.startTimestamp) * 1000);
        }
        break;
      }
      case 'Network.loadingFailed': {
        const entry = this.entryFor(state, params.requestId);
        if (entry) {
          entry.failed = true;
          entry.errorText = params.canceled ? 'canceled' : params.errorText;
          entry.durationMs = Math.round((params.timestamp - entry.startTimestamp) * 1000);
        }
        break;
      }
      default:
        break;
    }
  }

  pushConsole(state, message) {
    state.consoleSeq += 1;
    state.console.push({ msgid: state.consoleSeq, nav: state.nav, time: Date.now(), ...message });
    if (state.console.length > MAX_CONSOLE) state.console.shift();
  }

  entryFor(state, requestId) {
    const reqid = state.requestIdToReqid.get(requestId);
    return reqid ? state.network.get(reqid) : null;
  }

  onRequest(state, params) {
    if (params.redirectResponse) {
      const previous = this.entryFor(state, params.requestId);
      if (previous) {
        previous.status = params.redirectResponse.status;
        previous.statusText = params.redirectResponse.statusText;
        previous.responseHeaders = params.redirectResponse.headers;
        previous.redirectedTo = params.request?.url;
        previous.finished = true;
      }
    }
    const reqid = state.nextReqId++;
    const request = params.request || {};
    const entry = {
      reqid,
      // Navigation requests arrive before Page.frameNavigated bumps the counter.
      nav: params.type === 'Document' && params.loaderId === params.requestId ? state.nav + 1 : state.nav,
      requestId: params.requestId,
      url: request.url,
      method: request.method,
      resourceType: params.type || 'Other',
      requestHeaders: request.headers,
      postData: request.postData ? String(request.postData).slice(0, MAX_POST_DATA) : undefined,
      hasPostData: Boolean(request.hasPostData),
      startTimestamp: params.timestamp,
      wallTime: params.wallTime ? Math.round(params.wallTime * 1000) : Date.now(),
      status: undefined,
      finished: false,
      failed: false,
    };
    state.network.set(reqid, entry);
    state.networkOrder.push(reqid);
    state.requestIdToReqid.set(params.requestId, reqid);
    while (state.networkOrder.length > MAX_NETWORK) {
      const dropped = state.networkOrder.shift();
      const old = state.network.get(dropped);
      state.network.delete(dropped);
      if (old && state.requestIdToReqid.get(old.requestId) === dropped) {
        state.requestIdToReqid.delete(old.requestId);
      }
    }
  }

  navFilter(state, includePreserved) {
    const minNav = includePreserved ? state.nav - PRESERVED_NAVIGATIONS : state.nav;
    return (item) => item.nav >= minNav;
  }

  async consoleMessages(tabId, options = {}) {
    const state = await this.ensure(tabId);
    const types = options.types?.length ? new Set(options.types) : null;
    const afterId = Number(options.afterId);
    const items = state.console
      .filter(Number.isFinite(afterId) ? (m) => m.msgid > afterId : this.navFilter(state, options.includePreserved))
      .filter((m) => !types || types.has(m.type))
      .map(({ stack, ...rest }) => (options.includeStackTraces ? { ...rest, stack } : rest));
    const page = paginate(items, options.pageSize, options.pageIdx);
    if (options.clear) state.console = [];
    return { ...page, attachedSinceNavigation: state.nav, lastId: state.consoleSeq };
  }

  async networkRequests(tabId, options = {}) {
    const state = await this.ensure(tabId);
    const types = options.resourceTypes?.length ? new Set(options.resourceTypes) : null;
    const needle = options.urlContains ? String(options.urlContains).toLowerCase() : null;
    const afterId = Number(options.afterId);
    const items = state.networkOrder
      .map((id) => state.network.get(id))
      .filter(Boolean)
      .filter(Number.isFinite(afterId) ? (r) => r.reqid > afterId : this.navFilter(state, options.includePreserved))
      .filter((r) => !types || types.has(r.resourceType))
      .filter((r) => !needle || r.url.toLowerCase().includes(needle))
      .filter((r) => !options.failedOnly || r.failed || (r.status ?? 0) >= 400)
      .map((r) => ({
        reqid: r.reqid,
        method: r.method,
        url: r.url.length > 300 ? `${r.url.slice(0, 300)}…` : r.url,
        resourceType: r.resourceType,
        status: r.failed ? `failed: ${r.errorText}` : r.status ?? 'pending',
        mimeType: r.mimeType,
        durationMs: r.durationMs,
        size: r.encodedDataLength,
        fromCache: r.fromCache || undefined,
        done: r.finished || r.failed,
      }));
    return paginate(items, options.pageSize, options.pageIdx);
  }

  async networkRequest(tabId, reqid, options = {}) {
    const state = await this.ensure(tabId);
    const entry = state.network.get(Number(reqid));
    if (!entry) {
      throw new Error(`No network request with reqid ${reqid}. Call chrome_network_requests to list current ids.`);
    }
    const detail = { ...entry };
    delete detail.startTimestamp;
    if (options.includeBody !== false && entry.finished && !entry.failed) {
      const maxChars = Number(options.maxBodyChars) || 50_000;
      try {
        const body = await this.send(tabId, 'Network.getResponseBody', { requestId: entry.requestId });
        const text = body.base64Encoded ? `[base64 ${body.body.length} chars]` : body.body;
        detail.responseBody = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
      } catch (error) {
        detail.responseBody = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (entry.hasPostData && !entry.postData) {
      try {
        const post = await this.send(tabId, 'Network.getRequestPostData', { requestId: entry.requestId });
        detail.postData = String(post.postData).slice(0, MAX_POST_DATA);
      } catch {
        // Post data is not always retained by Chrome.
      }
    }
    return detail;
  }

  latestDocumentStatus(tabId) {
    const state = this.tabs.get(tabId);
    if (!state) return undefined;
    for (let i = state.networkOrder.length - 1; i >= 0; i -= 1) {
      const entry = state.network.get(state.networkOrder[i]);
      if (entry?.resourceType === 'Document') {
        return entry.failed ? `failed: ${entry.errorText}` : entry.status;
      }
    }
    return undefined;
  }

  async handleDialog(tabId, accept, promptText) {
    const state = await this.ensure(tabId);
    if (!state.dialog) {
      throw new Error('No JavaScript dialog is open on this tab');
    }
    const dialog = state.dialog;
    await this.send(tabId, 'Page.handleJavaScriptDialog', {
      accept: Boolean(accept),
      ...(promptText != null ? { promptText: String(promptText) } : {}),
    });
    state.dialog = null;
    return { handled: dialog, accepted: Boolean(accept) };
  }

  async mouseClick(tabId, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    await this.ensure(tabId);
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    for (let i = 1; i <= clickCount; i += 1) {
      await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
      await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
    }
    return { x: Math.round(x), y: Math.round(y), button, clickCount, method: 'mouse' };
  }

  async mouseMove(tabId, x, y) {
    const state = await this.ensure(tabId);
    const held = state.leftButtonDown ? { button: 'left', buttons: 1 } : {};
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, ...held });
    return { x: Math.round(x), y: Math.round(y), method: 'mouse' };
  }

  /** Low-level left button press/release so callers can compose custom drags. */
  async mouseButton(tabId, action, x, y) {
    const state = await this.ensure(tabId);
    const pressed = action === 'down';
    await this.send(tabId, 'Input.dispatchMouseEvent', {
      type: pressed ? 'mousePressed' : 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: pressed ? 1 : 0,
      clickCount: 1,
    });
    state.leftButtonDown = pressed;
    return { x: Math.round(x), y: Math.round(y), action };
  }

  async mouseWheel(tabId, x, y, deltaX, deltaY) {
    await this.ensure(tabId);
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    return { x, y, deltaX, deltaY };
  }

  async mouseDrag(tabId, from, to, steps = 10) {
    await this.ensure(tabId);
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    return { from, to };
  }

  async insertText(tabId, text) {
    await this.ensure(tabId);
    await this.send(tabId, 'Input.insertText', { text });
    return { typed: text.length, method: 'keyboard' };
  }

  async keyDown(tabId, parsed) {
    let bitmask = 0;
    for (const mod of parsed.modifiers) {
      bitmask |= mod.bit;
      await this.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: mod.name, code: mod.code, windowsVirtualKeyCode: mod.keyCode, modifiers: bitmask,
      });
    }
    const { key } = parsed;
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: key.text ? 'keyDown' : 'rawKeyDown',
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      text: key.text,
      unmodifiedText: key.text,
      modifiers: parsed.bitmask,
    });
  }

  async keyUp(tabId, parsed) {
    const { key } = parsed;
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: parsed.bitmask,
    });
    let bitmask = parsed.modifiers.reduce((acc, mod) => acc | mod.bit, 0);
    for (const mod of [...parsed.modifiers].reverse()) {
      bitmask &= ~mod.bit;
      await this.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: mod.name, code: mod.code, windowsVirtualKeyCode: mod.keyCode, modifiers: bitmask,
      });
    }
  }

  async pressKey(tabId, combo) {
    await this.ensure(tabId);
    const parsed = parseKeyCombo(combo);
    await this.keyDown(tabId, parsed);
    await this.keyUp(tabId, parsed);
    return { pressed: combo, method: 'keyboard' };
  }

  async holdKey(tabId, combo, durationMs) {
    await this.ensure(tabId);
    const parsed = parseKeyCombo(combo);
    await this.keyDown(tabId, parsed);
    try {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    } finally {
      await this.keyUp(tabId, parsed);
    }
    return { held: combo, durationMs };
  }

  /**
   * Evaluates an expression (top-level await allowed). A function result is called, and a promise
   * result is awaited, because replMode only awaits explicit top-level `await`.
   */
  async evaluate(tabId, script) {
    await this.ensure(tabId);
    const objectGroup = 'mcp-evaluate';
    try {
      let remote = checkEvaluation(
        await this.send(tabId, 'Runtime.evaluate', {
          expression: script,
          awaitPromise: true,
          returnByValue: false,
          userGesture: true,
          replMode: true,
          objectGroup,
        }),
      );
      if (remote.type === 'function') {
        remote = checkEvaluation(
          await this.send(tabId, 'Runtime.callFunctionOn', {
            objectId: remote.objectId,
            functionDeclaration: 'function () { return this(); }',
            awaitPromise: true,
            returnByValue: false,
            userGesture: true,
            objectGroup,
          }),
        );
      }
      if (remote.subtype === 'promise') {
        remote = checkEvaluation(
          await this.send(tabId, 'Runtime.awaitPromise', { promiseObjectId: remote.objectId, returnByValue: false }),
        );
      }
      return { result: await this.remoteValue(tabId, remote, objectGroup) };
    } finally {
      await this.send(tabId, 'Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
    }
  }

  async remoteValue(tabId, remote, objectGroup) {
    if ('value' in remote) return remote.value;
    if (remote.unserializableValue) return remote.unserializableValue;
    if (remote.type === 'undefined') return undefined;
    if (!remote.objectId || remote.subtype === 'node' || remote.type === 'symbol') {
      return remote.description ?? null;
    }
    const serialized = await this.send(tabId, 'Runtime.callFunctionOn', {
      objectId: remote.objectId,
      functionDeclaration: 'function () { return this; }',
      returnByValue: true,
      objectGroup,
    }).catch(() => null);
    if (!serialized || serialized.exceptionDetails) return remote.description ?? null;
    return serialized.result?.value ?? remote.description ?? null;
  }

  async uploadFiles(tabId, selector, paths) {
    await this.ensure(tabId);
    const { result } = await this.send(tabId, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    if (!result?.objectId) {
      throw new Error('File input not found for upload');
    }
    await this.send(tabId, 'DOM.setFileInputFiles', { files: paths, objectId: result.objectId });
    return { uploaded: paths.length };
  }

  async screenshot(tabId, { format = 'png', quality, clip, fullPage } = {}) {
    await this.ensure(tabId);
    const params = { format, captureBeyondViewport: Boolean(fullPage || clip) };
    if (quality != null && format !== 'png') params.quality = Number(quality);
    if (fullPage) {
      const metrics = await this.send(tabId, 'Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 16_384), scale: 1 };
    } else if (clip) {
      params.clip = { ...clip, scale: 1 };
    }
    const { data } = await withTimeout(
      this.send(tabId, 'Page.captureScreenshot', params),
      8000,
      'CDP screenshot timed out (tab may be throttled in the background)',
    );
    return { data, mimeType: `image/${format}` };
  }

  /**
   * Captures the viewport (or a viewport-pixel region of it) with the image measured in CSS pixels,
   * so coordinates read off the image map 1:1 onto mouse events. `maxEdge` caps the longer side.
   */
  async viewportShot(tabId, { region, maxEdge = 1568, upscale = 1, format = 'png', quality } = {}) {
    await this.ensure(tabId);
    const metrics = await this.send(tabId, 'Page.getLayoutMetrics');
    const vv = metrics.cssVisualViewport || metrics.visualViewport;
    const dprResponse = await this.send(tabId, 'Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
    const dpr = Number(dprResponse.result?.value) || 1;
    const viewportWidth = Math.round(vv.clientWidth);
    const viewportHeight = Math.round(vv.clientHeight);
    let x = 0;
    let y = 0;
    let width = viewportWidth;
    let height = viewportHeight;
    if (region) {
      x = Math.max(0, Math.min(region[0], region[2]));
      y = Math.max(0, Math.min(region[1], region[3]));
      width = Math.min(viewportWidth, Math.max(region[0], region[2])) - x;
      height = Math.min(viewportHeight, Math.max(region[1], region[3])) - y;
      if (width < 1 || height < 1) {
        throw new Error(`Zoom region ${JSON.stringify(region)} is outside the ${viewportWidth}x${viewportHeight} viewport`);
      }
    }
    const scale = Math.min(Math.max(1, upscale), maxEdge / Math.max(width, height));
    const params = {
      format,
      captureBeyondViewport: false,
      clip: { x: vv.pageX + x, y: vv.pageY + y, width, height, scale: scale / dpr },
    };
    if (quality != null && format !== 'png') params.quality = Number(quality);
    const { data } = await withTimeout(
      this.send(tabId, 'Page.captureScreenshot', params),
      8000,
      'CDP screenshot timed out (tab may be throttled in the background)',
    );
    return {
      data,
      mimeType: `image/${format}`,
      viewport: { width: viewportWidth, height: viewportHeight },
      image: { width: Math.round(width * scale), height: Math.round(height * scale) },
      scale,
    };
  }

  async emulate(tabId, options = {}) {
    await this.ensure(tabId);
    const applied = {};
    if (options.reset) {
      await this.send(tabId, 'Emulation.clearDeviceMetricsOverride');
      await this.send(tabId, 'Emulation.setEmulatedMedia', { features: [] });
      await this.send(tabId, 'Emulation.setCPUThrottlingRate', { rate: 1 });
      await this.send(tabId, 'Network.emulateNetworkConditions', NETWORK_PRESETS.none);
      await this.send(tabId, 'Emulation.clearGeolocationOverride');
      await this.send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      applied.reset = true;
    }
    if (options.viewport === null) {
      await this.send(tabId, 'Emulation.clearDeviceMetricsOverride');
      await this.send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      applied.viewport = 'cleared';
    } else if (options.viewport) {
      const v = options.viewport;
      await this.send(tabId, 'Emulation.setDeviceMetricsOverride', {
        width: v.width,
        height: v.height,
        deviceScaleFactor: v.deviceScaleFactor ?? (v.mobile ? 3 : 1),
        mobile: Boolean(v.mobile),
      });
      await this.send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: Boolean(v.mobile) });
      applied.viewport = v;
    }
    if (options.colorScheme) {
      await this.send(tabId, 'Emulation.setEmulatedMedia', {
        features: options.colorScheme === 'auto' ? [] : [{ name: 'prefers-color-scheme', value: options.colorScheme }],
      });
      applied.colorScheme = options.colorScheme;
    }
    if (options.userAgent != null) {
      await this.send(tabId, 'Emulation.setUserAgentOverride', { userAgent: options.userAgent });
      applied.userAgent = options.userAgent || 'cleared';
    }
    if (options.network) {
      const preset = NETWORK_PRESETS[options.network];
      if (!preset) throw new Error(`Unknown network preset ${options.network}`);
      await this.send(tabId, 'Network.emulateNetworkConditions', preset);
      applied.network = options.network;
    }
    if (options.cpuThrottlingRate != null) {
      await this.send(tabId, 'Emulation.setCPUThrottlingRate', { rate: Number(options.cpuThrottlingRate) });
      applied.cpuThrottlingRate = options.cpuThrottlingRate;
    }
    if (options.geolocation === null) {
      await this.send(tabId, 'Emulation.clearGeolocationOverride');
      applied.geolocation = 'cleared';
    } else if (options.geolocation) {
      await this.send(tabId, 'Emulation.setGeolocationOverride', {
        latitude: options.geolocation.latitude,
        longitude: options.geolocation.longitude,
        accuracy: options.geolocation.accuracy ?? 50,
      });
      applied.geolocation = options.geolocation;
    }
    return { applied };
  }

  async performanceMetrics(tabId) {
    await this.ensure(tabId);
    await this.send(tabId, 'Performance.enable');
    const { metrics } = await this.send(tabId, 'Performance.getMetrics');
    const runtime = Object.fromEntries((metrics || []).map((m) => [m.name, m.value]));
    const vitals = await this.evaluate(
      tabId,
      `async () => {
        const nav = performance.getEntriesByType('navigation')[0];
        const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
        const observe = (type) => new Promise((resolve) => {
          const entries = [];
          try {
            const po = new PerformanceObserver((list) => entries.push(...list.getEntries()));
            po.observe({ type, buffered: true });
            setTimeout(() => { po.disconnect(); resolve(entries); }, 150);
          } catch { resolve(entries); }
        });
        const [lcp, shifts] = await Promise.all([observe('largest-contentful-paint'), observe('layout-shift')]);
        const cls = shifts.filter((s) => !s.hadRecentInput).reduce((sum, s) => sum + s.value, 0);
        return {
          url: location.href,
          ttfbMs: nav ? Math.round(nav.responseStart) : null,
          domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
          loadMs: nav ? Math.round(nav.loadEventEnd) : null,
          firstContentfulPaintMs: paint['first-contentful-paint'] ?? null,
          largestContentfulPaintMs: lcp.length ? Math.round(lcp[lcp.length - 1].startTime) : null,
          cumulativeLayoutShift: Number(cls.toFixed(4)),
          transferSizeBytes: nav ? nav.transferSize : null,
          resourceCount: performance.getEntriesByType('resource').length,
        };
      }`,
    );
    return {
      vitals: vitals.result,
      runtime: {
        jsHeapUsedMB: runtime.JSHeapUsedSize ? Number((runtime.JSHeapUsedSize / 1_048_576).toFixed(2)) : undefined,
        jsHeapTotalMB: runtime.JSHeapTotalSize ? Number((runtime.JSHeapTotalSize / 1_048_576).toFixed(2)) : undefined,
        nodes: runtime.Nodes,
        documents: runtime.Documents,
        jsEventListeners: runtime.JSEventListeners,
        layoutCount: runtime.LayoutCount,
        recalcStyleCount: runtime.RecalcStyleCount,
        scriptDurationMs: runtime.ScriptDuration ? Math.round(runtime.ScriptDuration * 1000) : undefined,
        taskDurationMs: runtime.TaskDuration ? Math.round(runtime.TaskDuration * 1000) : undefined,
      },
    };
  }
}
