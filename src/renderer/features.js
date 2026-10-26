'use strict';

const COMMANDS_KEY = 'dexter-local-commands-v1';
const ROUTINES_KEY = 'dexter-local-routines-v1';
const ACTIVITY_KEY = 'dexter-local-activity-v1';
const FEATURE_SETTINGS_KEY = 'dexter-local-settings-v1';
const feature$ = (selector) => document.querySelector(selector);

function readFeatureJSON(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

const savedFeatureSettings = readFeatureJSON(FEATURE_SETTINGS_KEY, {});
const featureState = {
  commands: Array.isArray(readFeatureJSON(COMMANDS_KEY, [])) ? readFeatureJSON(COMMANDS_KEY, []) : [],
  routines: Array.isArray(readFeatureJSON(ROUTINES_KEY, [])) ? readFeatureJSON(ROUTINES_KEY, []) : [],
  activity: Array.isArray(readFeatureJSON(ACTIVITY_KEY, [])) ? readFeatureJSON(ACTIVITY_KEY, []).slice(-500) : [],
  accent: typeof savedFeatureSettings.accent === 'string' && /^#[0-9a-f]{6}$/i.test(savedFeatureSettings.accent) ? savedFeatureSettings.accent : '#8b7cff',
  companion: savedFeatureSettings.companionEnabled !== false,
  speechEnabled: savedFeatureSettings.speechInputEnabled === true,
  speechConsent: savedFeatureSettings.speechConsent === true,
  recognition: null,
  wakeRecognition: null,
  wakeWordEnabled: savedFeatureSettings.wakeWordEnabled === true,
  wakeArmed: false,
  wakeRestartDelay: 1400,
  wakeRestartTimer: null,
  startPushAfterWake: false,
  recording: false,
  queue: [],
  trackIndex: -1,
  repeat: false,
  obs: null,
};

function persistFeatureSettings() {
  const current = readFeatureJSON(FEATURE_SETTINGS_KEY, {});
  localStorage.setItem(FEATURE_SETTINGS_KEY, JSON.stringify({
    ...current,
    accent: featureState.accent,
    companionEnabled: featureState.companion,
    speechInputEnabled: featureState.speechEnabled,
    speechConsent: featureState.speechConsent,
    wakeWordEnabled: featureState.wakeWordEnabled,
  }));
}

function recordAction(kind, label) {
  featureState.activity.push({ kind, label, at: new Date().toISOString() });
  featureState.activity = featureState.activity.slice(-500);
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(featureState.activity));
  renderAnalytics();
}

function showSystemResult(text) {
  const result = feature$('#system-result');
  result.hidden = false;
  result.textContent = text;
}

async function querySystem(kind) {
  const rows = await window.dexter.querySystem(kind);
  if (kind === 'battery') {
    if (!rows.length) return 'Windows did not report a battery. This computer may be a desktop.';
    const battery = rows[0];
    return battery.percent >= 0 ? battery.name + ': ' + battery.percent + '% remaining.' : battery.name + ': status unavailable.';
  }
  if (kind === 'monitors') {
    if (!rows.length) return 'No connected displays were returned by Windows.';
    return 'Connected displays:\n' + rows.map((item) => item.name + ' — ' + item.width + ' × ' + item.height + (item.primary ? ' (primary)' : '')).join('\n');
  }
  if (kind === 'running-apps') {
    if (!rows.length) return 'Windows did not report any visible app windows.';
    return 'Visible app windows (' + rows.length + '):\n' + rows.slice(0, 30).map((item) => item.name).join(', ');
  }
  return 'No system information was returned.';
}

function supportedRoutineCommand(command) {
  const value = command.trim();
  return /^(?:list apps|open folder|screenshot|focus settings|what time is it|battery status|list monitors|list running apps|turn displays off)$/i.test(value) ||
    /^(?:open|launch|start) app .{1,120}$/i.test(value);
}

function resolveAlias(text) {
  const normalized = normalizeName(text);
  const entry = featureState.commands.find((item) => normalizeName(item.phrase) === normalized);
  return entry ? entry.action : null;
}

