/* renderer.js -- Browser-side UI logic for IVAC Launcher (multi-profile) */

// Per-launch API token — main.js injects the real value when serving this
// file; the placeholder never matches, so a stale/unmodified file fails closed.
const IVAC_API_TOKEN = '__IVAC_API_TOKEN__';
const _ivacFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('/api/')) {
    init = init || {};
    init.headers = Object.assign({}, init.headers, { 'x-ivac-token': IVAC_API_TOKEN });
  }
  return _ivacFetch(input, init);
};

let appState = {
  licensed: false,
  clientName: '',
  profiles: [],
  selectedProfileId: null,
  settings: {},
  lastMeta: null,
  modalOpen: false
};

// ---- Debug logging ----
const debugEnabled = true;
function debugLog(msg) {
  if (!debugEnabled) return;
  const el = document.getElementById('debugLog');
  if (el) {
    const ts = new Date().toLocaleTimeString();
    el.textContent += '[' + ts + '] ' + msg + '\n';
    el.scrollTop = el.scrollHeight;
  }
  console.log('[debug]', msg);
}

const questionGroups = [
  [
    "What is your mother's maiden name?",
    "What was the name of your first/current/favorite pet?",
    "What was your first car?",
    "What elementary school did you attend?",
    "What is the name of the town/city where you were born?"
  ],
  [
    "What is the name of the road/street you grew up on?",
    "What is your least favorite food?",
    "What was the first company that you worked for?",
    "What is your favorite food?",
    "What high school did you attend?"
  ],
  [
    "Where did you meet your spouse?",
    "What is your sibling's middle name?",
    "Who was your childhood hero?",
    "In what city or town was your first job?",
    "What is the name of a college you applied to but didn't attend?"
  ]
];

// ---- Custom dialog (replaces alert/confirm to avoid Electron focus issues) ----

function showDialog(message, type, onOk, onCancel) {
  const overlay = document.getElementById('dialogOverlay');
  const msgEl = document.getElementById('dialogMessage');
  const okBtn = document.getElementById('dialogOk');
  const cancelBtn = document.getElementById('dialogCancel');

  if (!overlay || !msgEl || !okBtn || !cancelBtn) {
    // Fallback to native if elements missing
    if (type === 'confirm') {
      if (confirm(message)) { if (onOk) onOk(); }
      else { if (onCancel) onCancel(); }
    } else {
      alert(message);
      if (onOk) onOk();
    }
    return;
  }

  msgEl.textContent = message;
  cancelBtn.style.display = (type === 'confirm') ? '' : 'none';
  okBtn.textContent = (type === 'confirm') ? 'OK' : 'OK';
  overlay.style.display = 'flex';

  okBtn.onclick = null;
  cancelBtn.onclick = null;
  okBtn.onclick = () => {
    overlay.style.display = 'none';
    if (onOk) onOk();
  };
  cancelBtn.onclick = () => {
    overlay.style.display = 'none';
    if (onCancel) onCancel();
  };
}

function showAlert(message, onOk) {
  showDialog(message, 'alert', onOk, null);
}

function showConfirm(message, onOk, onCancel) {
  showDialog(message, 'confirm', onOk, onCancel);
}

// ---- Screen switching ----

function showLicenseScreen() {
  document.getElementById('licenseScreen').style.display = 'flex';
  document.getElementById('dashboardScreen').style.display = 'none';
}

function showDashboard(clientName) {
  document.getElementById('licenseScreen').style.display = 'none';
  document.getElementById('dashboardScreen').style.display = '';
  const badge = document.getElementById('licenseBadge');
  if (badge && clientName) {
    badge.textContent = 'Licensed: ' + clientName;
  }
}

function showLicenseMessage(msg, isError) {
  const el = document.getElementById('licenseMessage');
  if (!el) return;
  el.textContent = msg;
  el.className = 'license-message ' + (isError ? 'error' : 'success');
}

function clearLicenseMessage() {
  const el = document.getElementById('licenseMessage');
  if (!el) return;
  el.textContent = '';
  el.className = 'license-message';
}

// ---- License API ----

async function checkLicenseStatus() {
  try {
    debugLog('checkLicenseStatus: fetching...');
    const res = await fetch('/api/license-status?_=' + Date.now(), { cache: 'no-store' });
    const data = await res.json();
    debugLog('checkLicenseStatus: response=' + JSON.stringify(data));
    if (data.validated) {
      appState.licensed = true;
      appState.clientName = data.clientName;
      showDashboard(data.clientName);
      return true;
    } else if (data.hasStoredKey) {
      showLicenseScreen();
      showLicenseMessage('Stored license is invalid or expired. Please re-enter your key.', true);
      return false;
    } else {
      showLicenseScreen();
      return false;
    }
  } catch (err) {
    console.error('License check failed', err);
    showLicenseScreen();
    return false;
  }
}

