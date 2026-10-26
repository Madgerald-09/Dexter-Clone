'use strict';

const STORAGE_KEY = 'dexter-local-chat-v1';
const SETTINGS_KEY = 'dexter-local-settings-v1';
const $ = (selector) => document.querySelector(selector);
const messagesElement = $('#messages');
const chatScroll = $('#chat-scroll');
const welcomeBlock = $('#welcome-block');
const chatInput = $('#chat-input');
const sendButton = $('#send-button');
const appListElement = $('#app-list');
const appSearch = $('#app-search');

function readJSON(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

const settings = readJSON(SETTINGS_KEY, {});
const state = {
  messages: Array.isArray(readJSON(STORAGE_KEY, [])) ? readJSON(STORAGE_KEY, []).slice(-120) : [],
  apps: [],
  appMode: 'all',
  view: 'assistant',
  busy: false,
  useLocalModel: settings.useLocalModel === true,
  model: typeof settings.model === 'string' ? settings.model : '',
  speakReplies: settings.speakReplies === true,
};

function saveSettings() {
  const current = readJSON(SETTINGS_KEY, {});
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    ...current,
    useLocalModel: state.useLocalModel,
    model: state.model,
    speakReplies: state.speakReplies,
  }));
}

function saveMessages() {
  const safeMessages = state.messages.filter((message) => !message.sensitive).slice(-120);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safeMessages));
}

function scrollToBottom() {
  requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
}

function speak(text) {
  if (!state.speakReplies || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 1200));
  window.speechSynthesis.speak(utterance);
}

function renderMessage(message) {
  const row = document.createElement('article');
  row.className = 'message ' + (message.role === 'user' ? 'user-message' : 'assistant-message');
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar ' + (message.role === 'user' ? 'user-avatar' : 'assistant-avatar');
  avatar.textContent = message.role === 'user' ? 'G' : '✦';
  const body = document.createElement('div');
  body.className = 'message-body';
  const author = document.createElement('div');
  author.className = 'message-author';
  author.textContent = message.role === 'user' ? 'You' : 'Dexter';
  const content = document.createElement('p');
  content.className = 'message-content';
  content.textContent = message.content;
  body.append(author, content);
  row.append(avatar, body);
  messagesElement.append(row);
}

function renderMessages() {
  messagesElement.replaceChildren();
  welcomeBlock.hidden = state.messages.some((message) => !message.sensitive);
  for (const message of state.messages) renderMessage(message);
  scrollToBottom();
}

function addMessage(role, content, options = {}) {
  const message = { role, content: String(content), sensitive: options.sensitive === true };
  state.messages.push(message);
  while (state.messages.length > 120) state.messages.shift();
  renderMessage(message);
  welcomeBlock.hidden = true;
  saveMessages();
  if (role === 'assistant' && !message.sensitive) speak(message.content);
  scrollToBottom();
}

function setBusy(busy) {
  state.busy = busy;
  sendButton.disabled = busy;
  sendButton.innerHTML = busy ? '<span class="send-spinner"></span><span>Thinking</span>' : '<span>Send</span><span aria-hidden="true">↑</span>';
  chatInput.disabled = busy;
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((element) => element.classList.toggle('active', element.id === 'view-' + view));
  document.querySelectorAll('.nav-button').forEach((element) => element.classList.toggle('active', element.dataset.view === view));
  const titles = { assistant: 'Assistant', apps: 'Desktop', music: 'Music player', commands: 'Commands', routines: 'Routines', analytics: 'Activity', integrations: 'Integrations', overlay: 'Quick panel', settings: 'Settings' };
  const title = titles[view] || 'Assistant';
  $('#view-title').textContent = title;
  if (view === 'apps' && state.apps.length === 0) refreshApps();
}