async function runExtraCommand(text) {
  const clean = text.trim();
  const normalized = clean.toLocaleLowerCase();

  if (/^(?:focus settings|open notifications|do not disturb on|do not disturb off)$/i.test(clean)) {
    await window.dexter.runSystemAction('notifications');
    return normalized.startsWith('do not disturb') ? 'I opened Windows notification settings. Choose Do Not Disturb there; this app does not change the Windows toggle itself.' : 'Opened Windows notification settings.';
  }
  if (/^(?:lock (?:the )?(?:computer|screen|pc)(?: now)?|lock now)$/i.test(clean)) {
    const result = await window.dexter.runSystemAction('lock');
    return result.canceled ? 'Lock canceled.' : 'Windows is locking.';
  }
  if (/^(?:turn (?:the )?displays? off|sleep display|turn off (?:the )?screen)$/i.test(clean)) {
    const result = await window.dexter.runSystemAction('display-off');
    return result.canceled ? 'Display action canceled.' : 'Windows is turning off your displays. Move the mouse or press a key to wake them.';
  }
  if (/^(?:battery status|show battery|battery)$/i.test(clean)) {
    const result = await querySystem('battery');
    showSystemResult(result);
    return result;
  }
  if (/^(?:list monitors|show monitors|list displays|show displays)$/i.test(clean)) {
    const result = await querySystem('monitors');
    showSystemResult(result);
    return result;
  }
  if (/^(?:list running apps|show running apps|what is running)$/i.test(clean)) {
    const result = await querySystem('running-apps');
    showSystemResult(result);
    return result;
  }
  if (/^(?:open calendar|show calendar|read calendar)$/i.test(clean)) {
    if (/^read calendar$/i.test(clean)) {
      const result = await window.dexter.readLocalCalendar();
      if (result.canceled) return 'Calendar selection canceled.';
      if (!result.events.length) return 'No upcoming events were found in that local calendar file.';
      const lines = result.events.map((item) => new Date(item.start).toLocaleString() + ' — ' + item.title + (item.location ? ' · ' + item.location : ''));
      return 'Upcoming events from the calendar file you chose:\n' + lines.join('\n');
    }
    const apps = await window.dexter.listInstalledApps();
    const matches = apps.filter((app) => /calendar|outlook/i.test(app.name));
    const appSearch = feature$('#app-search');
    appSearch.value = matches.length ? 'calendar' : 'outlook';
    await window.dexterUI.refreshApps();
    window.dexterUI.setView('apps');
    return matches.length ? 'I found a calendar app. Choose it from the filtered Desktop list.' : 'I could not find a Start menu app named Calendar or Outlook. Search your installed apps instead.';
  }
  if (/^(?:play music|open music player|music player)$/i.test(clean)) {
    window.dexterUI.setView('music');
    return 'The local music player is ready. Add audio files from this computer to start a queue.';
  }
  if (/^(?:show|open) (?:my )?commands$/i.test(clean)) {
    window.dexterUI.setView('commands');
    return 'Your saved command shortcuts are on the Commands page.';
  }
  if (/^(?:show|open) (?:my )?routines$/i.test(clean)) {
    window.dexterUI.setView('routines');
    return 'Your saved routines are on the Routines page.';
  }
  if (/^(?:show|open) (?:activity|analytics)$/i.test(clean)) {
    window.dexterUI.setView('analytics');
    renderAnalytics();
    return 'Local activity totals are on the Activity page.';
  }
  if (/^(?:show|open) (?:integrations|obs)$/i.test(clean)) {
    window.dexterUI.setView('integrations');
    return 'Local integrations are on the Integrations page. OBS is available when its WebSocket server is enabled.';
  }
  return null;
}

window.dexterFeatures = Object.freeze({ resolveAlias, runCommand: runExtraCommand, recordAction });

function applyAccent() {
  document.documentElement.style.setProperty('--accent', featureState.accent);
  document.documentElement.style.setProperty('--accent-light', featureState.accent);
  const colorInput = feature$('#accent-color');
  if (colorInput) colorInput.value = featureState.accent;
}

function renderCommands() {
  const list = feature$('#command-list');
  if (!list) return;
  list.replaceChildren();
  feature$('#command-count').textContent = featureState.commands.length + (featureState.commands.length === 1 ? ' shortcut' : ' shortcuts');
  if (!featureState.commands.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-apps';
    empty.textContent = 'No custom commands yet.';
    list.append(empty);
    return;
  }
  for (const [index, item] of featureState.commands.entries()) {
    const row = document.createElement('article');
    row.className = 'saved-row';
    const copy = document.createElement('div');
    copy.className = 'saved-row-copy';
    const title = document.createElement('strong');
    title.textContent = item.phrase;
    const detail = document.createElement('small');
    detail.textContent = 'Runs: ' + item.action;
    copy.append(title, detail);
    const run = document.createElement('button');
    run.className = 'secondary-button';
    run.type = 'button';
    run.textContent = 'Run';
    run.addEventListener('click', () => window.dexterUI.sendMessage(item.phrase));
    const remove = document.createElement('button');
    remove.className = 'text-button danger-text';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      featureState.commands.splice(index, 1);
      localStorage.setItem(COMMANDS_KEY, JSON.stringify(featureState.commands));
      renderCommands();
    });
    row.append(copy, run, remove);
    list.append(row);
  }
}

