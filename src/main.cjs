'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const execFileAsync = promisify(execFile);
let mainWindow = null;
let overlayWindow = null;
const trustedWebContents = new Set();

function assertTrustedRenderer(event) {
  if (
    !trustedWebContents.has(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('This request did not come from Dexter Local.');
  }
}

function register(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedRenderer(event);
    return handler(...args);
  });
}

async function listInstalledApps() {
  if (process.platform !== 'win32') {
    throw new Error('Installed-app discovery is currently available on Windows.');
  }

  const script = "$ErrorActionPreference='Stop'; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 4 * 1024 * 1024 },
  );
  const output = stdout.replace(/^\uFEFF/, '').trim();
  if (!output) return [];

  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const unique = new Map();
  for (const row of rows) {
    const name = typeof row.Name === 'string' ? row.Name.trim() : '';
    const appId = typeof row.AppID === 'string' ? row.AppID.trim() : '';
    if (name && appId && !unique.has(appId)) unique.set(appId, { name, appId });
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

register('apps:list', listInstalledApps);

register('apps:open', async (appId) => {
  if (typeof appId !== 'string' || appId.length > 512) {
    throw new Error('Choose an app from the installed-app list.');
  }
  const appInfo = (await listInstalledApps()).find((item) => item.appId === appId);
  if (!appInfo) throw new Error('That app is no longer in the installed-app list. Refresh and try again.');

  const child = spawn('explorer.exe', ['shell:AppsFolder\\' + appInfo.appId], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', (error) => console.error('Could not open installed app:', error.message));
  child.unref();
  return { name: appInfo.name };
});

register('folder:choose-and-open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder to open',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const error = await shell.openPath(result.filePaths[0]);
  if (error) throw new Error(error);
  return { opened: true };
});

register('calendar:read-local-file', async () => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a local iCalendar file',
    properties: ['openFile'],
    filters: [{ name: 'iCalendar files', extensions: ['ics'] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true, events: [] };
  const filePath = selection.filePaths[0];
  const stat = await fs.stat(filePath);
  if (stat.size > 5 * 1024 * 1024) throw new Error('Calendar file is larger than 5 MB.');
  const source = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  const unfolded = source.split(/\r?\n/).reduce((lines, line) => {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
    return lines;
  }, []);
  const events = [];
  let current = null;
  for (const line of unfolded) {
    if (line.toUpperCase() === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line.toUpperCase() === 'END:VEVENT') {
      if (current && current.start) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const property = line.slice(0, separator).split(';')[0].toUpperCase();
    const value = line.slice(separator + 1).replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    if (property === 'SUMMARY') current.title = value.slice(0, 500);
    if (property === 'LOCATION') current.location = value.slice(0, 500);
    if (property === 'DTSTART') {
      const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
      if (match) {
        const year = Number(match[1]), month = Number(match[2]) - 1, day = Number(match[3]);
        current.allDay = !match[4];
        current.start = match[4]
          ? (match[7] ? new Date(Date.UTC(year, month, day, Number(match[4]), Number(match[5]), Number(match[6] || 0))) : new Date(year, month, day, Number(match[4]), Number(match[5]), Number(match[6] || 0)))
          : new Date(year, month, day);
      }
    }
  }
  const now = new Date();
  const upcoming = events
    .filter((event) => event.start instanceof Date && !Number.isNaN(event.start.valueOf()) && event.start >= now)
    .sort((a, b) => a.start - b.start)
    .slice(0, 12)
    .map((event) => ({ title: event.title || 'Untitled event', start: event.start.toISOString(), allDay: event.allDay === true, location: event.location || '' }));
  return { canceled: false, events: upcoming };
});

register('clipboard:read', async () => clipboard.readText());

register('clipboard:write', async (text) => {
  if (typeof text !== 'string' || text.length > 50000) {
    throw new Error('Clipboard text must be shorter than 50,000 characters.');
  }
  clipboard.writeText(text);
  return { copied: true };
});

register('screen:save', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
    fetchWindowIcons: false,
  });
  if (!sources.length) throw new Error('Windows did not provide a screen capture source.');

  const primaryDisplayId = String(screen.getPrimaryDisplay().id);
  const source = sources.find((item) => String(item.display_id) === primaryDisplayId) || sources[0];
  if (!source.thumbnail || source.thumbnail.isEmpty()) throw new Error('The screenshot was empty.');
  const image = nativeImage.createFromBuffer(source.thumbnail.toPNG());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save screenshot',
    defaultPath: path.join(app.getPath('pictures'), 'Dexter-' + timestamp + '.png'),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  await fs.writeFile(result.filePath, image.toPNG());
  return { saved: true, filePath: result.filePath };
});