function normalizeName(value) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function renderApps() {
  const filter = normalizeName(appSearch.value);
  const codingApp = /(visual studio|vs code|vscode|cursor|codeium|intellij|pycharm|webstorm|rider|eclipse|sublime text|notepad\+\+|windows terminal|terminal|powershell)/i;
  const eligible = state.apps.filter((app) => state.appMode !== 'coding' || codingApp.test(app.name));
  const visible = eligible.filter((app) => normalizeName(app.name).includes(filter));
  appListElement.replaceChildren();
  $('#apps-count').textContent = state.appMode === 'coding' ? visible.length + ' coding app' + (visible.length === 1 ? '' : 's') + ' found' : state.apps.length + (state.apps.length === 1 ? ' app found' : ' apps found') + (filter ? ' · ' + visible.length + ' shown' : '');

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-apps';
    empty.textContent = state.appMode === 'coding' ? 'No likely code editors or terminals were found. Type in the search box to show all matching installed apps.' : state.apps.length ? 'No apps match your search.' : 'No Start menu apps were found.';
    appListElement.append(empty);
    return;
  }

  for (const [index, app] of visible.entries()) {
    const row = document.createElement('article');
    row.className = 'app-row';
    const icon = document.createElement('div');
    icon.className = 'app-icon app-icon-' + (index % 5);
    icon.textContent = app.name.trim().charAt(0).toLocaleUpperCase();
    const name = document.createElement('div');
    name.className = 'app-row-name';
    const strong = document.createElement('strong');
    strong.textContent = app.name;
    const small = document.createElement('small');
    small.textContent = 'Windows app';
    name.append(strong, small);
    const open = document.createElement('button');
    open.className = 'secondary-button app-open-button';
    open.type = 'button';
    open.textContent = 'Open';
    open.addEventListener('click', () => openApp(app));
    row.append(icon, name, open);
    appListElement.append(row);
  }
}

async function refreshApps() {
  $('#apps-count').textContent = 'Reading the Windows Start menu…';
  appListElement.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'empty-apps';
  loading.textContent = 'Loading installed apps…';
  appListElement.append(loading);
  try {
    state.apps = await window.dexter.listInstalledApps();
    renderApps();
  } catch (error) {
    $('#apps-count').textContent = 'App list unavailable';
    appListElement.replaceChildren();
    const message = document.createElement('div');
    message.className = 'empty-apps error-state';
    message.textContent = error.message || 'Could not read the installed-app list.';
    appListElement.append(message);
  }
}

async function openApp(app) {
  try {
    const result = await window.dexter.openInstalledApp(app.appId);
    addMessage('assistant', 'Opened ' + result.name + '.');
  } catch (error) {
    addMessage('assistant', error.message || 'I could not open that app.');
  }
}

function helpText() {
  return 'Dexter Local runs without a paid account or cloud AI. Try:\n\n• list apps / open app Notepad\n• open folder / screenshot\n• read clipboard / copy to clipboard: your text\n• battery status / list running apps / list monitors\n• focus settings / lock computer / turn displays off\n• open calendar / read calendar (.ics) / play music\n• show commands / show routines / show integrations / show analytics\n• what time is it (Africa/Lagos)\n\nOther features: coding and everyday laptop help, local music, custom command shortcuts, routines, local activity totals, optional OBS controls, speech settings for Nigerian English or Igbo, personal transcript corrections, an always-on-top quick panel, and optional local Ollama chat. See the tabs in the sidebar.';
}

function normalizeEverydayCommand(text) {
  const original = String(text || '').trim();
  const phrase = original.toLocaleLowerCase().replace(/[.!?]+$/g, '').trim();
  const dialectCommands = new Map([
    ['wetin dey run', 'list running apps'],
    ['wetin dey happen', 'list running apps'],
    ['wetin time e be', 'what time is it'],
    ['wetin be the time', 'what time is it'],
    ['battery dey how', 'battery status'],
    ['how far battery', 'battery status'],
  ]);
  if (dialectCommands.has(phrase)) return dialectCommands.get(phrase);
  return original
    .replace(/^(?:(?:abeg|biko|please|kindly)\s+)+/i, '')
    .replace(/\s+(?:(?:abeg|biko|please|kindly))[.!?]*$/i, '')
    .trim();
}

