// Dedicated Complete Dialog Controller matching DownloadCraft & IDM

const urlParams = new URLSearchParams(window.location.search);
const taskId = urlParams.get('taskId') || window.location.hash.replace(/^#/, '');
let currentTask = null;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0.00 KB';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

async function init() {
  const savedTheme = localStorage.getItem('personal-idm-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  if (taskId) {
    const task = await window.api.getTaskById(taskId);
    if (task) {
      currentTask = task;
      document.getElementById('completeFileName').textContent = task.filename || 'download';
      document.getElementById('completeFileSize').textContent = `${formatBytes(task.totalBytes || task.downloadedBytes)} · Complete`;
      document.getElementById('completeUrl').value = task.finalUrl || task.url || '—';
      document.getElementById('completeSavedPath').value = task.targetPath || '—';
    }
  }

  document.getElementById('btnTitleClose')?.addEventListener('click', () => window.close());
  document.getElementById('btnClose')?.addEventListener('click', () => window.close());

  document.getElementById('btnOpen')?.addEventListener('click', () => {
    if (currentTask && currentTask.targetPath) {
      window.api.openFile(currentTask.targetPath);
      window.close();
    }
  });

  document.getElementById('btnOpenFolder')?.addEventListener('click', () => {
    if (currentTask && currentTask.targetPath) {
      window.api.showInFolder(currentTask.targetPath);
      window.close();
    }
  });

  document.getElementById('chkDontShowAgain')?.addEventListener('change', (e) => {
    localStorage.setItem('personal-idm-hide-complete-dialog', e.target.checked ? 'true' : 'false');
  });
}

window.addEventListener('DOMContentLoaded', init);