register('local-model:chat', async (request) => {
  if (!request || typeof request !== 'object') throw new Error('Enter a local model name first.');
  const model = typeof request.model === 'string' ? request.model.trim() : '';
  if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) {
    throw new Error('Use the model name shown by your local Ollama installation.');
  }
  if (!Array.isArray(request.messages) || request.messages.length > 24) {
    throw new Error('The local chat history is invalid.');
  }

  const messages = request.messages.map((message) => {
    if (
      !message ||
      !['user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string' ||
      message.content.length > 6000
    ) {
      throw new Error('A chat message is too long or has an unsupported role.');
    }
    return { role: message.role, content: message.content };
  });

  const assistantStyles = {
    'nigerian-igbo': 'You are helping an everyday Windows laptop user in Nigeria who is Igbo and codes. Give practical help with programming and normal laptop use. Use clear, natural Nigerian English, understand Nigerian expressions and English/Igbo code-switching when you can, and answer in Igbo only when you are confident. Do not imitate an accent, force slang, or invent Igbo translations; ask when a phrase is unclear. Do not assume the user streams. Use Africa/Lagos when answering local time questions.',
    'plain-english': 'Use clear, straightforward English and focus on practical programming and everyday Windows laptop tasks.',
    'english-uk': 'Use clear English with UK spelling and phrasing. Focus on practical programming and everyday Windows laptop tasks.',
    'english-us': 'Use clear English with US spelling and phrasing. Focus on practical programming and everyday Windows laptop tasks.',
  };
  const assistantStyle = typeof request.assistantStyle === 'string' && assistantStyles[request.assistantStyle]
    ? assistantStyles[request.assistantStyle]
    : assistantStyles['nigerian-igbo'];

  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(90000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'You are Dexter Local, a helpful personal desktop assistant. ' + assistantStyle + ' You run on the user’s own computer. Never claim that you performed a computer action. This chat cannot run tools or commands. For desktop actions, explain that the user can use the built-in commands: list apps, open app <name>, open folder, screenshot, read clipboard, or copy to clipboard <text>.',
        },
        ...messages,
      ],
    }),
  });

  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error('The local model returned an unusually large response.');
  if (!response.ok) {
    throw new Error('Ollama returned HTTP ' + response.status + '. Check that the model is installed and Ollama is running.');
  }
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error('Ollama returned a response Dexter Local could not read.');
  }
  const content = result && result.message && result.message.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('The local model returned an empty answer.');
  return content.slice(0, 20000);
});

register('app:version', async () => app.getVersion());
register('app:open-project', async () => {
  await shell.openExternal('https://github.com/Madgerald-09/Dexter-Clone');
  return { opened: true };
});
register('diagnostics:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export private diagnostics',
    defaultPath: path.join(app.getPath('documents'), 'dexter-local-diagnostics.json'),
    filters: [{ name: 'JSON file', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const report = {
    app: 'Dexter Local',
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    release: require('node:os').release(),
    generatedAt: new Date().toISOString(),
    included: 'Runtime version and platform only. Chat, clipboard, filenames, passwords, and account data are not included.',
  };
  await fs.writeFile(result.filePath, JSON.stringify(report, null, 2), 'utf8');
  return { saved: true, filePath: result.filePath };
});

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 4 * 1024 * 1024 },
  );
  const output = stdout.replace(/^\uFEFF/, '').trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

