// Personal IDM — Download File Info (Permission & Confirmation Prompt)

const urlParams = new URLSearchParams(window.location.search);
const taskId = urlParams.get('taskId') || window.location.hash.replace(/^#/, '');
let currentTask = null;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return 'Unknown size';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getCategoryFolderName(cat) {
  switch (cat) {
    case 'compressed': return 'Compressed';
    case 'documents': return 'Documents';
    case 'music': return 'Music';
    case 'programs': return 'Programs';
    case 'video': return 'Video';
    default: return 'General';
  }
}

function populateTaskData(task) {
  currentTask = task;
  const urlEl = document.getElementById('infoUrl');
  if (urlEl && task.url) urlEl.value = task.url;

  const catEl = document.getElementById('infoCategory');
  if (catEl && task.category) catEl.value = task.category;

  const pathEl = document.getElementById('infoSavePath');
  if (pathEl && (task.targetPath || task.targetDir)) {
    if (!pathEl.value || pathEl.value.trim() === '') {
      pathEl.value = task.targetPath || task.targetDir;
    }
  }

  const descEl = document.getElementById('infoDescription');
  if (descEl && task.filename && (!descEl.value || descEl.value === 'File download request')) {
    descEl.value = task.filename;
  }

  const sizeEl = document.getElementById('infoSizeText');
  if (sizeEl) {
    if (task.totalBytes && task.totalBytes > 0) {
      sizeEl.textContent = formatBytes(task.totalBytes);
    } else if (task.status === 'connecting') {
      sizeEl.textContent = 'Detecting size...';
    } else {
      sizeEl.textContent = 'Unknown size (Dynamic stream)';
    }
  }
}

function setupListeners() {
  // Start Download Button (Grants permission to start!)
  const btnStart = document.getElementById('btnStartDownload');
  if (btnStart) {
    btnStart.addEventListener('click', async () => {
      btnStart.disabled = true;
      btnStart.textContent = 'Starting...';

      if (taskId) {
        const customPath = document.getElementById('infoSavePath')?.value?.trim();
        const customCat = document.getElementById('infoCategory')?.value;
        if (window.api && window.api.updateTaskDetails) {
          try {
            await window.api.updateTaskDetails(taskId, {
              targetPath: customPath || undefined,
              category: customCat || undefined
            });
          } catch {}
        }

        try {
          if (window.api && window.api.startDownloadNow) {
            await window.api.startDownloadNow(taskId);
          }
        } catch (err) {
          console.error('Failed to start download:', err);
        }

        if (window.api && window.api.openProgressWindow) {
          try {
            await window.api.openProgressWindow(taskId);
          } catch (err) {
            console.error('Failed to open progress window:', err);
          }
        }
      }
      window.close();
    });
  }

  // Cancel Buttons
  const cancelAndClose = async () => {
    if (taskId && window.api && window.api.deleteDownload) {
      try {
        await window.api.deleteDownload(taskId, false, false);
      } catch {}
    }
    window.close();
  };

  const btnCancel = document.getElementById('btnCancel');
  if (btnCancel) btnCancel.addEventListener('click', cancelAndClose);

  const btnTitleClose = document.getElementById('btnTitleClose');
  if (btnTitleClose) btnTitleClose.addEventListener('click', cancelAndClose);

  // Category change updates save path
  const catEl = document.getElementById('infoCategory');
  if (catEl) {
    catEl.addEventListener('change', async (e) => {
      const cat = e.target.value;
      const defaultDir = await window.api.getDefaultDownloadDir();
      const folder = getCategoryFolderName(cat);
      const filename = currentTask?.filename || document.getElementById('infoDescription')?.value?.trim() || 'download';
      document.getElementById('infoSavePath').value = `${defaultDir}\\${folder}\\${filename}`;
    });
  }

  // Browse button
  const btnBrowse = document.getElementById('btnBrowseSave');
  if (btnBrowse) {
    btnBrowse.addEventListener('click', async () => {
      const dir = await window.api.selectDirectory();
      if (dir) {
        const fn = currentTask?.filename || document.getElementById('infoDescription')?.value?.trim() || 'download';
        document.getElementById('infoSavePath').value = `${dir}\\${fn}`;
      }
    });
  }

  // Esc closes / cancels, Enter starts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelAndClose();
    if (e.key === 'Enter') {
      const activeEl = document.activeElement;
      if (activeEl && activeEl.tagName !== 'BUTTON') {
        document.getElementById('btnStartDownload')?.click();
      }
    }
  });
}

async function init() {
  const savedTheme = localStorage.getItem('personal-idm-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  // Set up all interactive event listeners immediately so buttons always respond
  setupListeners();

  if (!taskId) {
    const sizeEl = document.getElementById('infoSizeText');
    if (sizeEl) sizeEl.textContent = 'Unknown size';
    return;
  }

  try {
    const task = await window.api.getTaskById(taskId);
    if (task) {
      populateTaskData(task);

      // Probe in background if size is not yet detected
      if (!task.totalBytes || task.totalBytes <= 0) {
        window.api.probeUrl(task.url).then((probe) => {
          if (probe && probe.totalBytes) {
            const sizeEl = document.getElementById('infoSizeText');
            if (sizeEl) sizeEl.textContent = formatBytes(probe.totalBytes);

            const descEl = document.getElementById('infoDescription');
            if (descEl && probe.filename && (!currentTask || !currentTask.filename)) {
              descEl.value = probe.filename;
            }

            const pathEl = document.getElementById('infoSavePath');
            if (pathEl && probe.suggestedDir && (!pathEl.value || pathEl.value.trim() === '')) {
              pathEl.value = `${probe.suggestedDir}\\${probe.filename || 'download'}`;
            }
          } else {
            const sizeEl = document.getElementById('infoSizeText');
            if (sizeEl) sizeEl.textContent = 'Unknown size (Dynamic stream)';
          }
        }).catch(() => {
          const sizeEl = document.getElementById('infoSizeText');
          if (sizeEl) sizeEl.textContent = 'Unknown size (Dynamic stream)';
        });
      }
    } else {
      const sizeEl = document.getElementById('infoSizeText');
      if (sizeEl) sizeEl.textContent = 'Unknown size';
    }
  } catch (err) {
    console.error('Error fetching task details:', err);
    const sizeEl = document.getElementById('infoSizeText');
    if (sizeEl) sizeEl.textContent = 'Unknown size';
  }

  // Subscribe to real-time task updates
  if (window.api && window.api.onTaskUpdated) {
    window.api.onTaskUpdated((task) => {
      if (task && task.id === taskId) {
        populateTaskData(task);
      }
    });
  }
}

init();