async function activateLicense() {
  const input = document.getElementById('licenseKeyInput');
  const btn = document.getElementById('licenseActivateBtn');
  const loading = document.getElementById('licenseLoading');
  const key = input.value.trim();

  if (!key) {
    showLicenseMessage('Please enter a license key.', true);
    return;
  }

  btn.disabled = true;
  loading.style.display = 'block';
  clearLicenseMessage();

  try {
    const res = await fetch('/api/validate-license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();

    if (data.status === 'terminated') {
      showLicenseMessage(data.message, true);
      return;
    }

    if (data.valid) {
      showLicenseMessage(data.message, false);
      setTimeout(() => {
        appState.licensed = true;
        appState.clientName = data.record?.client_name || '';
        showDashboard(appState.clientName);
        loadProfiles();
      }, 800);
    } else {
      showLicenseMessage(data.message, true);
    }
  } catch {
    showLicenseMessage('Could not connect to license server. Check your internet connection.', true);
  } finally {
    btn.disabled = false;
    loading.style.display = 'none';
  }
}

// ---- Profiles ----

function showProfileListError(text) {
  const list = document.getElementById('profileList');
  if (!list) return;
  list.innerHTML = '<p class="muted">' + (text || 'Could not load profiles.') + '</p>';
}

async function loadProfiles() {
  if (!appState.licensed) { debugLog('loadProfiles: skipped (not licensed)'); return; }
  if (appState.modalOpen) { debugLog('loadProfiles: skipped (modal open)'); return; }

  debugLog('loadProfiles: fetching...');
  const list = document.getElementById('profileList');
  if (list && appState.profiles.length === 0) {
    list.innerHTML = '<p class="muted">Loading profiles...</p>';
  }

  try {
    const res = await fetch('/api/profiles?_=' + Date.now(), { cache: 'no-store' });
    if (res.status === 403) { debugLog('loadProfiles: 403'); return; }
    if (!res.ok) throw new Error('Server returned ' + res.status);

    const data = await res.json();
    debugLog('loadProfiles: got ' + (data.profiles?.length || 0) + ' profiles');
    if (!data.ok) throw new Error(data.msg || 'Server error');

    appState.profiles = Array.isArray(data.profiles) ? data.profiles : [];
    appState.settings = data.settings || {};
    appState.lastMeta = data.meta || null;

    // Sync header "Less Slots" checkbox with persisted setting
    const leastChk = document.getElementById('leastSlotsChk');
    if (leastChk && !appState.leastSlotsSaving) {
      leastChk.checked = !!appState.settings.preferLeastSlots;
    }

    // Sync header "Auto IP" checkbox (defaults to on when unset)
    const ipModeSel = document.getElementById('ipModeSel');
    if (ipModeSel && !appState.ipModeSaving) {
      ipModeSel.value = appState.settings.ipMode ||
        (appState.settings.autoRotateIp === false ? 'none' : 'auto');
    }

    // Sync header "Special Window" checkbox with persisted setting
    const swChk = document.getElementById('specialWindowChk');
    if (swChk && !appState.specialWindowSaving) {
      swChk.checked = !!appState.settings.specialWindowOnly;
    }

    // EXPERIMENTAL: avoidEarliestDate — sync header "2nd Date" checkbox
    const sdChk = document.getElementById('secondDateChk');
    if (sdChk && !appState.secondDateSaving) {
      sdChk.checked = !!appState.settings.avoidEarliestDate;
    }

    if (appState.profiles.length > 0 && !appState.selectedProfileId) {
      appState.selectedProfileId = appState.profiles[0].id;
    }

    renderProfiles();
    renderEditList();

    const selected = appState.profiles.find((p) => p.id === appState.selectedProfileId);
    const nameEl = document.getElementById('logProfileName');
    if (nameEl) nameEl.textContent = selected ? ' - ' + selected.username : '';
    pollLogs();
  } catch (err) {
    console.error('loadProfiles error', err);
    showProfileListError('Could not load profiles: ' + (err.message || 'server error'));
  }
}

function renderProfiles() {
  const list = document.getElementById('profileList');
  if (!list) return;

  if (appState.profiles.length === 0) {
    let msg = 'No profiles. Click "Add Profile" to create one.';
    if (appState.lastMeta) {
      msg += '<br><small style="color:#888">Config: ' + appState.lastMeta.configPath + ' — ' + appState.lastMeta.profileCount + ' profile(s)</small>';
    }
    list.innerHTML = '<p class="muted">' + msg + '</p>';
    return;
  }

  list.innerHTML = appState.profiles.map((p) => {
    const a = p.appointment || {};
    const cities = Array.isArray(a.city) && a.city.length > 0
      ? a.city.join(', ')
      : (typeof a.city === 'string' ? a.city : 'No city');
    const cons = p.consular || {};
    const consCities = Array.isArray(cons.city) && cons.city.length > 0 ? cons.city.join(', ') : '';
    const consLine = consCities
      ? `Consular: ${consCities}${cons.startDate && cons.endDate ? ` (${cons.startDate} → ${cons.endDate})` : ' (auto range)'}`
      : '';
    const status = p.status || 'Stopped';
    const isRunning = p.running === true;
    const statusClass = isRunning ? 'running' : 'stopped';
    const selected = p.id === appState.selectedProfileId ? ' selected' : '';
    const isSelectedForLogs = p.id === appState.selectedProfileId ? ' (viewing logs)' : '';

    const checkpoints = p.checkpoints || {};
    const chips = Object.keys(checkpoints).length
      ? Object.entries(checkpoints).map(([k, v]) => `<span class="chip ${v ? 'ok' : ''}">${k}</span>`).join('')
      : '';

    return `
      <div class="profile-row${selected}" data-id="${p.id}">
        <div class="profile-info" onclick="window.selectProfile('${p.id}')">
          <div class="profile-user">${p.username || 'Unknown'}${isSelectedForLogs}</div>
          <div class="profile-detail">${cities}</div>
          <div class="profile-range">${a.startDate || ''} &rarr; ${a.endDate || ''}</div>
          ${p.visaType ? `<div class="profile-range" style="color:#8fb98f">visatype: ${p.visaType}</div>` : ''}
          ${consLine ? `<div class="profile-range" style="color:#7ea2c9">${consLine}</div>` : ''}
          <div class="profile-status-line">Status: <b>${status}</b></div>
          <div class="profile-checkpoints">${chips}</div>
        </div>
        <div class="profile-status ${statusClass}">${isRunning ? 'Running' : 'Stopped'}</div>
        <div class="profile-actions">
          <button class="small" onclick="event.stopPropagation(); window.editProfile('${p.id}')">Edit</button>
          <button class="small primary" onclick="event.stopPropagation(); window.startProfile('${p.id}')" ${isRunning ? 'disabled' : ''}>Start</button>
          <button class="small" onclick="event.stopPropagation(); window.connectChrome('${p.id}')">Connect</button>
          <button class="small" onclick="event.stopPropagation(); window.showChrome('${p.id}')" ${!p.chromeConnected ? 'disabled' : ''}>Show</button>
          <button class="small danger" onclick="event.stopPropagation(); window.stopProfile('${p.id}')" ${!isRunning ? 'disabled' : ''}>Stop</button>
        </div>
      </div>
    `;
  }).join('');
}

function selectProfile(id) {
  appState.selectedProfileId = id;
  const profile = appState.profiles.find((p) => p.id === id);
  const nameEl = document.getElementById('logProfileName');
  if (nameEl) nameEl.textContent = profile ? ' - ' + profile.username : '';
  lastLogLength = -1; // force refresh
  renderProfiles();
  pollLogs();
}

// ---- Log polling ----

let lastLogLength = -1;

async function pollLogs() {
  if (!appState.licensed || !appState.selectedProfileId) return;
  try {
    const res = await fetch('/api/profiles/' + appState.selectedProfileId + '/logs', { method: 'POST' });
    if (res.status === 403) return;
    const data = await res.json();
    const box = document.getElementById('logBox');
    if (!box) return;
    const text = data.logs || '';
    if (text.length !== lastLogLength || lastLogLength === -1) {
      box.textContent = text;
      box.scrollTop = box.scrollHeight;
      lastLogLength = text.length;
    }
    // Also update the status of the selected profile in the UI
    if (data.status) {
      const profile = appState.profiles.find((p) => p.id === appState.selectedProfileId);
      if (profile && profile.status !== data.status) {
        profile.status = data.status;
        renderProfiles();
      }
    }
  } catch {}
}

async function apiSaveLogs() {
  if (!appState.selectedProfileId) return;
  try {
    const res = await fetch('/api/profiles/' + appState.selectedProfileId + '/save-logs', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showAlert('Logs saved:\n' + data.fileName + '\n\n' + data.path);
    } else {
      showAlert(data.msg || 'Could not save logs');
    }
  } catch (e) {
    showAlert('Could not save logs: ' + (e.message || 'server error'));
  }
}

async function apiClearLogs() {
  if (!appState.selectedProfileId) return;
  try {
    await fetch('/api/profiles/clear-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: appState.selectedProfileId })
    });
    const box = document.getElementById('logBox');
    if (box) box.textContent = '';
    lastLogLength = 0;
  } catch {}
}