function renderRoutines() {
  const list = feature$('#routine-list');
  if (!list) return;
  list.replaceChildren();
  feature$('#routine-count').textContent = featureState.routines.length + (featureState.routines.length === 1 ? ' routine' : ' routines');
  if (!featureState.routines.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-apps';
    empty.textContent = 'No routines yet.';
    list.append(empty);
    return;
  }
  for (const [index, routine] of featureState.routines.entries()) {
    const row = document.createElement('article');
    row.className = 'saved-row routine-row';
    const copy = document.createElement('div');
    copy.className = 'saved-row-copy';
    const title = document.createElement('strong');
    title.textContent = routine.name;
    const detail = document.createElement('small');
    detail.textContent = routine.steps.length + ' approved local steps';
    copy.append(title, detail);
    const run = document.createElement('button');
    run.className = 'primary-button compact-button';
    run.type = 'button';
    run.textContent = 'Run routine';
    run.addEventListener('click', () => executeRoutine(routine));
    const remove = document.createElement('button');
    remove.className = 'text-button danger-text';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      featureState.routines.splice(index, 1);
      localStorage.setItem(ROUTINES_KEY, JSON.stringify(featureState.routines));
      renderRoutines();
    });
    row.append(copy, run, remove);
    list.append(row);
  }
}

async function executeRoutine(routine) {
  if (!window.confirm('Run “' + routine.name + '” now? Each folder or screenshot step will ask for your input.')) return;
  recordAction('routine', 'Ran a saved routine');
  window.dexterUI.setView('assistant');
  window.dexterUI.addMessage('user', 'Run my saved routine (' + routine.steps.length + ' steps).');
  for (const step of routine.steps) {
    window.dexterUI.addMessage('user', step);
    try {
      const result = await window.dexterUI.runDesktopCommand(step);
      if (result === null || result === undefined) {
        window.dexterUI.addMessage('assistant', 'I stopped because a routine step is not available: ' + step);
        break;
      }
      window.dexterUI.addMessage('assistant', result);
    } catch (error) {
      window.dexterUI.addMessage('assistant', error.message || 'Routine step failed.');
      break;
    }
  }
}

function renderAnalytics() {
  if (!feature$('#activity-list')) return;
  const kinds = {
    command: '#metric-commands',
    app: '#metric-apps',
    routine: '#metric-routines',
    music: '#metric-music',
  };
  for (const [kind, selector] of Object.entries(kinds)) {
    feature$(selector).textContent = String(featureState.activity.filter((item) => item.kind === kind).length);
  }
  const list = feature$('#activity-list');
  list.replaceChildren();
  if (!featureState.activity.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-apps';
    empty.textContent = 'No activity recorded yet.';
    list.append(empty);
    return;
  }
  for (const item of featureState.activity.slice(-30).reverse()) {
    const row = document.createElement('article');
    row.className = 'saved-row activity-row';
    const dot = document.createElement('span');
    dot.className = 'activity-dot activity-' + item.kind;
    const label = document.createElement('strong');
    label.textContent = item.label;
    const date = document.createElement('small');
    date.textContent = new Date(item.at).toLocaleString();
    row.append(dot, label, date);
    list.append(row);
  }
}

function addMusicFiles(files) {
  const audioFiles = Array.from(files).filter((file) => file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus|webm)$/i.test(file.name));
  for (const file of audioFiles) featureState.queue.push({ file, url: URL.createObjectURL(file) });
  renderMusicQueue();
  if (featureState.trackIndex < 0 && featureState.queue.length) playTrack(0);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return minutes + ':' + remainder;
}

async function playTrack(index) {
  if (index < 0 || index >= featureState.queue.length) return;
  const audio = feature$('#local-audio');
  featureState.trackIndex = index;
  const track = featureState.queue[index];
  audio.src = track.url;
  feature$('#music-title').textContent = track.file.name;
  feature$('#music-subtitle').textContent = 'Playing from this computer · not uploaded';
  renderMusicQueue();
  try {
    await audio.play();
    feature$('#music-play').textContent = 'Ⅱ';
    feature$('#music-play').setAttribute('aria-label', 'Pause');
    recordAction('music', 'Played local audio');
  } catch (error) {
    feature$('#music-subtitle').textContent = error.message || 'Could not play this file.';
  }
}

