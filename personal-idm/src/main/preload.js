const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  getTaskById: (taskId) => ipcRenderer.invoke('get-task-by-id', taskId),
  openProgressWindow: (taskId) => ipcRenderer.invoke('open-progress-window', taskId),
  addDownload: (options) => ipcRenderer.invoke('add-download', options),
  probeUrl: (url) => ipcRenderer.invoke('probe-url', url),
  pauseDownload: (id) => ipcRenderer.invoke('pause-download', id),
  resumeDownload: (id) => ipcRenderer.invoke('resume-download', id),
  deleteDownload: (id, deleteFile, retainPartial) => ipcRenderer.invoke('delete-download', id, deleteFile, retainPartial),
  pauseAll: () => ipcRenderer.invoke('pause-all'),
  resumeAll: () => ipcRenderer.invoke('resume-all'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openFile: (targetPath) => ipcRenderer.invoke('open-file', targetPath),
  showInFolder: (targetPath) => ipcRenderer.invoke('show-in-folder', targetPath),
  getDefaultDownloadDir: () => ipcRenderer.invoke('get-default-dir'),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  onTaskAdded: (callback) => ipcRenderer.on('task-added', (_event, value) => callback(value)),
  onTaskUpdated: (callback) => ipcRenderer.on('task-updated', (_event, value) => callback(value)),
  onTaskCompleted: (callback) => ipcRenderer.on('task-completed', (_event, value) => callback(value)),
  onTaskDeleted: (callback) => ipcRenderer.on('task-deleted', (_event, value) => callback(value)),
  onTaskError: (callback) => ipcRenderer.on('task-error', (_event, value) => callback(value)),
  onSettingsUpdated: (callback) => ipcRenderer.on('settings-updated', (_event, value) => callback(value)),
});
