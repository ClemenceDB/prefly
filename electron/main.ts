import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isMac = process.platform === 'darwin';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
const pendingFiles: string[] = [];

function appRoot(): string {
  return path.join(app.getAppPath(), 'dist');
}

function registerProtocol(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const root = appRoot();
    const resolved = path.normalize(path.join(root, pathname));
    if (!resolved.startsWith(root)) return new Response('Forbidden', { status: 403 });
    try {
      return await net.fetch(pathToFileURL(resolved).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

async function ensureUnique(target: string): Promise<string> {
  let candidate = target;
  const parsed = path.parse(target);
  let index = 2;
  for (;;) {
    try {
      await fs.access(candidate);
      candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

async function readPdfFiles(paths: string[]) {
  const files = [];
  for (const filePath of paths) {
    try {
      if (!/\.pdf$/i.test(filePath)) continue;
      const buffer = await fs.readFile(filePath);
      files.push({
        name: path.basename(filePath),
        path: filePath,
        data: new Uint8Array(buffer),
      });
    } catch {
      /* unreadable file: ignored */
    }
  }
  return files;
}

function sendFiles(paths: string[]) {
  if (!paths.length) return;
  void readPdfFiles(paths).then((files) => {
    if (files.length && mainWindow) mainWindow.webContents.send('prefly:files', files);
  });
}

function collectArgvFiles(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-') && /\.pdf$/i.test(arg))
    .map((arg) => path.resolve(arg));
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: dark ? '#0E0E0D' : '#F5F4F0',
    title: 'Pré-fly',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 20 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (pendingFiles.length) {
      sendFiles(pendingFiles.splice(0, pendingFiles.length));
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    event.preventDefault();
  });

  if (DEV_URL) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadURL('app://prefly/app/index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu(): void {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'Fichier',
      submenu: [
        {
          label: 'Ouvrir des PDF…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            if (!mainWindow) return;
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: 'PDF', extensions: ['pdf'] }],
            });
            if (!result.canceled) sendFiles(result.filePaths);
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const files = collectArgvFiles(argv);
    if (files.length) sendFiles(files);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (mainWindow) sendFiles([filePath]);
    else pendingFiles.push(filePath);
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId('fr.esad.prefly');
    registerProtocol();
    buildMenu();
    createWindow();
    const initial = collectArgvFiles(process.argv);
    if (initial.length) {
      if (mainWindow?.webContents.isLoading()) pendingFiles.push(...initial);
      else sendFiles(initial);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  ipcMain.handle('prefly:save-beside', async (_event, sourcePath: string, name: string, bytes: Uint8Array) => {
    try {
      const directory = sourcePath ? path.dirname(sourcePath) : app.getPath('downloads');
      const safeName = name.replace(/[/\\:*?"<>|]/g, '-');
      const target = await ensureUnique(path.join(directory, safeName));
      await fs.writeFile(target, Buffer.from(bytes));
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('prefly:save-as', async (_event, name: string, bytes: Uint8Array) => {
    try {
      if (!mainWindow) return { ok: false, error: 'Fenêtre indisponible' };
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(app.getPath('downloads'), name),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, error: 'Annulé' };
      await fs.writeFile(result.filePath, Buffer.from(bytes));
      return { ok: true, path: result.filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('prefly:open-files', async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled) return [];
    return readPdfFiles(result.filePaths);
  });

  ipcMain.on('prefly:reveal', (_event, target: string) => {
    if (target) shell.showItemInFolder(target);
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}

