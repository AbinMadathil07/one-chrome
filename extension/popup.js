const statusEl = document.getElementById('status');
const bridgeUrlEl = document.getElementById('bridgeUrl');
const tokenEl = document.getElementById('token');
const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');

function setStatus(state, text) {
  statusEl.className = `status ${state}`;
  statusEl.textContent = text;
}

async function refresh() {
  const [{ settings }, status] = await Promise.all([
    chrome.storage.local.get({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:12307/bridge',
        token: '',
      },
    }),
    chrome.runtime.sendMessage({ type: 'get_status' }),
  ]);

  bridgeUrlEl.value = settings.bridgeUrl;
  tokenEl.value = settings.token || '';

  if (status?.connected) {
    setStatus('connected', 'Connected to host');
  } else if (status?.connecting) {
    setStatus('connecting', 'Connecting…');
  } else {
    setStatus('disconnected', status?.lastError ? `Disconnected: ${status.lastError}` : 'Disconnected');
  }
}

connectBtn.addEventListener('click', async () => {
  const settings = {
    bridgeUrl: bridgeUrlEl.value.trim(),
    token: tokenEl.value.trim(),
  };
  await chrome.storage.local.set({ settings });
  setStatus('connecting', 'Connecting…');
  const result = await chrome.runtime.sendMessage({ type: 'connect', settings });
  if (result?.ok) {
    setStatus('connected', 'Connected to host');
  } else {
    setStatus('disconnected', `Failed: ${result?.error || 'unknown error'}`);
  }
});

disconnectBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  setStatus('disconnected', 'Disconnected');
});

refresh();