register('system:query', async (kind) => {
  if (process.platform !== 'win32') throw new Error('Windows system status is not available on this platform.');
  if (kind === 'running-apps') {
    const rows = await runPowerShell("$ErrorActionPreference='Stop'; Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 100 ProcessName,Id,MainWindowTitle | ConvertTo-Json -Compress");
    return rows.map((row) => ({ name: String(row.ProcessName || ''), pid: Number(row.Id) || 0, title: String(row.MainWindowTitle || '') }));
  }
  if (kind === 'monitors') {
    const rows = await runPowerShell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Select-Object DeviceName,Primary,@{Name='Width';Expression={$_.Bounds.Width}},@{Name='Height';Expression={$_.Bounds.Height}} | ConvertTo-Json -Compress");
    return rows.map((row) => ({ name: String(row.DeviceName || 'Display'), primary: row.Primary === true || String(row.Primary).toLocaleLowerCase() === 'true', width: Number(row.Width) || 0, height: Number(row.Height) || 0 }));
  }
  if (kind === 'battery') {
    const rows = await runPowerShell("$ErrorActionPreference='Stop'; Get-CimInstance Win32_Battery | Select-Object Name,EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress");
    return rows.map((row) => ({ name: String(row.Name || 'Battery'), percent: Number(row.EstimatedChargeRemaining), status: Number(row.BatteryStatus) }));
  }
  throw new Error('Unknown system information request.');
});

register('system:action', async (action) => {
  if (process.platform !== 'win32') throw new Error('This Windows system action is not available on this platform.');
  if (action === 'notifications') {
    await shell.openExternal('ms-settings:notifications');
    return { opened: true };
  }
  if (action === 'lock') {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Lock this computer?',
      message: 'This will lock your Windows session immediately.',
      buttons: ['Cancel', 'Lock now'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) return { canceled: true };
    const child = spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', (error) => console.error('Could not lock Windows:', error.message));
    child.unref();
    return { locked: true };
  }
  if (action === 'display-off') {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Turn off your displays?',
      message: 'Windows will turn off connected monitors. Move your mouse or press a key to wake them.',
      buttons: ['Cancel', 'Turn displays off'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) return { canceled: true };
    const script = "$signature='[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern System.IntPtr SendMessage(System.IntPtr hWnd, uint msg, System.IntPtr wParam, System.IntPtr lParam);'; Add-Type -Namespace DexterLocal -Name DisplayControl -MemberDefinition $signature; [DexterLocal.DisplayControl]::SendMessage([System.IntPtr]::new(65535), 274, [System.IntPtr]::new(61808), [System.IntPtr]::new(2)) | Out-Null";
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 });
    return { turnedOff: true };
  }
  throw new Error('Unknown system action.');
});

class ObsWebSocketClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.pending = new Map();
    this.connectResolve = null;
    this.connectReject = null;
    this.connectTimer = null;
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.connectReject) this.connectReject(new Error('OBS connection closed.'));
    this.connectResolve = null;
    this.connectReject = null;
    this.pendingPassword = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('OBS connection closed.'));
    }
    this.pending.clear();
    if (socket && socket.readyState < 2) socket.close();
  }

  connect(port, password) {
    this.disconnect();
    if (typeof WebSocket === 'undefined') throw new Error('This Electron runtime does not include a WebSocket client.');
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw new Error('Enter a valid OBS WebSocket port.');
    if (typeof password !== 'string' || password.length > 256) throw new Error('OBS password is too long.');
    this.pendingPassword = password;

    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = setTimeout(() => {
        const fail = this.connectReject;
        this.connectReject = null;
        this.connectResolve = null;
        this.disconnect();
        (fail || reject)(new Error('OBS did not identify within 8 seconds. Check the port, password, and WebSocket server setting.'));
      }, 8000);
      try {
        this.socket = new WebSocket('ws://127.0.0.1:' + numericPort, 'obswebsocket.json');
      } catch (error) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.connectResolve = null;
        this.connectReject = null;
        reject(new Error('Could not connect to OBS: ' + error.message));
        return;
      }
      this.socket.addEventListener('message', (event) => this.receive(event.data));
      this.socket.addEventListener('error', () => {
        if (!this.connected && this.connectReject) {
          const fail = this.connectReject;
          this.connectReject = null;
          this.connectResolve = null;
          if (this.connectTimer) clearTimeout(this.connectTimer);
          this.connectTimer = null;
          this.disconnect();
          fail(new Error('Could not reach OBS on 127.0.0.1:' + numericPort + '.'));
        }
      });
      this.socket.addEventListener('close', () => {
        this.connected = false;
        if (this.connectReject) {
          const fail = this.connectReject;
          this.connectReject = null;
          this.connectResolve = null;
          if (this.connectTimer) clearTimeout(this.connectTimer);
          this.connectTimer = null;
          fail(new Error('OBS closed the connection. Check its WebSocket settings and password.'));
        }
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('OBS connection was closed.'));
        }
        this.pending.clear();
      });
    });
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      this.disconnect();
      return;
    }
    const data = message && message.d ? message.d : {};
    if (message.op === 0) {
      let authentication;
      if (data.authentication) {
        const password = this.pendingPassword;
        if (typeof password !== 'string') {
          this.disconnect();
          return;
        }
        const secret = createHash('sha256').update(password + data.authentication.salt).digest('base64');
        authentication = createHash('sha256').update(secret + data.authentication.challenge).digest('base64');
      }
      const identify = { rpcVersion: Math.min(Number(data.rpcVersion) || 1, 1), eventSubscriptions: 0 };
      if (authentication) identify.authentication = authentication;
      this.socket.send(JSON.stringify({ op: 1, d: identify }));
      return;
    }
    if (message.op === 2) {
      this.connected = true;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      const resolve = this.connectResolve;
      this.connectResolve = null;
      this.connectReject = null;
      this.pendingPassword = null;
      if (resolve) resolve({ connected: true });
      return;
    }
    if (message.op === 7 && data.requestId && this.pending.has(data.requestId)) {
      const entry = this.pending.get(data.requestId);
      this.pending.delete(data.requestId);
      clearTimeout(entry.timer);
      if (data.requestStatus && data.requestStatus.result) entry.resolve(data.responseData || {});
      else entry.reject(new Error((data.requestStatus && data.requestStatus.comment) || 'OBS rejected that request.'));
    }
  }

  request(requestType, requestData = {}) {
    if (!this.connected || !this.socket || this.socket.readyState !== 1) return Promise.reject(new Error('Connect to OBS first.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('OBS request timed out: ' + requestType));
      }, 8000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
}

const obs = new ObsWebSocketClient();

register('obs:connect', async (request) => {
  if (!request || typeof request !== 'object') throw new Error('Enter the OBS WebSocket port and password.');
  try {
    return await obs.connect(request.port, typeof request.password === 'string' ? request.password : '');
  } catch (error) {
    obs.pendingPassword = null;
    throw error;
  }
});
register('obs:disconnect', async () => { obs.disconnect(); return { connected: false }; });
register('obs:status', async () => {
  if (!obs.connected) return { connected: false };
  const [version, scenes, stream, recording, inputs] = await Promise.all([
    obs.request('GetVersion'),
    obs.request('GetSceneList'),
    obs.request('GetStreamStatus'),
    obs.request('GetRecordStatus'),
    obs.request('GetInputList'),
  ]);
  const audioInputs = Array.isArray(inputs.inputs) ? inputs.inputs.slice(0, 32) : [];
  const muteStates = await Promise.all(audioInputs.map((input) => obs.request('GetInputMute', { inputName: input.inputName }).catch(() => ({ inputMuted: false }))));
  return {
    connected: true,
    obsVersion: version.obsVersion || '',
    websocketVersion: version.obsWebSocketVersion || '',
    scenes: Array.isArray(scenes.scenes) ? scenes.scenes.map((scene) => String(scene.sceneName || '')).filter(Boolean) : [],
    currentScene: String(scenes.currentProgramSceneName || ''),
    streaming: stream.outputActive === true,
    recording: recording.outputActive === true,
    inputs: audioInputs.map((input, index) => ({ name: String(input.inputName || ''), kind: String(input.inputKind || ''), muted: muteStates[index].inputMuted === true })).filter((input) => input.name),
  };
});
register('obs:scene', async (sceneName) => {
  if (typeof sceneName !== 'string' || sceneName.length > 256) throw new Error('Choose a scene from OBS.');
  const scenes = await obs.request('GetSceneList');
  const scene = Array.isArray(scenes.scenes) && scenes.scenes.find((item) => item.sceneName === sceneName);
  if (!scene) throw new Error('That scene is not in the current OBS scene list.');
  await obs.request('SetCurrentProgramScene', { sceneName });
  return { sceneName };
});
register('obs:toggle-output', async (kind, active) => {
  if (!['stream', 'record'].includes(kind) || typeof active !== 'boolean') throw new Error('Choose a valid OBS output action.');
  const requestType = kind === 'stream' ? (active ? 'StartStream' : 'StopStream') : (active ? 'StartRecord' : 'StopRecord');
  await obs.request(requestType);
  return { kind, active };
});
register('obs:toggle-mute', async (inputName, muted) => {
  if (typeof inputName !== 'string' || inputName.length > 256 || typeof muted !== 'boolean') throw new Error('Choose a valid OBS audio input.');
  const inputs = await obs.request('GetInputList');
  if (!Array.isArray(inputs.inputs) || !inputs.inputs.some((input) => input.inputName === inputName)) throw new Error('That input is no longer in the OBS input list.');
  await obs.request('SetInputMute', { inputName, inputMuted: muted });
  return { inputName, muted };
});

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.focus();
    return;
  }
  overlayWindow = new BrowserWindow({
    width: 390,
    height: 385,
    minWidth: 340,
    minHeight: 280,
    title: 'Dexter Quick Panel',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  trustedWebContents.add(overlayWindow.webContents);
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  overlayWindow.on('closed', () => {
    if (overlayWindow) trustedWebContents.delete(overlayWindow.webContents);
    overlayWindow = null;
  });
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
}

register('overlay:toggle', async () => {
  if (overlayWindow && overlayWindow.isVisible()) overlayWindow.hide();
  else createOverlayWindow();
  return { visible: Boolean(overlayWindow && overlayWindow.isVisible()) };
});
register('overlay:close', async () => {
  if (overlayWindow) overlayWindow.hide();
  return { closed: true };
});
register('window:focus-main', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return { focused: true };
});
register('overlay:command', async (command) => {
  const allowed = new Set(['list apps', 'find my code editor', 'open folder', 'screenshot', 'help']);
  if (typeof command !== 'string' || !allowed.has(command)) throw new Error('That quick action is not available.');
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('overlay:command', command);
  return { sent: true };
});

function toggleOverlay() {
  if (overlayWindow && overlayWindow.isVisible()) overlayWindow.hide();
  else createOverlayWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1117',
    title: 'Dexter Local',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  trustedWebContents.add(mainWindow.webContents);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => {
    if (mainWindow) trustedWebContents.delete(mainWindow.webContents);
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.madgerald.dexter-local');
  createWindow();
  globalShortcut.register('Control+Shift+O', toggleOverlay);
  globalShortcut.register('Control+Shift+Space', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice:toggle');
    else createWindow();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