function renderMusicQueue() {
  const list = feature$('#music-queue');
  list.replaceChildren();
  feature$('#music-count').textContent = featureState.queue.length + (featureState.queue.length === 1 ? ' track' : ' tracks');
  if (!featureState.queue.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-apps';
    empty.textContent = 'Add local audio files to start a queue.';
    list.append(empty);
    feature$('#music-title').textContent = 'Choose local audio files';
    feature$('#music-subtitle').textContent = 'Your queue stays in this session.';
    featureState.trackIndex = -1;
    return;
  }
  featureState.queue.forEach((track, index) => {
    const row = document.createElement('article');
    row.className = 'music-track' + (index === featureState.trackIndex ? ' selected-track' : '');
    const number = document.createElement('span');
    number.className = 'track-number';
    number.textContent = index === featureState.trackIndex ? '♫' : String(index + 1).padStart(2, '0');
    const name = document.createElement('button');
    name.className = 'track-name';
    name.type = 'button';
    name.textContent = track.file.name;
    name.addEventListener('click', () => playTrack(index));
    const size = document.createElement('small');
    size.textContent = track.file.size ? (track.file.size / 1024 / 1024).toFixed(1) + ' MB' : 'Local file';
    const remove = document.createElement('button');
    remove.className = 'text-button';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove ' + track.file.name);
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(track.url);
      const wasCurrent = index === featureState.trackIndex;
      featureState.queue.splice(index, 1);
      if (index < featureState.trackIndex) featureState.trackIndex -= 1;
      if (wasCurrent) {
        feature$('#local-audio').pause();
        featureState.trackIndex = -1;
        if (featureState.queue.length) playTrack(Math.min(index, featureState.queue.length - 1));
      }
      renderMusicQueue();
    });
    row.append(number, name, size, remove);
    list.append(row);
  });
}

function connectObsUI() {
  feature$('#obs-connect').disabled = true;
  feature$('#obs-status-chip').textContent = 'CONNECTING…';
  window.dexter.connectObs({ port: Number(feature$('#obs-port').value), password: feature$('#obs-password').value })
    .then(async () => {
      feature$('#obs-password').value = '';
      featureState.obs = await window.dexter.getObsStatus();
      renderObs();
    })
    .catch((error) => {
      feature$('#obs-status-chip').textContent = 'DISCONNECTED';
      feature$('#obs-summary').textContent = error.message || 'Could not connect to OBS.';
      feature$('#obs-controls').hidden = true;
    })
    .finally(() => {
      feature$('#obs-connect').disabled = false;
      feature$('#obs-disconnect').disabled = false;
    });
}

function renderObs() {
  const status = featureState.obs;
  const connected = Boolean(status && status.connected);
  feature$('#obs-status-chip').textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
  feature$('#obs-status-chip').classList.toggle('connected-status', connected);
  feature$('#obs-disconnect').disabled = !connected;
  feature$('#obs-connect').disabled = connected;
  feature$('#obs-controls').hidden = !connected;
  if (!connected) return;

  feature$('#obs-summary').textContent = 'OBS ' + (status.obsVersion || 'connected') + (status.currentScene ? ' · Program scene: ' + status.currentScene : '');
  const scenes = feature$('#obs-scenes');
  scenes.replaceChildren();
  for (const sceneName of status.scenes) {
    const option = document.createElement('option');
    option.value = sceneName;
    option.textContent = sceneName;
    option.selected = sceneName === status.currentScene;
    scenes.append(option);
  }
  feature$('#obs-stream-state').textContent = status.streaming ? 'Live' : 'Inactive';
  feature$('#obs-stream-toggle').textContent = status.streaming ? 'Stop stream' : 'Start stream';
  feature$('#obs-stream-toggle').classList.toggle('danger-button', status.streaming);
  feature$('#obs-record-state').textContent = status.recording ? 'Recording' : 'Inactive';
  feature$('#obs-record-toggle').textContent = status.recording ? 'Stop recording' : 'Start recording';
  feature$('#obs-record-toggle').classList.toggle('danger-button', status.recording);

  const inputs = feature$('#obs-inputs');
  inputs.replaceChildren();
  if (!status.inputs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-apps compact-empty';
    empty.textContent = 'No OBS inputs found.';
    inputs.append(empty);
  }
  for (const item of status.inputs) {
    const row = document.createElement('div');
    row.className = 'obs-input-row';
    const name = document.createElement('span');
    name.textContent = item.name;
    const kind = document.createElement('small');
    kind.textContent = item.kind;
    const toggle = document.createElement('button');
    toggle.className = 'secondary-button';
    toggle.type = 'button';
    toggle.textContent = item.muted ? 'Unmute' : 'Mute';
    toggle.addEventListener('click', () => {
      window.dexter.setObsMute(item.name, !item.muted).then(refreshObs).catch(showObsError);
    });
    row.append(name, kind, toggle);
    inputs.append(row);
  }
}

