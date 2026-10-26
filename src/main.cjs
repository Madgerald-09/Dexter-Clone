'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const execFileAsync = promisify(execFile);
let mainWindow = null;

function assertTrustedRenderer(event) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
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
          content: 'You are Dexter Local, a helpful personal desktop assistant. You run on the user’s own computer. Never claim that you performed a computer action. This chat cannot run tools or commands. For desktop actions, explain that the user can use the built-in commands: list apps, open app <name>, open folder, screenshot, read clipboard, or copy to clipboard <text>.',
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

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.madgerald.dexter-local');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
