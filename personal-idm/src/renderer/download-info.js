// Personal IDM — Download File Info (Permission & Confirmation Prompt)

const urlParams = new URLSearchParams(window.location.search);
const taskId = urlParams.get('taskId');
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

async function init() {
  const savedTheme = localStorage.getItem('personal-idm-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  if (!taskId) return;

  currentTask = await window.api.getTaskById(taskId);
  if (!currentTask) return;

  document.getElementById('infoUrl').value = currentTask.url || '';
  document.getElementById('infoCategory').value = currentTask.category || 'general';
  document.getElementById('infoSavePath').value = currentTask.targetPath || currentTask.targetDir || '';
  document.getElementById('infoSizeText').textContent = formatBytes(currentTask.totalBytes);

  // If size unknown, probe live
  if (!currentTask.totalBytes || currentTask.totalBytes <= 0) {
    try {
      const probe = await window.api.probeUrl(currentTask.url);
      if (probe && probe.totalBytes) {
        document.getElementById('infoSizeText').textContent = formatBytes(probe.totalBytes);
      }
    } catch {}
  }

  // Category change updates save path
  document.getElementById('infoCategory').addEventListener('change', async (e) => {
    const cat = e.target.value;
    const defaultDir = await window.api.getDefaultDownloadDir();
    const folder = getCategoryFolderName(cat);
    const filename = currentTask.filename || 'download';
    document.getElementById('infoSavePath').value = `${defaultDir}\\${folder}\\${filename}`;
  });

  // Browse button
  document.getElementById('btnBrowseSave').addEventListener('click', async () => {
    const dir = await window.api.selectDirectory();
    if (dir) {
      const fn = currentTask.filename || 'download';
      document.getElementById('infoSavePath').value = `${dir}\\${fn}`;
    }
  });

  // Start Download Button (Grants permission to start!)
  document.getElementById('btnStartDownload').addEventListener('click', async () => {
    if (taskId) {
      await window.api.startDownloadNow(taskId);
      if (window.api.openProgressWindow) {
        await window.api.openProgressWindow(taskId);
      }
    }
    window.close();
  });

  // Cancel Buttons
  const cancelAndClose = async () => {
    if (taskId) {
      await window.api.deleteDownload(taskId, false, false);
    }
    window.close();
  };

  document.getElementById('btnCancel').addEventListener('click', cancelAndClose);
  document.getElementById('btnTitleClose').addEventListener('click', cancelAndClose);

  // Esc closes / cancels
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelAndClose();
    if (e.key === 'Enter') document.getElementById('btnStartDownload').click();
  });
}

init();