async function refreshObs() {
  try {
    featureState.obs = await window.dexter.getObsStatus();
    renderObs();
  } catch (error) {
    showObsError(error);
    featureState.obs = null;
    renderObs();
  }
}

function showObsError(error) {
  feature$('#obs-summary').textContent = error.message || 'OBS request failed.';
}

async function toggleObsOutput(kind) {
  const active = kind === 'stream' ? featureState.obs.streaming : featureState.obs.recording;
  const label = kind === 'stream' ? 'stream' : 'recording';
  if (!active && !window.confirm('Start ' + label + ' in OBS now?')) return;
  try {
    await window.dexter.setObsOutput(kind, !active);
    recordAction('command', (active ? 'Stopped ' : 'Started ') + label);
    await refreshObs();
  } catch (error) {
    showObsError(error);
  }
}

function setSpeechStatus(active, text) {
  featureState.recording = active;
  feature$('#voice-button').classList.toggle('voice-active', active);
  feature$('#voice-status').hidden = !active;
  feature$('#voice-top-status').hidden = !active;
  if (text) feature$('#voice-status').textContent = text;
}

function stopSpeechRecognition() {
  if (featureState.recognition) {
    try { featureState.recognition.stop(); } catch {}
  }
  if (featureState.wakeRestartTimer) clearTimeout(featureState.wakeRestartTimer);
  featureState.wakeRestartTimer = null;
  featureState.wakeWordEnabled = false;
  featureState.wakeArmed = false;
  persistFeatureSettings();
  if (featureState.wakeRecognition) {
    try { featureState.wakeRecognition.stop(); } catch {}
  }
}

function ensureSpeechConsent() {
  if (featureState.speechConsent) return true;
  const accepted = window.confirm('Voice input can send microphone audio to Chromium’s speech recognition provider. Continue?');
  if (accepted) {
    featureState.speechConsent = true;
    persistFeatureSettings();
  }
  return accepted;
}

function toggleVoiceCapture() {
  if (!featureState.speechEnabled) {
    window.dexterUI.setView('settings');
    window.alert('Enable speech input in Settings first. Speech recognition may process audio through Chromium’s recognition provider.');
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    window.dexterUI.setView('assistant');
    window.dexterUI.addMessage('assistant', 'Speech recognition is not available in this Electron build. You can still type commands or use text-to-speech.');
    return;
  }
  if (!ensureSpeechConsent()) return;
  if (featureState.wakeRecognition) {
    featureState.startPushAfterWake = true;
    featureState.wakeRestartDelay = 1400;
    try { featureState.wakeRecognition.stop(); } catch {}
    return;
  }
  if (featureState.recording) {
    if (featureState.recognition) {
      try { featureState.recognition.stop(); } catch {}
    }
    return;
  }
  const recognition = new SpeechRecognition();
  featureState.recognition = recognition;
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => setSpeechStatus(true, 'Listening… · audio may be processed by Chromium’s speech provider');
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results).map((item) => item[0].transcript).join(' ').trim();
    if (transcript) {
      feature$('#chat-input').value = transcript;
      feature$('#chat-input').focus();
      feature$('#voice-status').textContent = 'Transcript ready · review it before sending';
    }
  };
  recognition.onerror = (event) => {
    const message = event.error === 'not-allowed' ? 'Microphone access was denied.' : 'Speech input stopped: ' + event.error;
    if (event.error === 'not-allowed' && featureState.wakeWordEnabled) {
      featureState.wakeWordEnabled = false;
      feature$('#wake-word-enabled').checked = false;
      persistFeatureSettings();
    }
    window.dexterUI.setView('assistant');
    window.dexterUI.addMessage('assistant', message);
    setSpeechStatus(false);
    featureState.recognition = null;
    if (featureState.wakeWordEnabled) scheduleWakeRestart(1500);
  };
  recognition.onend = () => {
    setSpeechStatus(false);
    featureState.recognition = null;
    recordAction('command', 'Used speech input');
    if (featureState.wakeWordEnabled) scheduleWakeRestart(1500);
  };
  try {
    recognition.start();
  } catch (error) {
    setSpeechStatus(false);
    featureState.recognition = null;
    window.dexterUI.setView('assistant');
    window.dexterUI.addMessage('assistant', error.message || 'Could not start speech input.');
  }
}