// ---- Profile actions ----

async function startProfile(id) {
  const profile = appState.profiles.find((p) => p.id === id);
  if (!profile) { debugLog('startProfile: profile not found'); return; }
  debugLog('startProfile: starting ' + profile.username);

  try {
    const res = await fetch('/api/profiles/' + id + '/start', { method: 'POST' });
    const data = await res.json();
    debugLog('startProfile: response=' + JSON.stringify(data));
    if (!data.ok) {
      showAlert(data.msg || 'Start failed');
    }
  } catch (err) {
    debugLog('startProfile error: ' + err.message);
    showAlert('Server error while starting.');
  }
  setTimeout(loadProfiles, 500);
}

async function stopProfile(id) {
  try {
    await fetch('/api/profiles/' + id + '/stop', { method: 'POST' });
  } catch {}
  setTimeout(loadProfiles, 500);
}

async function connectChrome(id) {
  try {
    const res = await fetch('/api/profiles/' + id + '/connect-chrome', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) showAlert(data.msg || 'Connect failed');
    await loadProfiles();
  } catch {
    showAlert('Server error while connecting.');
  }
}

// Bring the profile's Chrome window to the foreground (un-minimize + focus).
async function showChrome(id) {
  try {
    const res = await fetch('/api/profiles/' + id + '/show', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) showAlert(data.msg || 'Show failed');
  } catch {
    showAlert('Server error while showing window.');
  }
}

