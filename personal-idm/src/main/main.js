import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueueManager } from '../engine/queueManager.js';
import { startLocalServer } from '../bridge/localServer.js';
import { probeUrl, getCategoryByFilename } from '../engine/downloader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
const queueManager = new QueueManager();

let activeServerPort = 1001;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 680,
    minWidth: 840,
    minHeight: 500,
    title: 'Personal IDM (Internet Download Manager)',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Forward queueManager events to renderer window
  queueManager.on('task-added', (task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task-added', task);
    }
  });

  queueManager.on('task-updated', (task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task-updated', task);
    }
  });

  queueManager.on('task-completed', (task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task-completed', task);
    }
  });

  queueManager.on('task-deleted', (id) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task-deleted', id);
    }
  });

  queueManager.on('task-error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task-error', err);
    }
  });

  queueManager.on('settings-updated', (settings) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings-updated', settings);
    }
  });
}

// IPC Handlers
ipcMain.handle('get-tasks', () => queueManager.getAllTasks());

ipcMain.handle('add-download', async (_event, options) => {
  return await queueManager.addTask(options);
});

ipcMain.handle('probe-url', async (_event, url) => {
  const probe = await probeUrl(url);
  return {
    url,
    finalUrl: probe.finalUrl,
    filename: probe.filename,
    totalBytes: probe.contentLength,
    acceptRanges: probe.acceptRanges,
    resumable: probe.acceptRanges,
    etag: probe.etag,
    lastModified: probe.lastModified,
    category: getCategoryByFilename(probe.filename)
  };
});

ipcMain.handle('pause-download', async (_event, id) => {
  await queueManager.pauseTask(id);
  return true;
});

ipcMain.handle('resume-download', (_event, id) => {
  queueManager.resumeTask(id);
  return true;
});

ipcMain.handle('delete-download', async (_event, id, deleteFile, retainPartial) => {
  await queueManager.deleteTask(id, deleteFile, retainPartial);
  return true;
});

ipcMain.handle('pause-all', async () => {
  await queueManager.pauseAll();
  return true;
});

ipcMain.handle('resume-all', () => {
  queueManager.resumeAll();
  return true;
});

ipcMain.handle('get-default-dir', () => queueManager.defaultDownloadDir);
ipcMain.handle('get-server-port', () => activeServerPort);
ipcMain.handle('get-settings', () => queueManager.getSettings());
ipcMain.handle('save-settings', (_event, settings) => queueManager.updateSettings(settings));

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('open-file', async (_event, targetPath) => {
  if (targetPath) {
    await shell.openPath(targetPath);
  }
});

ipcMain.handle('show-in-folder', (_event, targetPath) => {
  if (targetPath) {
    shell.showItemInFolder(targetPath);
  }
});

app.whenReady().then(() => {
  const server = startLocalServer(queueManager, 1001);
  server.on('listening', () => {
    activeServerPort = server.address().port;
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