function scheduleWakeRestart(delay) {
  if (featureState.wakeRestartTimer) clearTimeout(featureState.wakeRestartTimer);
  featureState.wakeRestartTimer = setTimeout(() => {
    featureState.wakeRestartTimer = null;
    if (featureState.startPushAfterWake) {
      featureState.startPushAfterWake = false;
      toggleVoiceCapture();
    } else {
      startWakeWord();
    }
  }, delay);
}

function startWakeWord() {
  if (!featureState.wakeWordEnabled || !featureState.speechEnabled || featureState.wakeRecognition || featureState.recognition) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    featureState.wakeWordEnabled = false;
    feature$('#wake-word-enabled').checked = false;
    persistFeatureSettings();
    window.dexterUI.setView('assistant');
    window.dexterUI.addMessage('assistant', 'Wake-word recognition is not available in this Electron build.');
    return;
  }
  const recognition = new SpeechRecognition();
  featureState.wakeRecognition = recognition;
  featureState.wakeArmed = false;
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => setSpeechStatus(true, 'Wake phrase active · audio may be processed by Chromium’s speech provider');
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result.isFinal) continue;
      const transcript = String(result[0] && result[0].transcript || '').trim();
      if (!transcript) continue;
      if (!featureState.wakeArmed) {
        const wakeMatch = transcript.match(/\bhey\s+dexter\b/i);
        if (!wakeMatch) continue;
        const command = transcript.slice(wakeMatch.index + wakeMatch[0].length).replace(/^[\s,:-]+/, '').trim();
        if (command) {
          feature$('#chat-input').value = command;
          feature$('#chat-input').focus();
          featureState.wakeRestartDelay = 10000;
          try { recognition.stop(); } catch {}
          return;
        }
        featureState.wakeArmed = true;
        setSpeechStatus(true, 'Wake phrase heard · say a command, then review the transcript');
        continue;
      }
      feature$('#chat-input').value = transcript;
      feature$('#chat-input').focus();
      featureState.wakeArmed = false;
      featureState.wakeRestartDelay = 10000;
      try { recognition.stop(); } catch {}
      return;
    }
  };
  recognition.onerror = (event) => {
    if (event.error === 'not-allowed') {
      featureState.wakeWordEnabled = false;
      feature$('#wake-word-enabled').checked = false;
      persistFeatureSettings();
      setSpeechStatus(false);
      window.dexterUI.setView('assistant');
      window.dexterUI.addMessage('assistant', 'Wake-word listening stopped because microphone access was denied.');
    }
    featureState.wakeRecognition = null;
  };
  recognition.onend = () => {
    featureState.wakeRecognition = null;
    featureState.wakeArmed = false;
    setSpeechStatus(false);
    if (featureState.wakeWordEnabled) scheduleWakeRestart(featureState.wakeRestartDelay);
    featureState.wakeRestartDelay = 1400;
  };
  try {
    recognition.start();
  } catch (error) {
    featureState.wakeRecognition = null;
    featureState.wakeWordEnabled = false;
    feature$('#wake-word-enabled').checked = false;
    persistFeatureSettings();
    window.dexterUI.setView('assistant');
    window.dexterUI.addMessage('assistant', error.message || 'Could not start wake-word listening.');
  }
}

feature$('#command-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const phrase = feature$('#command-alias').value.trim();
  const action = feature$('#command-action').value.trim();
  const valid = supportedRoutineCommand(action) || /^open app .{1,120}$/i.test(action);
  if (!phrase || !valid) {
    window.alert('Choose a shortcut phrase and one supported local command. Arbitrary shell commands are not accepted.');
    return;
  }
  if (featureState.commands.some((item) => normalizeName(item.phrase) === normalizeName(phrase))) {
    window.alert('A shortcut with that phrase already exists.');
    return;
  }
  featureState.commands.push({ phrase, action });
  localStorage.setItem(COMMANDS_KEY, JSON.stringify(featureState.commands));
  feature$('#command-form').reset();
  renderCommands();
});

