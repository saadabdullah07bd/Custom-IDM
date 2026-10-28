// Dedicated Progress Window Logic matching IDM's standalone transfer dialog

const urlParams = new URLSearchParams(window.location.search);
const taskId = urlParams.get('taskId');
let currentTask = null;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0.00 KB';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0.00 KB/sec';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(2) + ' KB/sec';
  return (bytesPerSec / (1024 * 1024)).toFixed(3) + ' MB/sec';
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds} sec`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins} min ${secs} sec`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hr ${mins % 60} min`;
}

function getFileBadgeText(filename = '') {
  const parts = filename.split('.');
  if (parts.length > 1) {
    const ext = parts.pop().toUpperCase().slice(0, 4);
    if (ext && ext.length >= 2) return ext;
  }
  return 'FILE';
}

function updateUI(task) {
  currentTask = task;
  const percent = Math.min(100, Math.max(0, task.percentage || 0));

  document.title = `${percent}% of ${task.filename || 'download'} - Internet Download Manager`;

  document.getElementById('progBadge').textContent = getFileBadgeText(task.filename);
  document.getElementById('progFileName').textContent = task.filename || 'download';
  document.getElementById('progUrl').textContent = task.finalUrl || task.url || '—';

  let statusText = task.status;
  if (task.status === 'downloading') {
    statusText = task.retryCount > 0 ? `Receiving data... (Retry #${task.retryCount})` : 'Receiving data...';
  } else if (task.status === 'connecting') {
    statusText = 'Connecting to server...';
  } else if (task.status === 'merging') {
    statusText = 'Assembling file parts...';
  } else if (task.status === 'completed') {
    statusText = 'Download complete';
  } else if (task.status === 'paused') {
    statusText = 'Paused (Resumable from verified disk offset)';
  } else if (task.status === 'error') {
    statusText = `Error: ${task.error || 'Failed'}`;
  }
  document.getElementById('progStatus').textContent = statusText;

  document.getElementById('progFileSize').textContent = formatBytes(task.totalBytes);
  document.getElementById('progDownloaded').textContent = `${formatBytes(task.downloadedBytes)} (${percent.toFixed(1)}%)`;
  document.getElementById('progSpeed').textContent = task.status === 'downloading' ? formatSpeed(task.speed) : '0.00 KB/sec';
  document.getElementById('progTimeLeft').textContent = task.status === 'downloading'
    ? (task.speed > 0 ? formatTime(task.timeLeft) : 'Calculating...')
    : (task.status === 'completed' ? '0 sec (Finished)' : '—');

  const resEl = document.getElementById('progResume');
  resEl.textContent = task.resumable ? 'Yes' : 'No';
  resEl.style.color = task.resumable ? 'var(--color-success)' : 'var(--color-warning)';

  document.getElementById('progBarFill').style.width = `${percent}%`;
  document.getElementById('progPercent').textContent = `${percent}%`;

  document.getElementById('progSavedPath').textContent = task.targetPath || '—';
  document.getElementById('progEtag').textContent = task.etag || task.lastModified || 'None';
  document.getElementById('progSha256').textContent = task.sha256
    ? `${task.sha256} ${task.expectedSha256 ? '(Verified)' : ''}`
    : 'Calculated upon completion';

  const pauseBtn = document.getElementById('btnPauseResume');
  if (task.status === 'downloading' || task.status === 'connecting') {
    pauseBtn.textContent = 'Pause';
    pauseBtn.style.display = 'inline-block';
  } else if (task.status === 'paused' || task.status === 'pending' || task.status === 'error') {
    pauseBtn.textContent = 'Resume';
    pauseBtn.style.display = 'inline-block';
  } else {
    pauseBtn.style.display = 'none';
  }

  document.getElementById('btnOpenFile').style.display = (task.status === 'completed') ? 'inline-block' : 'none';
}

async function init() {
  const savedTheme = localStorage.getItem('personal-idm-theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);

  if (taskId) {
    const task = await window.api.getTaskById(taskId);
    if (task) updateUI(task);
  }

  window.api.onTaskUpdated((task) => {
    if (task.id === taskId) updateUI(task);
  });

  window.api.onTaskCompleted((task) => {
    if (task.id === taskId) updateUI(task);
  });

  window.api.onTaskError(({ id, error }) => {
    if (id === taskId && currentTask) {
      currentTask.status = 'error';
      currentTask.error = error;
      updateUI(currentTask);
    }
  });

  // Buttons
  document.getElementById('btnPauseResume').addEventListener('click', () => {
    if (!currentTask) return;
    if (currentTask.status === 'downloading' || currentTask.status === 'connecting') {
      window.api.pauseDownload(currentTask.id);
    } else {
      window.api.resumeDownload(currentTask.id);
    }
  });

  document.getElementById('btnCancel').addEventListener('click', () => {
    if (currentTask) window.api.pauseDownload(currentTask.id);
    window.close();
  });

  document.getElementById('btnOpenFile').addEventListener('click', () => {
    if (currentTask && currentTask.targetPath) {
      window.api.openFile(currentTask.targetPath);
    }
  });

  document.getElementById('btnOpenFolder').addEventListener('click', () => {
    if (currentTask && currentTask.targetPath) {
      window.api.showInFolder(currentTask.targetPath);
    }
  });

  // Toggle details
  document.getElementById('btnToggleDetails').addEventListener('click', () => {
    const body = document.getElementById('detailsBody');
    const chevron = document.getElementById('detailsChevron');
    const isOpen = body.classList.toggle('open');
    chevron.textContent = isOpen ? '▼' : '▶';
  });
}

init();
