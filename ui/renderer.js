const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const saveButton = document.getElementById('saveConfig');
const reloadButton = document.getElementById('reloadConfig');
const validateButton = document.getElementById('validateConfig');
const connectChromeButton = document.getElementById('connectChrome');
const statusBadge = document.getElementById('status');
const chromeStatusText = document.getElementById('chromeStatusText');
const configPathText = document.getElementById('configPath');
const configEditor = document.getElementById('configEditor');
const logBox = document.getElementById('logBox');

function appendLog(line) {
  const current = logBox.textContent || '';
  const next = `${current}${line.endsWith('\n') ? line : `${line}\n`}`;
  logBox.textContent = next;
  logBox.scrollTop = logBox.scrollHeight;
}

function setRunning(isRunning) {
  statusBadge.textContent = isRunning ? 'Running' : 'Stopped';
  statusBadge.className = isRunning ? 'badge running' : 'badge stopped';
  startButton.disabled = isRunning;
  stopButton.disabled = !isRunning;
}

function setChromeConnected(connected, message) {
  connectChromeButton.classList.remove('success', 'danger');
  connectChromeButton.classList.add(connected ? 'success' : 'danger');
  chromeStatusText.textContent = connected ? 'Connected' : 'Disconnected';
  if (message) {
    appendLog(`[ui] ${message}`);
  }
}

async function loadConfig() {
  try {
    const content = await window.ivacApi.readConfig();
    configEditor.value = content;
  } catch (err) {
    appendLog(`[ui] Failed to read config: ${err.message}`);
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
}

startButton.addEventListener('click', async () => {
  try {
    await window.ivacApi.saveConfig(configEditor.value);
    const result = await window.ivacApi.start();
    setRunning(!!result.running);
    appendLog('[ui] Start requested');
  } catch (err) {
    appendLog(`[ui] Start failed: ${err.message}`);
  }
});

stopButton.addEventListener('click', async () => {
  try {
    await window.ivacApi.stop();
    setRunning(false);
    appendLog('[ui] Stop requested');
  } catch (err) {
    appendLog(`[ui] Stop failed: ${err.message}`);
  }
});

saveButton.addEventListener('click', async () => {
  try {
    await window.ivacApi.saveConfig(configEditor.value);
    appendLog('[ui] Config saved');
  } catch (err) {
    appendLog(`[ui] Config save failed: ${err.message}`);
  }
});

reloadButton.addEventListener('click', async () => {
  await loadConfig();
  appendLog('[ui] Config reloaded from disk');
});

validateButton.addEventListener('click', async () => {
  try {
    const result = await window.ivacApi.validateConfig(configEditor.value);
    if (result.ok) {
      appendLog('[ui] Config validation passed');
      return;
    }

    appendLog(`[ui] Config validation failed: ${result.issues.join(' | ')}`);
  } catch (err) {
    appendLog(`[ui] Config validation failed: ${err.message}`);
  }
});

connectChromeButton.addEventListener('click', async () => {
  try {
    const result = await window.ivacApi.connectChrome(configEditor.value);
    setChromeConnected(!!result.connected, result.message || null);
  } catch (err) {
    setChromeConnected(false, err.message || 'Chrome connection check failed');
  }
});

init().catch((err) => {
  appendLog(`[ui] Initialization failed: ${err.message}`);
});