feature$('#routine-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = feature$('#routine-name').value.trim();
  const steps = feature$('#routine-steps').value.split(/\r?\n/).map((step) => step.trim()).filter(Boolean);
  if (!name || steps.length === 0 || steps.length > 8 || steps.some((step) => !supportedRoutineCommand(step))) {
    window.alert('A routine needs 1–8 supported local command steps. No arbitrary shell commands are allowed.');
    return;
  }
  featureState.routines.push({ name, steps });
  localStorage.setItem(ROUTINES_KEY, JSON.stringify(featureState.routines));
  feature$('#routine-form').reset();
  renderRoutines();
});

feature$('#clear-activity').addEventListener('click', () => {
  if (!window.confirm('Clear local activity totals on this computer?')) return;
  featureState.activity = [];
  localStorage.setItem(ACTIVITY_KEY, '[]');
  renderAnalytics();
});

document.addEventListener('click', (event) => {
  if (event.target.closest('.app-open-button')) recordAction('app', 'Opened an installed app');
  if (event.target.closest('[data-go-settings]')) window.dexterUI.setView('settings');
  if (event.target.closest('[data-system-action]')) {
    const action = event.target.closest('[data-system-action]').dataset.systemAction;
    window.dexter.runSystemAction(action).then((result) => {
      if (action === 'lock') showSystemResult(result.locked ? 'Windows is locking.' : 'Lock canceled.');
      else if (action === 'display-off') showSystemResult(result.turnedOff ? 'Windows is turning off your displays.' : 'Display action canceled.');
      else showSystemResult('Opened Windows notification settings.');
      if (!result.canceled) recordAction('command', action === 'lock' ? 'Locked Windows' : action === 'display-off' ? 'Turned displays off' : 'Opened focus settings');
    }).catch((error) => showSystemResult(error.message || 'System action failed.'));
  }
  if (event.target.closest('[data-system-query]')) {
    const kind = event.target.closest('[data-system-query]').dataset.systemQuery;
    querySystem(kind).then((text) => {
      showSystemResult(text);
      recordAction('command', 'Checked local system status');
    }).catch((error) => showSystemResult(error.message || 'Could not read system status.'));
  }
  if (event.target.closest('[data-system-open-calendar]')) {
    window.dexterUI.sendMessage('open calendar');
  }
  if (event.target.closest('[data-calendar-read]')) {
    window.dexterUI.sendMessage('read calendar');
  }
});

document.querySelectorAll('.nav-button').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.view === 'commands') renderCommands();
    if (button.dataset.view === 'routines') renderRoutines();
    if (button.dataset.view === 'analytics') renderAnalytics();
  });
});

feature$('#choose-music').addEventListener('click', () => feature$('#music-file-input').click());
feature$('#music-file-input').addEventListener('change', (event) => {
  addMusicFiles(event.target.files || []);
  event.target.value = '';
});
feature$('#music-play').addEventListener('click', async () => {
  const audio = feature$('#local-audio');
  if (featureState.trackIndex < 0 && featureState.queue.length) return playTrack(0);
  if (audio.paused) {
    try {
      await audio.play();
      feature$('#music-play').textContent = 'Ⅱ';
      feature$('#music-play').setAttribute('aria-label', 'Pause');
    } catch (error) {
      feature$('#music-subtitle').textContent = error.message || 'Could not play this track.';
    }
  } else {
    audio.pause();
  }
});
feature$('#music-previous').addEventListener('click', () => {
  if (featureState.queue.length) playTrack((featureState.trackIndex - 1 + featureState.queue.length) % featureState.queue.length);
});
feature$('#music-next').addEventListener('click', () => {
  if (featureState.queue.length) playTrack((featureState.trackIndex + 1) % featureState.queue.length);
});
feature$('#music-loop').addEventListener('click', () => {
  featureState.repeat = !featureState.repeat;
  feature$('#local-audio').loop = featureState.repeat;
  feature$('#music-loop').classList.toggle('loop-active', featureState.repeat);
});
feature$('#music-volume').addEventListener('input', (event) => { feature$('#local-audio').volume = Number(event.target.value); });
feature$('#music-seek').addEventListener('input', (event) => {
  const audio = feature$('#local-audio');
  if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = audio.duration * Number(event.target.value) / 1000;
});
feature$('#local-audio').volume = 0.75;
feature$('#local-audio').addEventListener('timeupdate', () => {
  const audio = feature$('#local-audio');
  feature$('#music-current-time').textContent = formatTime(audio.currentTime);
  feature$('#music-duration').textContent = formatTime(audio.duration);
  if (Number.isFinite(audio.duration) && audio.duration > 0) feature$('#music-seek').value = String(Math.round(audio.currentTime / audio.duration * 1000));
});
feature$('#local-audio').addEventListener('play', () => {
  feature$('#music-play').textContent = 'Ⅱ';
  feature$('#music-play').setAttribute('aria-label', 'Pause');
});
feature$('#local-audio').addEventListener('pause', () => {
  feature$('#music-play').textContent = '▶';
  feature$('#music-play').setAttribute('aria-label', 'Play');
});
feature$('#local-audio').addEventListener('ended', () => {
  if (!featureState.repeat && featureState.trackIndex + 1 < featureState.queue.length) playTrack(featureState.trackIndex + 1);
});

