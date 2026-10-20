import { executeCommand } from './lib/commands.js';

const DEFAULT_SETTINGS = {
  bridgeUrl: 'ws://127.0.0.1:12307/bridge',
  token: '',
};
const RECONNECT_DELAY_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 20_000;
// Host closes an older bridge socket with this code when a newer browser connects.
const REPLACED_CLOSE_CODE = 4001;

let socket = null;
let connecting = false;
let lastError = '';
let shouldReconnect = false;
let reconnectTimer = null;
let keepaliveTimer = null;

chrome.runtime.onInstalled.addListener(() => void maybeAutoConnect());
chrome.runtime.onStartup.addListener(() => void maybeAutoConnect());
void maybeAutoConnect();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message?.type === 'get_status') {
        sendResponse({ connected: isOpen(), connecting, lastError });
        return;
      }
      if (message?.type === 'connect') {
        await chrome.storage.local.set({ settings: message.settings || DEFAULT_SETTINGS, autoConnect: true });
        await connect(message.settings);
        sendResponse({ ok: isOpen(), error: lastError || undefined });
        return;
      }
      if (message?.type === 'disconnect') {
        await chrome.storage.local.set({ autoConnect: false });
        disconnect();
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: 'Unknown message' });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});

async function maybeAutoConnect() {
  const { settings, autoConnect } = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS,
    autoConnect: true,
  });
  if (autoConnect) {
    await connect(settings);
  }
}

function isOpen() {
  return socket != null && socket.readyState === WebSocket.OPEN;
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  reconnectTimer = null;
  keepaliveTimer = null;
}

function disconnect() {
  shouldReconnect = false;
  clearTimers();
  socket?.close();
  socket = null;
}

async function connect(settingsOverride) {
  // Flag before any await so concurrent startup triggers cannot open two sockets.
  if (isOpen() || connecting) return;
  connecting = true;
  clearTimers();
  lastError = '';
  shouldReconnect = true;

  let url;
  try {
    const { settings } = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
    const cfg = settingsOverride || settings || DEFAULT_SETTINGS;
    url = new URL(cfg.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl);
    if (cfg.token) url.searchParams.set('token', cfg.token);
  } catch (error) {
    connecting = false;
    lastError = `Invalid bridge URL: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }

  await new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url.toString());
    } catch (error) {
      connecting = false;
      lastError = error instanceof Error ? error.message : String(error);
      scheduleReconnect();
      resolve();
      return;
    }
    socket = ws;

    ws.addEventListener('open', () => {
      connecting = false;
      lastError = '';
      ws.send(JSON.stringify({ type: 'event', event: 'extension_ready', payload: { version: chrome.runtime.getManifest().version } }));
      // Regular traffic keeps the MV3 service worker alive while the bridge is connected.
      keepaliveTimer = setInterval(() => send({ type: 'event', event: 'heartbeat' }), KEEPALIVE_INTERVAL_MS);
      resolve();
    });
    ws.addEventListener('message', (event) => void handleHostMessage(String(event.data)));
    ws.addEventListener('close', (event) => {
      connecting = false;
      if (socket !== ws) {
        resolve();
        return;
      }
      socket = null;
      if (event.reason) lastError = event.reason;
      if (event.code === REPLACED_CLOSE_CODE || event.code === 1008) {
        shouldReconnect = false;
      }
      if (shouldReconnect) scheduleReconnect();
      resolve();
    });
    ws.addEventListener('error', () => {
      lastError = 'Cannot reach the host. Connect an MCP client, or run npm start.';
    });
  });
}

function scheduleReconnect() {
  clearTimers();
  reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
}

function send(message) {
  if (isOpen()) socket.send(JSON.stringify(message));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  send({ type: 'event', event: 'tab_removed', payload: { tabId } });
});

function sendTabCreated(tabId, openerTabId, url) {
  send({ type: 'event', event: 'tab_created', payload: { tabId, openerTabId, url: url || '' } });
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null || tab.id == null) return;
  sendTabCreated(tab.id, tab.openerTabId, tab.pendingUrl || tab.url);
});

// Also fires for target=_blank links, which are noopener and carry no openerTabId.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  sendTabCreated(details.tabId, details.sourceTabId, details.url);
});

function sendDownload(item) {
  send({
    type: 'event',
    event: 'download',
    payload: {
      id: item.id,
      state: item.state,
      url: item.finalUrl || item.url || '',
      referrer: item.referrer || '',
      filename: item.filename || '',
      fileSize: item.fileSize >= 0 ? item.fileSize : undefined,
      error: item.error || undefined,
    },
  });
}

chrome.downloads.onCreated.addListener((item) => sendDownload(item));
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state && !delta.error) return;
  void chrome.downloads.search({ id: delta.id }).then(([item]) => {
    if (item) sendDownload(item);
  });
});

async function handleHostMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message?.type !== 'command' || !message.id) return;

  try {
    const result = await executeCommand(message.command, message.args || {}, message.tabId);
    send({ id: message.id, type: 'result', ok: true, result });
  } catch (error) {
    send({ id: message.id, type: 'error', ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