async function runDesktopCommand(text) {
  const clean = normalizeEverydayCommand(text);
  const normalized = clean.toLocaleLowerCase();

  if (window.dexterFeatures) {
    const alias = window.dexterFeatures.resolveAlias(text.trim()) || window.dexterFeatures.resolveAlias(clean);
    if (alias) return runDesktopCommand(alias);
    const extended = await window.dexterFeatures.runCommand(clean);
    if (extended !== null && extended !== undefined) return extended;
  }

  if (/^(?:find|show|list|open)\s+(?:(?:my|a)\s+)?(?:code|coding)\s+(?:editor|apps?|tools?)[.!? ]*$/i.test(clean)) {
    state.appMode = 'coding';
    appSearch.value = '';
    await refreshApps();
    setView('apps');
    const codingApp = /(visual studio|vs code|vscode|cursor|codeium|intellij|pycharm|webstorm|rider|eclipse|sublime text|notepad\+\+|windows terminal|terminal|powershell)/i;
    const count = state.apps.filter((app) => codingApp.test(app.name)).length;
    return count ? 'I found ' + count + ' likely coding app' + (count === 1 ? '' : 's') + ' in your Start menu. Choose the one you use.' : 'I could not identify a code editor by name. I opened the installed-app list so you can search for yours.';
  }
  if (/^(help|commands?|what can you do)[.!? ]*$/.test(normalized)) return helpText();
  if (/\b(?:what time is it|current time|what's the time)\b/.test(normalized)) {
    return 'It is ' + new Intl.DateTimeFormat('en-NG', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Africa/Lagos' }).format(new Date()) + ' in Nigeria (WAT).';
  }
  if (/\b(?:list|show|find)\b.*\b(?:installed )?apps?\b/.test(normalized) || normalized === 'apps') {
    await refreshApps();
    setView('apps');
    return 'I loaded your Windows Start menu apps. Search the list and press Open beside an app.';
  }
  if (/^(?:open|show)\s+(?:(?:a|the)\s+)?folder\s*[.!?]*$/i.test(clean)) {
    const result = await window.dexter.chooseAndOpenFolder();
    return result.canceled ? 'Folder selection canceled.' : 'Opened the folder you chose in File Explorer.';
  }
  if (/\b(?:screenshot|capture (?:the )?screen|take (?:a )?screenshot)\b/i.test(clean)) {
    const result = await window.dexter.saveScreenshot();
    return result.canceled ? 'Screenshot canceled.' : 'Saved your screenshot to the location you selected.';
  }
  if (/^(?:read|show|what(?:'s| is) in)\s+(?:my\s+)?clipboard[?!. ]*$/i.test(clean)) {
    const clipboardText = await window.dexter.readClipboard();
    if (!clipboardText) return 'Your clipboard is empty.';
    return clipboardText.length > 8000 ? clipboardText.slice(0, 8000) + '\n\n[Showing the first 8,000 characters.]' : clipboardText;
  }
  const copyMatch = clean.match(/^(?:copy|put)\s+(?:to\s+)?clipboard\s*:?\s*([\s\S]+)$/i);
  if (copyMatch) {
    await window.dexter.writeClipboard(copyMatch[1]);
    return 'Copied that text to your Windows clipboard.';
  }
  const openMatch = clean.match(/^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?(?:app\s+)?(.+?)\s*[.!?]*$/i);
  if (openMatch && normalizeName(openMatch[1]) !== 'folder') {
    const apps = state.apps.length ? state.apps : await window.dexter.listInstalledApps();
    state.apps = apps;
    const requested = normalizeName(openMatch[1]);
    const exactMatches = apps.filter((app) => normalizeName(app.name) === requested);
    if (exactMatches.length === 1) {
      const result = await window.dexter.openInstalledApp(exactMatches[0].appId);
      return 'Opened ' + result.name + '.';
    }
    appSearch.value = openMatch[1].trim();
    setView('apps');
    renderApps();
    if (exactMatches.length > 1) return 'There is more than one exact match. Choose the right app from the filtered list.';
    return 'I could not find an exact app name. Here are the closest matches; choose one to open it.';
  }
  return null;
}

async function sendMessage(text) {
  const content = String(text || '').trim();
  if (!content || state.busy) return;
  const commandText = normalizeEverydayCommand(content);
  const sensitiveUserCommand = /^read calendar$|^(?:list|show) running apps$/i.test(commandText) || /^(?:read|show|what(?:'s| is) in)\s+(?:my\s+)?clipboard|^(?:copy|put)\s+(?:to\s+)?clipboard\b/i.test(commandText);
  addMessage('user', content, { sensitive: sensitiveUserCommand });
  chatInput.value = '';
  chatInput.style.height = 'auto';
  setBusy(true);
  try {
    const commandResult = await runDesktopCommand(commandText);
    if (commandResult !== null) {
      if (window.dexterFeatures) window.dexterFeatures.recordAction('command', 'Desktop action');
      const sensitive = /^read calendar$|^(?:list|show) running apps$/i.test(commandText) || (/^(?:read|show|what(?:'s| is) in)\s+(?:my\s+)?clipboard/i.test(commandText) && commandResult !== 'Your clipboard is empty.');
      addMessage('assistant', commandResult, { sensitive });
    } else if (state.useLocalModel && state.model.trim()) {
      const history = state.messages
        .filter((message) => !message.sensitive && ['user', 'assistant'].includes(message.role))
        .slice(-18)
        .map(({ role, content: messageContent }) => ({ role, content: messageContent }));
      const assistantStyle = window.dexterFeatures ? window.dexterFeatures.getAssistantStyle() : 'nigerian-igbo';
      const answer = await window.dexter.askLocalModel({ model: state.model.trim(), messages: history, assistantStyle });
      addMessage('assistant', answer);
    } else if (state.useLocalModel) {
      addMessage('assistant', 'Add the name of a model already installed in Ollama in Settings, then try again.');
    } else {
      addMessage('assistant', 'I can do desktop commands offline. For open-ended chat, enable a local model in Settings. Your message was not sent to a cloud service. Type “help” to see the commands.');
    }
  } catch (error) {
    addMessage('assistant', error.message || 'Something went wrong while handling that request.');
  } finally {
    setBusy(false);
    chatInput.focus();
  }
}

document.querySelectorAll('.nav-button').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

document.querySelectorAll('.prompt-card').forEach((button) => {
  button.addEventListener('click', () => sendMessage(button.dataset.prompt));
});

$('#new-chat').addEventListener('click', () => {
  state.messages = [];
  saveMessages();
  renderMessages();
  setView('assistant');
  chatInput.focus();
});

function clearChat() {
  if (!window.confirm('Clear the conversation saved on this device?')) return;
  state.messages = [];
  saveMessages();
  renderMessages();
}

$('#clear-chat').addEventListener('click', clearChat);
$('#clear-chat-settings').addEventListener('click', clearChat);

$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(chatInput.value);
});

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage(chatInput.value);
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault();
    setView('apps');
    appSearch.focus();
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
});

$('#refresh-apps').addEventListener('click', refreshApps);
appSearch.addEventListener('input', () => { state.appMode = 'all'; renderApps(); });
$('#show-all-apps').addEventListener('click', () => { state.appMode = 'all'; appSearch.value = ''; renderApps(); });

$('#local-ai-enabled').checked = state.useLocalModel;
$('#model-name').value = state.model;
$('#speak-replies').checked = state.speakReplies;
$('#local-ai-enabled').addEventListener('change', (event) => { state.useLocalModel = event.target.checked; saveSettings(); });
$('#model-name').addEventListener('input', (event) => { state.model = event.target.value.trim(); saveSettings(); });
$('#speak-replies').addEventListener('change', (event) => { state.speakReplies = event.target.checked; saveSettings(); });

window.dexterUI = Object.freeze({ sendMessage, addMessage, setView, refreshApps, runDesktopCommand });
window.dexter.onOverlayCommand((command) => sendMessage(command));

renderMessages();
window.dexter.getVersion().then((version) => { $('#version-label').textContent = 'Version ' + version; }).catch(() => {});