// ---- NordVPN IP rotation (global, machine-wide) ----

async function rotateIP() {
  const btn = document.getElementById('rotateIpBtn');
  const sub = document.getElementById('currentIpDisplay');
  if (btn) btn.disabled = true;
  if (sub) sub.textContent = 'Rotating...';
  try {
    const res = await fetch('/api/rotate-ip', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      if (sub) sub.textContent = 'Failed';
      showAlert(data.msg || 'Rotate IP failed');
      if (btn) btn.disabled = false;
      return;
    }
    if (sub) sub.textContent = data.ip || 'Queued';
    if (btn) btn.disabled = false;
  } catch {
    if (sub) sub.textContent = 'Failed';
    if (btn) btn.disabled = false;
  }
}

async function fetchCurrentIP() {
  const sub = document.getElementById('currentIpDisplay');
  if (!sub) return;
  try {
    const res = await fetch('/api/current-ip', { method: 'GET' });
    const data = await res.json();
    if (data.ok && data.ip) {
      sub.textContent = data.ip;
    } else {
      sub.textContent = '—';
    }
  } catch {
    sub.textContent = '—';
  }
}

// ---- Add/Edit Modal ----

function openModal(profile) {
  appState.modalOpen = true;
  const modal = document.getElementById('profileModal');
  const title = document.getElementById('modalTitle');
  const deleteBtn = document.getElementById('deleteProfile');

  modal.style.display = 'block';

  if (profile) {
    title.textContent = 'Edit Profile';
    deleteBtn.style.display = '';
    document.getElementById('pId').value = profile.id || '';
    document.getElementById('pInstanceIndex').value = profile.instanceIndex || '';
    document.getElementById('pUsername').value = profile.username || '';
    document.getElementById('pPassword').value = profile.password || '';
    document.getElementById('pVisaType').value = profile.visaType || '';
    fillSecurityQuestions(profile.securityQuestions || []);

    const a = profile.appointment || {};
    const cities = Array.isArray(a.city) ? a.city : (a.city ? [a.city] : []);
    document.querySelectorAll('.city-checks input').forEach((cb) => {
      cb.checked = cities.includes(cb.value);
    });
    document.getElementById('pStartDate').value = a.startDate || '';
    document.getElementById('pEndDate').value = a.endDate || '';
    document.getElementById('pPreferredTime').value = a.preferredTime || '';
    document.getElementById('pCityRetrySeconds').value = profile.cityRetrySeconds ?? 30;
    const cons = profile.consular || {};
    const consCities = Array.isArray(cons.city) ? cons.city : (cons.city ? [cons.city] : []);
    document.querySelectorAll('.consular-city-checks input').forEach((cb) => {
      cb.checked = consCities.includes(cb.value);
    });
    document.getElementById('pConsularStartDate').value = cons.startDate || '';
    document.getElementById('pConsularEndDate').value = cons.endDate || '';
    document.getElementById('pConsularCityRetry').value = cons.cityRetrySeconds ?? 15;
    document.getElementById('pDebugPort').value = profile.chromeRemoteDebugPort || 9222;
    document.getElementById('pUserDataDir').value = profile.chromeUserDataDir || '';
  } else {
    title.textContent = 'Add Profile';
    deleteBtn.style.display = 'none';
    document.getElementById('pId').value = '';
    document.getElementById('pInstanceIndex').value = '';
    document.getElementById('pUsername').value = '';
    document.getElementById('pPassword').value = '';
    document.getElementById('pVisaType').value = '';
    fillSecurityQuestions([]);
    document.querySelectorAll('.city-checks input').forEach((cb) => cb.checked = false);
    document.querySelectorAll('.consular-city-checks input').forEach((cb) => cb.checked = false);
    document.getElementById('pStartDate').value = '';
    document.getElementById('pEndDate').value = '';
    document.getElementById('pPreferredTime').value = '';
    document.getElementById('pCityRetrySeconds').value = 30;
    document.getElementById('pConsularStartDate').value = '';
    document.getElementById('pConsularEndDate').value = '';
    document.getElementById('pConsularCityRetry').value = 15;
    document.getElementById('pDebugPort').value = 9222;
    document.getElementById('pUserDataDir').value = '';
  }

  // Focus the first input
  setTimeout(() => {
    const firstInput = document.getElementById('pUsername');
    if (firstInput) firstInput.focus();
  }, 50);
}

function closeModal() {
  appState.modalOpen = false;
  document.getElementById('profileModal').style.display = 'none';
}

