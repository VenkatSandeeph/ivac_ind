const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const panelStart = document.getElementById('panelStart');
const panelStop = document.getElementById('panelStop');
const reloadButton = document.getElementById('reloadConfig');
const connectChromeButton = document.getElementById('connectChrome');
const statusBadge = document.getElementById('status');
const chromeStatusText = document.getElementById('chromeStatusText');
const configPathText = document.getElementById('configPath');
const configUser = document.getElementById('configUser');
const retryTimeInput = document.getElementById('retryTime');
const logBox = document.getElementById('logBox');
const clearLogsButton = document.getElementById('clearLogs');

function appendLog(line) {
  const current = logBox.textContent || '';
  const next = `${current}${line.endsWith('\n') ? line : `${line}\n`}`;
  logBox.textContent = next;
  logBox.scrollTop = logBox.scrollHeight;
}

function setRunning(isRunning) {
  if (statusBadge) {
    statusBadge.textContent = isRunning ? 'Running' : 'Stopped';
    statusBadge.className = isRunning ? 'badge running' : 'badge stopped';
  }
  if (startButton) startButton.disabled = isRunning;
  if (stopButton) stopButton.disabled = !isRunning;
}

function setChromeConnected(connected, message) {
  if (connectChromeButton) {
    connectChromeButton.classList.remove('success', 'danger');
    connectChromeButton.classList.add(connected ? 'success' : 'danger');
  }
  if (chromeStatusText) chromeStatusText.textContent = connected ? 'Connected' : 'Disconnected';
  // Only log Chrome status messages when a successful connection is made.
  if (connected && message) {
    appendLog(`[ui] ${message}`);
  }
}

if (clearLogsButton) {
  clearLogsButton.addEventListener('click', () => {
    if (logBox) {
      logBox.textContent = '';
    }
  });
}

async function loadConfig() {
  try {
    const content = await window.ivacApi.readConfig();
    const parsed = JSON.parse(content || '{}');

    // Username display
    const username = String(parsed.username || 'Unknown');
    if (configUser) {
      configUser.textContent = username;
      // Build tooltip showing appointment values
      const appt = parsed.appointment || {};
      try {
        const parts = [];
        for (const [k, v] of Object.entries(appt)) {
          parts.push(`${k}: ${Array.isArray(v) ? JSON.stringify(v) : String(v)}`);
        }
        configUser.title = parts.join('\n') || 'No appointment configured';
        const apptDiv = document.getElementById('appointmentDetails');
        if (apptDiv) {
          // Render appointment details as lines
          apptDiv.innerHTML = parts.map((p) => `<div>${p}</div>`).join('');
        }
      } catch (_e) {
        configUser.title = 'No appointment configured';
      }
    }

    const secs = parsed.cityRetrySeconds ?? (parsed.cityRetrySeconds === 0 ? 0 : null);
    retryTimeInput.value = secs !== null && secs !== undefined ? String(secs) : '10';
  } catch (err) {
    appendLog(`[ui] Failed to read config: ${err.message}`);
    retryTimeInput.value = '10';
    if (configUser) configUser.textContent = 'Unknown';
  }
}

async function init() {
  const configPath = await window.ivacApi.getConfigPath();
  configPathText.textContent = configPath;

  await loadConfig();

  const status = await window.ivacApi.status();
  setRunning(!!status.running);
  setChromeConnected(false, null);

  window.ivacApi.onLog((message) => {
    appendLog(message);
  });

  window.ivacApi.onStatus((statusPayload) => {
    setRunning(!!statusPayload.running);
  });
  window.ivacApi.onChromeStatus((statusPayload) => {
    try {
      setChromeConnected(!!statusPayload.connected, statusPayload.message || null);
    } catch (e) {
      // ignore
    }
  });
}
if (startButton) {
  startButton.addEventListener('click', async () => {
    try {
      const result = await window.ivacApi.start();
      setRunning(!!result.running);
      appendLog('[ui] Start requested');
    } catch (err) {
      appendLog(`[ui] Start failed: ${err.message}`);
    }
  });
}

if (panelStart) {
  panelStart.addEventListener('click', async () => {
    try {
      const result = await window.ivacApi.start();
      setRunning(!!result.running);
      appendLog('[ui] Start requested (panel)');
    } catch (err) {
      appendLog(`[ui] Start failed: ${err.message}`);
    }
  });
}

if (stopButton) {
  stopButton.addEventListener('click', async () => {
    try {
      await window.ivacApi.stop();
      setRunning(false);
      appendLog('[ui] Stop requested');
    } catch (err) {
      appendLog(`[ui] Stop failed: ${err.message}`);
    }
  });
}

if (panelStop) {
  panelStop.addEventListener('click', async () => {
    try {
      await window.ivacApi.stop();
      setRunning(false);
      appendLog('[ui] Stop requested (panel)');
    } catch (err) {
      appendLog(`[ui] Stop failed: ${err.message}`);
    }
  });
}

if (reloadButton) {
  reloadButton.addEventListener('click', async () => {
    await loadConfig();
    appendLog('[ui] Config reloaded from disk');
  });
}

if (connectChromeButton) {
  connectChromeButton.addEventListener('click', async () => {
    try {
      const content = await window.ivacApi.readConfig();
      const result = await window.ivacApi.connectChrome(content);
      setChromeConnected(!!result.connected, result.message || null);
    } catch (err) {
      setChromeConnected(false, err.message || 'Chrome connection check failed');
    }
  });
}

init().catch((err) => {
  appendLog(`[ui] Initialization failed: ${err.message}`);
});