feature$('#obs-connect').addEventListener('click', connectObsUI);
feature$('#obs-disconnect').addEventListener('click', async () => {
  await window.dexter.disconnectObs();
  featureState.obs = null;
  feature$('#obs-status-chip').textContent = 'DISCONNECTED';
  renderObs();
});
feature$('#obs-refresh').addEventListener('click', refreshObs);
feature$('#obs-set-scene').addEventListener('click', async () => {
  try {
    const scene = feature$('#obs-scenes').value;
    await window.dexter.setObsScene(scene);
    recordAction('command', 'Switched OBS scene');
    await refreshObs();
  } catch (error) {
    showObsError(error);
  }
});
feature$('#obs-stream-toggle').addEventListener('click', () => toggleObsOutput('stream'));
feature$('#obs-record-toggle').addEventListener('click', () => toggleObsOutput('record'));

feature$('#open-overlay').addEventListener('click', () => window.dexter.toggleOverlay());
feature$('#open-overlay-settings').addEventListener('click', () => window.dexter.toggleOverlay());
feature$('#accent-color').addEventListener('input', (event) => {
  featureState.accent = event.target.value;
  applyAccent();
  persistFeatureSettings();
});

feature$('#speech-input-enabled').checked = featureState.speechEnabled;
feature$('#speech-input-enabled').addEventListener('change', (event) => {
  featureState.speechEnabled = event.target.checked;
  persistFeatureSettings();
  if (!featureState.speechEnabled) {
    stopSpeechRecognition();
    feature$('#wake-word-enabled').checked = false;
  }
});
feature$('#wake-word-enabled').checked = featureState.wakeWordEnabled;
feature$('#wake-word-enabled').addEventListener('change', (event) => {
  if (event.target.checked && !featureState.speechEnabled) {
    event.target.checked = false;
    window.alert('Enable speech input first. Wake-word listening uses the same speech provider.');
    window.dexterUI.setView('settings');
    return;
  }
  if (event.target.checked && !ensureSpeechConsent()) {
    event.target.checked = false;
    return;
  }
  featureState.wakeWordEnabled = event.target.checked;
  featureState.wakeRestartDelay = 1400;
  persistFeatureSettings();
  if (featureState.wakeWordEnabled) startWakeWord();
  else {
    if (featureState.wakeRestartTimer) clearTimeout(featureState.wakeRestartTimer);
    featureState.wakeRestartTimer = null;
    if (featureState.wakeRecognition) {
      try { featureState.wakeRecognition.stop(); } catch {}
    }
    setSpeechStatus(false);
  }
});
feature$('#companion-enabled').checked = featureState.companion;
feature$('#companion-widget').hidden = !featureState.companion;
feature$('#companion-enabled').addEventListener('change', (event) => {
  featureState.companion = event.target.checked;
  feature$('#companion-widget').hidden = !featureState.companion;
  persistFeatureSettings();
});
feature$('#companion-widget').addEventListener('click', () => {
  window.dexterUI.setView('assistant');
  feature$('#chat-input').focus();
});
feature$('#voice-button').addEventListener('click', toggleVoiceCapture);
window.dexter.onVoiceToggle(toggleVoiceCapture);
feature$('#export-diagnostics').addEventListener('click', async () => {
  try {
    const result = await window.dexter.exportDiagnostics();
    if (result.saved) window.dexterUI.addMessage('assistant', 'Saved private diagnostics to the location you selected.');
  } catch (error) {
    window.dexterUI.addMessage('assistant', error.message || 'Could not export diagnostics.');
  }
});
feature$('#open-project').addEventListener('click', () => window.dexter.openProjectPage());

applyAccent();
renderCommands();
renderRoutines();
renderAnalytics();
renderMusicQueue();
if (featureState.wakeWordEnabled && featureState.speechEnabled && featureState.speechConsent) {
  setTimeout(startWakeWord, 1200);
} else if (featureState.wakeWordEnabled) {
  featureState.wakeWordEnabled = false;
  feature$('#wake-word-enabled').checked = false;
  persistFeatureSettings();
}