function fillSecurityQuestions(existing) {
  const container = document.getElementById('pSecurityQuestions');
  if (!container) return;

  container.innerHTML = questionGroups.map((group, i) => {
    const existingQ = (existing[i] && existing[i].question) || '';
    const existingA = (existing[i] && existing[i].answer) || '';
    const options = group.map((q) => {
      const selected = q === existingQ ? 'selected' : '';
      return `<option value="${q}" ${selected}>${q}</option>`;
    }).join('');
    return `
      <div class="sq-row" data-index="${i}">
        <label>Question ${i + 1}</label>
        <select class="sq-question">${options}</select>
        <input type="text" class="sq-answer" value="${existingA}" placeholder="Answer ${i + 1}" />
      </div>
    `;
  }).join('');
}

function collectSecurityQuestions() {
  const rows = document.querySelectorAll('#pSecurityQuestions .sq-row');
  const qs = [];
  rows.forEach((row) => {
    const q = row.querySelector('.sq-question').value;
    const a = row.querySelector('.sq-answer').value.trim();
    if (q && a) qs.push({ question: q, answer: a });
  });
  return qs;
}

function collectCities() {
  const cities = [];
  document.querySelectorAll('.city-checks input:checked').forEach((cb) => cities.push(cb.value));
  return cities;
}

function collectConsularCities() {
  const cities = [];
  document.querySelectorAll('.consular-city-checks input:checked').forEach((cb) => cities.push(cb.value));
  return cities;
}

function buildProfileFromForm(onDone) {
  let id = document.getElementById('pId').value;
  let instanceIndex = parseInt(document.getElementById('pInstanceIndex').value, 10) || 0;
  const username = document.getElementById('pUsername').value.trim();
  const password = document.getElementById('pPassword').value;

  if (!username || !password) {
    showAlert('Username and password are required.', onDone);
    return;
  }

  const cities = collectCities();
  if (cities.length === 0) {
    showAlert('Select at least one city.', onDone);
    return;
  }

  const startDate = document.getElementById('pStartDate').value;
  const endDate = document.getElementById('pEndDate').value;
  const cr = parseInt(document.getElementById('pCityRetrySeconds').value, 10);
  const cityRetrySeconds = Number.isFinite(cr) && cr > 0 ? cr : 30;

  if (!startDate || !endDate) {
    showAlert('Select start and end dates.', onDone);
    return;
  }

  if (new Date(startDate) > new Date(endDate)) {
    showAlert('Start date must be earlier than or equal to end date.', onDone);
    return;
  }

  const consularCities = collectConsularCities();
  const consularStartDate = document.getElementById('pConsularStartDate').value;
  const consularEndDate = document.getElementById('pConsularEndDate').value;
  const ccr = parseInt(document.getElementById('pConsularCityRetry').value, 10);
  const consular = {
    city: consularCities,
    startDate: consularStartDate,
    endDate: consularEndDate,
    cityRetrySeconds: Number.isFinite(ccr) && ccr > 0 ? ccr : 15
  };

  if (consularStartDate || consularEndDate) {
    if (!consularStartDate || !consularEndDate) {
      showAlert('Set both consular dates, or leave both empty for the auto range.', onDone);
      return;
    }
    if (new Date(consularStartDate) > new Date(consularEndDate)) {
      showAlert('Consular start date must be earlier than or equal to consular end date.', onDone);
      return;
    }
  }

  const securityQuestions = collectSecurityQuestions();
  if (securityQuestions.length < 3) {
    showAlert('Answer all 3 security questions.', onDone);
    return;
  }

  const visaType = document.getElementById('pVisaType').value.trim();

  // Check for existing username — if adding and username matches, switch to update mode
  let existing = appState.profiles.find((p) => p.username === username);
  if (!id && existing) {
    id = existing.id;
    instanceIndex = existing.instanceIndex;
  }

  const debugPort = parseInt(document.getElementById('pDebugPort').value, 10) || 9222;
  const otherProfile = appState.profiles.find((p) => p.id !== id && p.chromeRemoteDebugPort === debugPort);
  if (otherProfile) {
    showConfirm(
      'Debug port ' + debugPort + ' is already used by ' + otherProfile.username + '. Continue anyway?',
      () => {
        // User confirmed — proceed
        finishBuildProfile(id, instanceIndex, username, password, securityQuestions, cities, startDate, endDate, debugPort, cityRetrySeconds, consular, visaType, onDone);
      },
      onDone
    );
    return;
  }

  finishBuildProfile(id, instanceIndex, username, password, securityQuestions, cities, startDate, endDate, debugPort, cityRetrySeconds, consular, visaType, onDone);
}

