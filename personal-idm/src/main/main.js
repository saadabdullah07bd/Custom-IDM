import { app, BrowserWindow, Menu, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueueManager } from '../engine/queueManager.js';
import { startLocalServer } from '../bridge/localServer.js';
import { probeUrl, getCategoryByFilename, getCategoryFolderName, calculateOptimalConnections } from '../engine/downloader.js';

// Disable default OS / Chromium menubar completely (No "File Edit View Window")
Menu.setApplicationMenu(null);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
const progressWindows = new Map(); // taskId -> BrowserWindow
const downloadInfoWindows = new Map(); // taskId -> BrowserWindow
const queueManager = new QueueManager();

let activeServerPort = 1001;

function forwardToAll(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  for (const win of progressWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
  for (const win of downloadInfoWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function openDownloadInfoWindow(taskId) {
  if (!taskId) return;
  if (downloadInfoWindows.has(taskId)) {
    const existing = downloadInfoWindows.get(taskId);
    if (!existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    downloadInfoWindows.delete(taskId);
  }

  const task = queueManager.getTask(taskId);
  const win = new BrowserWindow({
    width: 500,
    height: 380,
    minWidth: 460,
    minHeight: 330,
    frame: false,
    titleBarStyle: 'hidden',
    resizable: true,
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, '../renderer/download-info.html'), {
    query: { taskId }
  });

  downloadInfoWindows.set(taskId, win);

  win.on('closed', () => {
    downloadInfoWindows.delete(taskId);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 680,
    minWidth: 840,
    minHeight: 500,
    frame: false, // 100% custom titlebar, no OS window frame
    titleBarStyle: 'hidden',
    title: 'Personal IDM',
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Forward queueManager events
  queueManager.on('task-added', (task) => {
    forwardToAll('task-added', task);
    // When a download is added as pending (e.g. from extension), open the IDM Download File Info permission window!
    // The main app window stays untouched and does NOT pop open!
    if (task.status === 'pending') {
      openDownloadInfoWindow(task.id);
    }
  });
  queueManager.on('task-updated', (task) => forwardToAll('task-updated', task));
  queueManager.on('task-completed', (task) => forwardToAll('task-completed', task));
  queueManager.on('task-deleted', (id) => forwardToAll('task-deleted', id));
  queueManager.on('task-error', (err) => forwardToAll('task-error', err));
  queueManager.on('settings-updated', (settings) => forwardToAll('settings-updated', settings));
}

// Window Control IPC Handlers
ipcMain.handle('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.handle('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});

ipcMain.handle('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// IPC Handlers
ipcMain.handle('get-tasks', () => queueManager.getAllTasks());

ipcMain.handle('get-task-by-id', (_event, taskId) => {
  const task = queueManager.getTask(taskId);
  return task ? task.toJSON() : null;
});

ipcMain.handle('add-download', async (_event, options) => {
  return await queueManager.addTask(options);
});

ipcMain.handle('start-download-now', (_event, taskId) => {
  queueManager.startTask(taskId);
  return true;
});

ipcMain.handle('open-download-info', (_event, taskId) => {
  openDownloadInfoWindow(taskId);
  return true;
});

ipcMain.handle('open-progress-window', (_event, taskId) => {
  if (!taskId) return false;
  if (progressWindows.has(taskId)) {
    const existing = progressWindows.get(taskId);
    if (!existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return true;
    }
    progressWindows.delete(taskId);
  }

  const task = queueManager.getTask(taskId);
  const win = new BrowserWindow({
    width: 540,
    height: 400,
    minWidth: 460,
    minHeight: 340,
    frame: false,
    titleBarStyle: 'hidden',
    title: task ? `${task.filename || 'Download'} - Internet Download Manager` : 'Download Progress',
    resizable: true,
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, '../renderer/progress.html'), {
    query: { taskId }
  });

  progressWindows.set(taskId, win);

  win.on('closed', () => {
    progressWindows.delete(taskId);
  });

  return true;
});

ipcMain.handle('probe-url', async (_event, url) => {
  const probe = await probeUrl(url);
  const category = getCategoryByFilename(probe.filename);
  const catFolder = getCategoryFolderName(category);
  const suggestedDir = path.join(queueManager.defaultDownloadDir, catFolder);
  return {
    url,
    finalUrl: probe.finalUrl,
    filename: probe.filename,
    totalBytes: probe.contentLength,
    acceptRanges: probe.acceptRanges,
    resumable: probe.acceptRanges,
    etag: probe.etag,
    lastModified: probe.lastModified,
    category,
    categoryFolder: catFolder,
    suggestedDir,
    optimalConnections: calculateOptimalConnections(probe.contentLength, probe.acceptRanges)
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
  const targetWin = mainWindow || BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(targetWin, {
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