function finishBuildProfile(id, instanceIndex, username, password, securityQuestions, cities, startDate, endDate, debugPort, cityRetrySeconds, consular, visaType, onDone) {
  const profile = {
    id: id || undefined,
    instanceIndex,
    username,
    password,
    securityQuestions,
    visaType,
    appointment: {
      city: cities,
      startDate,
      endDate,
      preferredTime: document.getElementById('pPreferredTime').value.trim() || null
    },
    consular,
    chromeRemoteDebugPort: debugPort,
    chromeUserDataDir: document.getElementById('pUserDataDir').value.trim(),
    cityRetrySeconds
  };

  onDone(profile);
}

async function saveProfile() {
  buildProfileFromForm(async (profile) => {
    if (!profile) return;

    try {
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: profile.id ? 'update' : 'add', profile })
      });
      const data = await res.json();
      if (!data.ok) {
        showAlert(data.msg || 'Save failed');
        return;
      }
      closeModal();
      await loadProfiles();
    } catch {
      showAlert('Server error while saving.');
    }
  });
}

function deleteProfile() {
  const id = document.getElementById('pId').value;
  if (!id) return;
  performDelete(id);
}

function performDelete(id) {
  const profile = appState.profiles.find((p) => p.id === id);
  if (!profile) return;
  if (profile.running) {
    showAlert('Stop the profile before deleting it.');
    return;
  }

  showConfirm('Delete profile ' + profile.username + '?', () => {
    showConfirm('Also delete the Chrome data directory for this profile?', async () => {
      await doDelete(id, true);
    }, async () => {
      await doDelete(id, false);
    });
  });
}

async function doDelete(id, deleteChromeDir) {
  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id, deleteChromeDir })
    });
    const data = await res.json();
    if (!data.ok) {
      showAlert(data.msg || 'Delete failed');
      return;
    }
    closeModal();
    closeEditList();
    if (appState.selectedProfileId === id) appState.selectedProfileId = null;
    await loadProfiles();
  } catch {
    showAlert('Server error while deleting.');
  }
}

// ---- Edit Profiles List Modal ----

function openEditList() {
  const modal = document.getElementById('editListModal');
  if (modal) modal.style.display = 'block';
  renderEditList();
}

function closeEditList() {
  const modal = document.getElementById('editListModal');
  if (modal) modal.style.display = 'none';
}

function renderEditList() {
  const container = document.getElementById('editListContainer');
  if (!container) return;

  if (appState.profiles.length === 0) {
    container.innerHTML = '<p class="muted">No profiles.</p>';
    return;
  }

  container.innerHTML = appState.profiles.map((p) => {
    const a = p.appointment || {};
    const cities = Array.isArray(a.city) ? a.city.join(', ') : (a.city || '');
    const status = p.running ? 'Running' : 'Stopped';
    return `
      <div class="edit-list-row">
        <div class="edit-list-info">
          <div class="edit-list-user">${p.username || 'Unknown'}</div>
          <div class="edit-list-detail">${cities} &bull; Port ${p.chromeRemoteDebugPort || ''} &bull; <b>${status}</b></div>
        </div>
        <div class="edit-list-actions">
          <button class="small" onclick="window.editProfile('${p.id}')">Edit</button>
          <button class="small danger" onclick="window.askDeleteProfile('${p.id}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function askDeleteProfile(id) {
  performDelete(id);
}

// ---- Event wiring ----

document.addEventListener('DOMContentLoaded', async () => {
  debugLog('DOMContentLoaded fired');
  
  // Show debug panel
  const dp = document.getElementById('debugPanel');
  if (dp) dp.style.display = 'none'; // hidden in client build
  document.getElementById('debugToggle')?.addEventListener('click', () => {
    const log = document.getElementById('debugLog');
    if (log) log.style.display = log.style.display === 'none' ? '' : 'none';
  });

  const licensed = await checkLicenseStatus();
  debugLog('licensed=' + licensed);

  document.getElementById('licenseActivateBtn')?.addEventListener('click', activateLicense);
  document.getElementById('licenseKeyInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') activateLicense();
  });

  if (licensed) {
    await loadProfiles();
  }

  document.getElementById('addProfileBtn')?.addEventListener('click', () => openModal(null));
  document.getElementById('editProfilesBtn')?.addEventListener('click', openEditList);
  document.getElementById('reloadProfilesBtn')?.addEventListener('click', () => loadProfiles());
  document.getElementById('clearLogs')?.addEventListener('click', apiClearLogs);
  document.getElementById('saveLogs')?.addEventListener('click', apiSaveLogs);

  document.getElementById('slotPatternBtn')?.addEventListener('click', openSlotPattern);
  document.getElementById('slotPatternClose')?.addEventListener('click', closeSlotPattern);
  document.querySelector('#slotPatternModal .modal-backdrop')?.addEventListener('click', closeSlotPattern);
  document.getElementById('slotPatternRefresh')?.addEventListener('click', loadSlotObservations);
  document.getElementById('slotPatternCityFilter')?.addEventListener('change', (e) => {
    slotPatternState.cityFilter = e.target.value;
    renderSlotPatternTable();
  });

  document.getElementById('modalClose')?.addEventListener('click', closeModal);
  document.querySelector('#profileModal .modal-backdrop')?.addEventListener('click', closeModal);
  document.getElementById('saveProfile')?.addEventListener('click', saveProfile);
  document.getElementById('deleteProfile')?.addEventListener('click', deleteProfile);

  document.getElementById('editListClose')?.addEventListener('click', closeEditList);
  document.querySelector('#editListModal .modal-backdrop')?.addEventListener('click', closeEditList);

  // Poll logs for selected profile + refresh profile statuses every 3 seconds
  setInterval(() => {
    if (appState.licensed) {
      pollLogs();
      refreshRunningStatuses();
    }
  }, 3000);

  // Poll current NordVPN IP every 15 seconds (global, not per-profile)
  setInterval(() => {
    if (appState.licensed) {
      fetchCurrentIP();
    }
  }, 15000);

  // Fetch IP on startup
  fetchCurrentIP();

  // Header Rotate IP button
  document.getElementById('rotateIpBtn')?.addEventListener('click', rotateIP);

  // Header "Less Slots" checkbox — persisted in config.local.json settings,
  // applied on next profile start (cores read config at spawn).
  document.getElementById('leastSlotsChk')?.addEventListener('change', async (e) => {
    const checked = !!e.target.checked;
    appState.leastSlotsSaving = true;
    appState.settings.preferLeastSlots = checked;
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferLeastSlots: checked })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.msg || 'save failed');
      debugLog('preferLeastSlots saved: ' + checked);
    } catch (err) {
      console.error('Failed to save preferLeastSlots:', err);
      e.target.checked = !checked;
      appState.settings.preferLeastSlots = !checked;
    } finally {
      appState.leastSlotsSaving = false;
    }
  });

  // Header IP mode dropdown (NO IP / AUTO IP / STATIC IP) — persisted in
  // config.local.json settings, applied on next profile start.
  document.getElementById('ipModeSel')?.addEventListener('change', async (e) => {
    const mode = e.target.value;
    const prev = appState.settings.ipMode || (appState.settings.autoRotateIp === false ? 'none' : 'auto');
    appState.ipModeSaving = true;
    appState.settings.ipMode = mode;
    appState.settings.autoRotateIp = mode !== 'none';
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ipMode: mode })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.msg || 'save failed');
      debugLog('ipMode saved: ' + mode);
    } catch (err) {
      console.error('Failed to save ipMode:', err);
      e.target.value = prev;
      appState.settings.ipMode = prev;
      appState.settings.autoRotateIp = prev !== 'none';
    } finally {
      appState.ipModeSaving = false;
    }
  });

  // Header "Special Window" checkbox — persisted in settings AND
  // written to a live flag file so running profiles pause/resume without a
  // restart.
  document.getElementById('specialWindowChk')?.addEventListener('change', async (e) => {
    const checked = !!e.target.checked;
    appState.specialWindowSaving = true;
    appState.settings.specialWindowOnly = checked;
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specialWindowOnly: checked })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.msg || 'save failed');
      debugLog('specialWindowOnly saved: ' + checked);
    } catch (err) {
      console.error('Failed to save specialWindowOnly:', err);
      e.target.checked = !checked;
      appState.settings.specialWindowOnly = !checked;
    } finally {
      appState.specialWindowSaving = false;
    }
  });

  // EXPERIMENTAL: avoidEarliestDate — header "2nd Date" checkbox, persisted
  // in settings, applied on next profile start (cores read config at spawn).
  document.getElementById('secondDateChk')?.addEventListener('change', async (e) => {
    const checked = !!e.target.checked;
    appState.secondDateSaving = true;
    appState.settings.avoidEarliestDate = checked;
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avoidEarliestDate: checked })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.msg || 'save failed');
      debugLog('avoidEarliestDate saved: ' + checked);
    } catch (err) {
      console.error('Failed to save avoidEarliestDate:', err);
      e.target.checked = !checked;
      appState.settings.avoidEarliestDate = !checked;
    } finally {
      appState.secondDateSaving = false;
    }
  });
});

async function refreshRunningStatuses() {
  // Only fetch profile list to update statuses (lightweight)
  if (appState.modalOpen) return;
  try {
    const res = await fetch('/api/profiles?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.profiles)) return;
    // Only update if statuses changed (avoid full re-render)
    let changed = false;
    for (const np of data.profiles) {
      const existing = appState.profiles.find((p) => p.id === np.id);
      if (existing && (existing.status !== np.status || existing.running !== np.running || existing.chromeConnected !== np.chromeConnected)) {
        existing.status = np.status;
        existing.running = np.running;
        existing.chromeConnected = np.chromeConnected;
        changed = true;
      }
    }
    if (changed) renderProfiles();
  } catch {}
}

// Make profile functions globally available for inline onclicks
window.selectProfile = selectProfile;
window.editProfile = (id) => { closeEditList(); openModal(appState.profiles.find((p) => p.id === id)); };
window.startProfile = startProfile;
window.stopProfile = stopProfile;
window.connectChrome = connectChrome;
window.showChrome = showChrome;
window.rotateIP = rotateIP;
window.askDeleteProfile = askDeleteProfile;

// ---- Slot Pattern Modal ----

const slotPatternState = {
  observations: [],
  cityFilter: ''
};

function openSlotPattern() {
  appState.modalOpen = true;
  const modal = document.getElementById('slotPatternModal');
  if (modal) modal.style.display = 'block';
  loadSlotObservations();
}

function closeSlotPattern() {
  appState.modalOpen = false;
  const modal = document.getElementById('slotPatternModal');
  if (modal) modal.style.display = 'none';
}

async function loadSlotObservations() {
  const body = document.getElementById('slotPatternBody');
  const emptyMsg = document.getElementById('slotPatternEmpty');
  const countLabel = document.getElementById('slotPatternCount');

  if (body) body.innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';
  if (emptyMsg) emptyMsg.style.display = 'none';

  try {
    const res = await fetch('/api/slot-observations?limit=50', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || 'Failed to load');

    slotPatternState.observations = data.observations || [];
    populateCityFilter();
    renderSlotPatternTable();
  } catch (err) {
    if (body) body.innerHTML = '<tr><td colspan="7" class="muted">Failed to load: ' + (err.message || err) + '</td></tr>';
    if (countLabel) countLabel.textContent = '';
  }
}

function populateCityFilter() {
  const select = document.getElementById('slotPatternCityFilter');
  if (!select) return;

  // Collect unique cities
  const cities = [...new Set(slotPatternState.observations.map((o) => o.city).filter(Boolean))].sort();

  // Preserve current selection
  const current = slotPatternState.cityFilter;
  select.innerHTML = '<option value="">All cities</option>' +
    cities.map((c) => '<option value="' + escapeHtml(c) + '"' + (c === current ? ' selected' : '') + '>' + escapeHtml(c) + '</option>').join('');
}

function renderSlotPatternTable() {
  const body = document.getElementById('slotPatternBody');
  const emptyMsg = document.getElementById('slotPatternEmpty');
  const countLabel = document.getElementById('slotPatternCount');
  if (!body) return;

  const filter = slotPatternState.cityFilter;
  const filtered = filter
    ? slotPatternState.observations.filter((o) => o.city === filter)
    : slotPatternState.observations;

  if (countLabel) countLabel.textContent = filtered.length + ' record' + (filtered.length !== 1 ? 's' : '');

  if (filtered.length === 0) {
    body.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }

  if (emptyMsg) emptyMsg.style.display = 'none';

  body.innerHTML = filtered.map((o) => {
    const istTime = toIST(o.timestamp);
    const stageClass = o.stage === 'ofc' ? 'ofc' : 'consular';
    const stageLabel = o.stage === 'ofc' ? 'OFC' : 'Consular';
    const dates = (o.availableDates || []);
    const inRange = (o.inRangeDates || []);
    const datesHtml = dates.length > 0
      ? escapeHtml(dates.join(', '))
      : '<span class="no-dates">none</span>';
    const inRangeHtml = inRange.length > 0
      ? escapeHtml(inRange.join(', '))
      : '<span class="no-dates">none</span>';
    let apiHtml;
    if (o.apiAvailable === true) {
      apiHtml = '<span class="api-yes">Yes</span><br><span class="muted">' + (o.apiScheduleDays || 0) + 'd/' + (o.apiScheduleEntries || 0) + 'e</span>';
    } else if (o.apiAvailable === false) {
      apiHtml = '<span class="api-no">No</span>';
    } else {
      apiHtml = '<span class="api-null">N/A</span>';
    }
    return '<tr>' +
      '<td class="col-time">' + escapeHtml(istTime) + '</td>' +
      '<td>' + escapeHtml(o.profile || '') + '</td>' +
      '<td class="col-stage ' + stageClass + '">' + stageLabel + '</td>' +
      '<td class="col-city">' + escapeHtml(o.city || '') + '</td>' +
      '<td class="col-dates">' + datesHtml + '</td>' +
      '<td class="col-dates">' + inRangeHtml + '</td>' +
      '<td class="col-api">' + apiHtml + '</td>' +
      '</tr>';
  }).join('');
}

/** Convert an ISO 8601 UTC timestamp to a human-readable IST string */
function toIST(isoStr) {
  try {
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) return isoStr || '';
    // IST = UTC + 5:30
    const ist = new Date(date.getTime() + (5 * 60 + 30) * 60 * 1000);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const d = String(ist.getUTCDate()).padStart(2, '0');
    const hh = String(ist.getUTCHours()).padStart(2, '0');
    const mm = String(ist.getUTCMinutes()).padStart(2, '0');
    const ss = String(ist.getUTCSeconds()).padStart(2, '0');
    return y + '-' + m + '-' + d + ' ' + hh + ':' + mm + ':' + ss;
  } catch {
    return isoStr || '';
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '\x26amp;')
    .replace(/</g, '\x26lt;')
    .replace(/>/g, '\x26gt;')
    .replace(/"/g, '\x26quot;')
    .replace(/'/g, '\x26#039;');
}
