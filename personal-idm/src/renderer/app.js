// Personal IDM — Modern Minimalist Desktop Renderer Logic

const state = {
  tasks: new Map(),
  selectedTaskId: null,
  activeCategory: 'all',
  searchQuery: '',
  statusFilter: 'all',
  sortField: 'addedAt',
  sortAsc: false,
  currentDetailsTaskId: null,
  defaultDir: '',
  settings: {
    defaultDownloadDir: '',
    defaultConnections: 8,
    maxConcurrent: 3,
    speedLimitKbps: 0,
    notificationsEnabled: true
  }
};

// DOM Elements
const tableBody = document.getElementById('downloadsTableBody');
const countAll = document.getElementById('countAll');
const countCompressed = document.getElementById('countCompressed');
const countDocuments = document.getElementById('countDocuments');
const countMusic = document.getElementById('countMusic');
const countPrograms = document.getElementById('countPrograms');
const countVideo = document.getElementById('countVideo');
const countUnfinished = document.getElementById('countUnfinished');
const countFinished = document.getElementById('countFinished');

// Modals
const downloadDialogModal = document.getElementById('downloadDialogModal');
const addUrlDialogModal = document.getElementById('addUrlDialogModal');
const optionsDialogModal = document.getElementById('optionsDialogModal');
const schedulerDialogModal = document.getElementById('schedulerDialogModal');
const grabberDialogModal = document.getElementById('grabberDialogModal');
const aboutDialogModal = document.getElementById('aboutDialogModal');
const deleteConfirmModal = document.getElementById('deleteConfirmModal');
const delFilenameDisplay = document.getElementById('delFilenameDisplay');
const chkDeleteDiskFile = document.getElementById('chkDeleteDiskFile');
const btnConfirmDelete = document.getElementById('btnConfirmDelete');
const btnCancelDelete = document.getElementById('btnCancelDelete');
const delDlgClose = document.getElementById('delDlgClose');
let pendingDeleteTaskId = null;

// Sidebar
const mainContent = document.getElementById('idmMainContent');
const btnToggleSidebar = document.getElementById('btnToggleSidebar');
const btnCollapseSidebar = document.getElementById('btnCollapseSidebar');
const btnExpandSidebar = document.getElementById('btnExpandSidebar');

// ========================================================
// FORMAT HELPERS
// ========================================================
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
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds} sec`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins} min ${secs} sec`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hr ${mins % 60} min`;
}

function getFileBadgeText(cat, filename = '') {
  const parts = (filename || '').split('.');
  if (parts.length > 1) {
    const ext = parts.pop().toUpperCase().slice(0, 4);
    if (ext && ext.length >= 2) return ext;
  }
  switch (cat) {
    case 'compressed': return 'ZIP';
    case 'programs': return 'EXE';
    case 'documents': return 'DOC';
    case 'video': return 'MP4';
    case 'music': return 'MP3';
    default: return 'FILE';
  }
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

function getActiveOrSelectedTaskId() {
  if (state.selectedTaskId && state.tasks.has(state.selectedTaskId)) {
    return state.selectedTaskId;
  }
  for (const [id, t] of state.tasks.entries()) {
    if (t.status === 'downloading' || t.status === 'connecting' || t.status === 'merging') {
      return id;
    }
  }
  return state.tasks.keys().next().value || null;
}

function applySettingsToUI(settings) {
  state.settings = { ...state.settings, ...settings };
  state.defaultDir = state.settings.defaultDownloadDir;

  const optSaveDir = document.getElementById('optSaveDir');
  if (optSaveDir) optSaveDir.value = state.defaultDir;

  const savePathInput = document.getElementById('savePathInput');
  if (savePathInput && !savePathInput.value) savePathInput.value = state.defaultDir;

  const optDefaultConn = document.getElementById('optDefaultConn');
  if (optDefaultConn) optDefaultConn.value = String(state.settings.defaultConnections);

  const maxConcEl = document.getElementById('optMaxConcurrent');
  if (maxConcEl) maxConcEl.value = String(state.settings.maxConcurrent);

  const speedLimEl = document.getElementById('optSpeedLimit');
  if (speedLimEl) speedLimEl.value = String(state.settings.speedLimitKbps || 0);
}

// ========================================================
// INITIALIZATION
// ========================================================
async function init() {
  const savedTheme = localStorage.getItem('personal-idm-theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);

  const themeSelect = document.getElementById('optThemeSelect');
  if (themeSelect) themeSelect.value = savedTheme;

  // Restore sidebar state
  const isSidebarCollapsed = localStorage.getItem('personal-idm-sidebar-collapsed') === 'true';
  if (isSidebarCollapsed && mainContent) {
    mainContent.classList.add('sidebar-collapsed');
  }

  // Sidebar togglers
  if (btnToggleSidebar) {
    btnToggleSidebar.addEventListener('click', toggleSidebar);
  }
  if (btnCollapseSidebar) {
    btnCollapseSidebar.addEventListener('click', toggleSidebar);
  }
  if (btnExpandSidebar) {
    btnExpandSidebar.addEventListener('click', toggleSidebar);
  }

  // Frameless window controls
  const winMin = document.getElementById('winBtnMin');
  const winMax = document.getElementById('winBtnMax');
  const winClose = document.getElementById('winBtnClose');
  if (winMin) winMin.addEventListener('click', () => window.api.minimizeWindow?.());
  if (winMax) winMax.addEventListener('click', () => window.api.maximizeWindow?.());
  if (winClose) winClose.addEventListener('click', () => window.api.closeWindow?.());

  const settings = await window.api.getSettings();
  applySettingsToUI(settings);

  const port = await window.api.getServerPort();
  const portLbl = document.getElementById('optActivePortLabel');
  if (portLbl) portLbl.textContent = `127.0.0.1:${port}`;

  const tasks = await window.api.getTasks();
  for (const t of tasks) {
    state.tasks.set(t.id, t);
  }

  updateSortIndicators();
  renderTable();
  updateCategoryCounts();
  setupToolbarEvents();
  setupFilterAndSortEvents();
  setupIPCListeners();
}

function toggleSidebar() {
  if (!mainContent) return;
  const isCollapsed = mainContent.classList.toggle('sidebar-collapsed');
  localStorage.setItem('personal-idm-sidebar-collapsed', String(isCollapsed));
}

// ========================================================
// TABLE & STATUS RENDERING
// ========================================================
function renderStatusCellHtml(task) {
  if (task.status === 'downloading' || task.status === 'connecting') {
    const percent = Math.min(100, Math.max(0, task.percentage || 0));
    return `
      <div class="inline-pbar-wrap">
        <div class="inline-pbar-bg">
          <div class="inline-pbar-fill" style="width: ${percent}%;"></div>
        </div>
        <span class="inline-pbar-text tabular-nums">${percent}%</span>
      </div>
    `;
  }
  if (task.status === 'completed') {
    return `<span class="status-badge badge-completed">Complete</span>`;
  }
  if (task.status === 'paused') {
    const p = task.percentage ? ` (${task.percentage}%)` : '';
    return `<span class="status-badge badge-paused">Paused${p}</span>`;
  }
  if (task.status === 'pending') {
    return `<span class="status-badge badge-pending">Queued</span>`;
  }
  if (task.status === 'merging') {
    return `<span class="status-badge badge-merging">Assembling...</span>`;
  }
  if (task.status === 'error') {
    return `<span class="status-badge badge-error">Error</span>`;
  }
  return `<span class="status-badge badge-pending">${task.status}</span>`;
}

function getFilteredAndSortedTasks() {
  const allTasks = Array.from(state.tasks.values());
  const q = state.searchQuery.trim().toLowerCase();

  const filtered = allTasks.filter(task => {
    // 1. Category tree filter
    if (state.activeCategory === 'unfinished') {
      if (task.status === 'completed') return false;
    } else if (state.activeCategory === 'finished') {
      if (task.status !== 'completed') return false;
    } else if (state.activeCategory !== 'all') {
      if (task.category !== state.activeCategory) return false;
    }

    // 2. Status dropdown filter
    if (state.statusFilter !== 'all') {
      if (state.statusFilter === 'paused') {
        if (task.status !== 'paused' && task.status !== 'pending') return false;
      } else if (task.status !== state.statusFilter) {
        return false;
      }
    }

    // 3. Search keyword filter
    if (q) {
      const fn = (task.filename || '').toLowerCase();
      const u = (task.url || '').toLowerCase();
      if (!fn.includes(q) && !u.includes(q)) return false;
    }

    return true;
  });

  // Sort tasks
  const dir = state.sortAsc ? 1 : -1;
  filtered.sort((a, b) => {
    const field = state.sortField;
    let va = a[field];
    let vb = b[field];

    if (field === 'filename' || field === 'status') {
      va = String(va || '').toLowerCase();
      vb = String(vb || '').toLowerCase();
      return va.localeCompare(vb) * dir;
    }
    if (field === 'addedAt') {
      va = va ? new Date(va).getTime() : 0;
      vb = vb ? new Date(vb).getTime() : 0;
      return (va - vb) * dir;
    }
    va = Number(va) || 0;
    vb = Number(vb) || 0;
    return (va - vb) * dir;
  });

  return filtered;
}

function updateSortIndicators() {
  document.querySelectorAll('.sort-indicator').forEach(el => {
    el.textContent = '';
  });
  const activeIndicator = document.getElementById(`sort-${state.sortField}`);
  if (activeIndicator) {
    activeIndicator.textContent = state.sortAsc ? '▲' : '▼';
  }
}

function renderTable() {
  const filtered = getFilteredAndSortedTasks();
  tableBody.innerHTML = '';

  if (filtered.length === 0) {
    const emptyTr = document.createElement('tr');
    emptyTr.className = 'empty-state-row';
    const hasFilters = state.searchQuery.trim() !== '' || state.statusFilter !== 'all' || state.activeCategory !== 'all';
    emptyTr.innerHTML = `
      <td colspan="7">
        <div class="empty-state-box">
          <div class="empty-state-title">${hasFilters ? 'No downloads match the current filter' : 'Download queue is empty'}</div>
          <div class="empty-state-sub">${hasFilters ? 'Try clearing the search box or switching categories on the left.' : 'Click "Add URL" on the toolbar or use the Browser Extension to start downloading.'}</div>
        </div>
      </td>
    `;
    tableBody.appendChild(emptyTr);
    return;
  }

  for (const task of filtered) {
    const tr = document.createElement('tr');
    tr.id = `idm-row-${task.id}`;
    if (state.selectedTaskId === task.id) tr.classList.add('selected');

    tr.addEventListener('click', () => selectRow(task.id));
    tr.addEventListener('dblclick', () => openDownloadStatus(task.id));

    const dateFormatted = task.addedAt ? new Date(task.addedAt).toLocaleDateString() : '—';
    const desc = task.error
      ? `Error: ${task.error}`
      : (task.sha256 ? `SHA256: ${task.sha256.slice(0, 14)}...` : `${task.category} (${task.maxConnections} conn)`);

    tr.innerHTML = `
      <td>
        <div class="cell-file">
          <span class="file-type-icon">${getFileBadgeText(task.category, task.filename)}</span>
          <span title="${task.filename || ''}">${task.filename || 'Initializing...'}</span>
        </div>
      </td>
      <td class="tabular-nums">${formatBytes(task.totalBytes)}</td>
      <td>${renderStatusCellHtml(task)}</td>
      <td class="tabular-nums">${task.status === 'downloading' ? formatTime(task.timeLeft) : '—'}</td>
      <td class="tabular-nums">${task.status === 'downloading' ? formatSpeed(task.speed) : '—'}</td>
      <td class="tabular-nums">${dateFormatted}</td>
      <td style="color: ${task.error ? 'var(--color-danger)' : 'var(--text-secondary)'};" title="${desc}">${desc}</td>
    `;

    tableBody.appendChild(tr);
  }
}

function updateTableRow(task) {
  const tr = document.getElementById(`idm-row-${task.id}`);
  if (!tr || state.statusFilter !== 'all') {
    renderTable();
    return;
  }

  tr.cells[1].textContent = formatBytes(task.totalBytes);
  tr.cells[2].innerHTML = renderStatusCellHtml(task);
  tr.cells[3].textContent = task.status === 'downloading' ? formatTime(task.timeLeft) : '—';
  tr.cells[4].textContent = task.status === 'downloading' ? formatSpeed(task.speed) : '—';
  const desc = task.error
    ? `Error: ${task.error}`
    : (task.sha256 ? `SHA256: ${task.sha256.slice(0, 14)}...` : `${task.category} (${task.maxConnections} conn)`);
  tr.cells[6].textContent = desc;
  tr.cells[6].style.color = task.error ? 'var(--color-danger)' : 'var(--text-secondary)';
}

function selectRow(id) {
  state.selectedTaskId = id;
  const rows = tableBody.querySelectorAll('tr');
  rows.forEach(r => r.classList.remove('selected'));
  const target = document.getElementById(`idm-row-${id}`);
  if (target) target.classList.add('selected');
}

function updateCategoryCounts() {
  const allTasks = Array.from(state.tasks.values());
  if (countAll) countAll.textContent = allTasks.length;
  if (countCompressed) countCompressed.textContent = allTasks.filter(t => t.category === 'compressed').length;
  if (countDocuments) countDocuments.textContent = allTasks.filter(t => t.category === 'documents').length;
  if (countMusic) countMusic.textContent = allTasks.filter(t => t.category === 'music').length;
  if (countPrograms) countPrograms.textContent = allTasks.filter(t => t.category === 'programs').length;
  if (countVideo) countVideo.textContent = allTasks.filter(t => t.category === 'video').length;
  if (countUnfinished) countUnfinished.textContent = allTasks.filter(t => t.status !== 'completed').length;
  if (countFinished) countFinished.textContent = allTasks.filter(t => t.status === 'completed').length;
}

// ========================================================
// DOWNLOAD STATUS WINDOW & MODAL
// ========================================================
function openDownloadStatus(id) {
  const task = state.tasks.get(id);
  if (!task) return;

  // Open native separate BrowserWindow if available
  if (window.api.openProgressWindow) {
    window.api.openProgressWindow(id);
  }

  // Also update in-app modal
  state.currentDetailsTaskId = id;
  updateDownloadDialog(task);
  downloadDialogModal?.classList.add('open');
}

function updateDownloadDialog(task) {
  const percent = Math.min(100, Math.max(0, task.percentage || 0));
  const dlgTitle = document.getElementById('dlgTitle');
  if (dlgTitle) dlgTitle.textContent = `${percent.toFixed(1)}% of ${task.filename || 'file'} - Internet Download Manager`;

  let statusDisplay = task.status;
  if (task.status === 'downloading') {
    statusDisplay = task.retryCount > 0 ? `Receiving data... (Retry #${task.retryCount})` : 'Receiving data...';
  } else if (task.status === 'connecting') {
    statusDisplay = 'Connecting to server...';
  } else if (task.status === 'merging') {
    statusDisplay = 'Assembling file parts...';
  } else if (task.status === 'completed') {
    statusDisplay = 'Download complete';
  } else if (task.status === 'paused') {
    statusDisplay = 'Paused (Resumable from verified disk offset)';
  } else if (task.status === 'error') {
    statusDisplay = `Error: ${task.error || 'Download failed'}`;
  }

  const dlgStatusText = document.getElementById('dlgStatusText');
  if (dlgStatusText) dlgStatusText.textContent = statusDisplay;

  const dlgFileSize = document.getElementById('dlgFileSize');
  if (dlgFileSize) dlgFileSize.textContent = formatBytes(task.totalBytes);

  const dlgDownloaded = document.getElementById('dlgDownloaded');
  if (dlgDownloaded) dlgDownloaded.textContent = `${formatBytes(task.downloadedBytes)} (${percent.toFixed(1)}%)`;

  const dlgTransferRate = document.getElementById('dlgTransferRate');
  if (dlgTransferRate) dlgTransferRate.textContent = task.status === 'downloading' ? formatSpeed(task.speed) : '0.00 KB/sec';

  const dlgTimeLeft = document.getElementById('dlgTimeLeft');
  if (dlgTimeLeft) {
    dlgTimeLeft.textContent = task.status === 'downloading'
      ? (task.speed > 0 ? formatTime(task.timeLeft) : 'Calculating...')
      : (task.status === 'completed' ? '0 sec (Finished)' : '—');
  }

  const resumeCap = document.getElementById('dlgResumeCap');
  if (resumeCap) {
    resumeCap.textContent = task.resumable ? 'Yes' : 'No';
    resumeCap.style.color = task.resumable ? 'var(--color-success)' : 'var(--color-warning)';
  }

  // File Info tab fields
  const infoUrl = document.getElementById('dlgInfoUrl');
  const infoPath = document.getElementById('dlgInfoPath');
  const infoEtag = document.getElementById('dlgInfoEtag');
  const infoSha = document.getElementById('dlgInfoSha256');
  if (infoUrl) infoUrl.textContent = task.finalUrl || task.url || '—';
  if (infoPath) infoPath.textContent = task.targetPath || '—';
  if (infoEtag) infoEtag.textContent = task.etag || task.lastModified || 'None';
  if (infoSha) {
    if (task.sha256) {
      infoSha.textContent = task.expectedSha256
        ? `${task.sha256} (Verified Match)`
        : `${task.sha256} (Calculated digest)`;
    } else {
      infoSha.textContent = 'Computed upon completion';
    }
  }

  const pbar = document.getElementById('dlgProgressBar');
  const plbl = document.getElementById('dlgPercentLabel');
  if (pbar) pbar.style.width = `${percent}%`;
  if (plbl) plbl.textContent = `${percent.toFixed(1)}%`;

  // Pause / Resume button
  const pauseBtn = document.getElementById('dlgPauseResumeBtn');
  if (pauseBtn) {
    if (task.status === 'downloading' || task.status === 'connecting') {
      pauseBtn.textContent = 'Pause';
      pauseBtn.style.display = 'inline-block';
    } else if (task.status === 'paused' || task.status === 'pending' || task.status === 'error') {
      pauseBtn.textContent = 'Resume';
      pauseBtn.style.display = 'inline-block';
    } else {
      pauseBtn.style.display = 'none';
    }
  }

  const openBtn = document.getElementById('dlgOpenFileBtn');
  if (openBtn) {
    openBtn.style.display = (task.status === 'completed') ? 'inline-block' : 'none';
  }
}

function openDeleteModal(taskId) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  pendingDeleteTaskId = taskId;
  if (delFilenameDisplay) delFilenameDisplay.textContent = task.filename || 'download';
  if (chkDeleteDiskFile) chkDeleteDiskFile.checked = false;
  deleteConfirmModal?.classList.add('open');
}

function closeDeleteModal() {
  pendingDeleteTaskId = null;
  deleteConfirmModal?.classList.remove('open');
}

// ========================================================
// FILTERING & SHORTCUTS
// ========================================================
function setupFilterAndSortEvents() {
  const searchInput = document.getElementById('searchFilterInput');
  const statusSelect = document.getElementById('statusFilterSelect');
  const clearBtn = document.getElementById('clearFilterBtn');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderTable();
    });
  }

  if (statusSelect) {
    statusSelect.addEventListener('change', (e) => {
      state.statusFilter = e.target.value;
      renderTable();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.searchQuery = '';
      state.statusFilter = 'all';
      if (searchInput) searchInput.value = '';
      if (statusSelect) statusSelect.value = 'all';
      renderTable();
    });
  }

  // Column Sorting
  document.querySelectorAll('.sortable-th').forEach(th => {
    th.addEventListener('click', () => {
      const sortKey = th.getAttribute('data-sort');
      if (!sortKey) return;
      if (state.sortField === sortKey) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortField = sortKey;
        state.sortAsc = true;
      }
      updateSortIndicators();
      renderTable();
    });
  });

  // Global Keyboard Navigation
  document.addEventListener('keydown', (e) => {
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      downloadDialogModal?.classList.remove('open');
      addUrlDialogModal?.classList.remove('open');
      optionsDialogModal?.classList.remove('open');
      schedulerDialogModal?.classList.remove('open');
      grabberDialogModal?.classList.remove('open');
      aboutDialogModal?.classList.remove('open');
      closeDeleteModal();
    } else if (e.key === 'Insert' && !isInput) {
      openAddUrlDialog();
    } else if (e.key === 'Enter' && !isInput) {
      const id = getActiveOrSelectedTaskId();
      if (id) openDownloadStatus(id);
    } else if (e.key === 'Delete' && state.selectedTaskId && !isInput) {
      openDeleteModal(state.selectedTaskId);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleSidebar();
    }
  });
}

// ========================================================
// TOOLBAR & DIALOGS
// ========================================================
function setupToolbarEvents() {
  // Tree item selection
  document.querySelectorAll('.tree-item-row').forEach(row => {
    row.addEventListener('click', () => {
      document.querySelectorAll('.tree-item-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      const cat = row.getAttribute('data-cat');
      if (cat) {
        state.activeCategory = cat;
        renderTable();
      }
    });
  });

  // Download Status Dialog Tabs — FIXED TAB SWITCHING SO LAYOUT NEVER COLLAPSES
  const tabBtnStatus = document.getElementById('tabBtnStatus');
  const tabBtnFileInfo = document.getElementById('tabBtnFileInfo');
  const tabPaneStatus = document.getElementById('tabPaneStatus');
  const tabPaneFileInfo = document.getElementById('tabPaneFileInfo');

  if (tabBtnStatus && tabBtnFileInfo && tabPaneStatus && tabPaneFileInfo) {
    tabBtnStatus.addEventListener('click', () => {
      tabBtnStatus.classList.add('active');
      tabBtnFileInfo.classList.remove('active');
      tabPaneStatus.style.display = 'block';
      tabPaneFileInfo.style.display = 'none';
    });
    tabBtnFileInfo.addEventListener('click', () => {
      tabBtnFileInfo.classList.add('active');
      tabBtnStatus.classList.remove('active');
      tabPaneStatus.style.display = 'none';
      tabPaneFileInfo.style.display = 'block';
    });
  }

  // Options Dialog Tabs
  const optTabs = [
    { btn: document.getElementById('optTabGeneralBtn'), pane: document.getElementById('optPaneGeneral') },
    { btn: document.getElementById('optTabConnBtn'), pane: document.getElementById('optPaneConn') },
    { btn: document.getElementById('optTabBridgeBtn'), pane: document.getElementById('optPaneBridge') }
  ];
  optTabs.forEach(({ btn, pane }) => {
    if (!btn || !pane) return;
    btn.addEventListener('click', () => {
      optTabs.forEach(t => {
        t.btn?.classList.remove('active');
        if (t.pane) t.pane.style.display = 'none';
      });
      btn.classList.add('active');
      pane.style.display = 'block';
    });
  });

  // Main Toolbar buttons
  document.getElementById('tbAddUrl').addEventListener('click', openAddUrlDialog);

  document.getElementById('tbResume').addEventListener('click', () => {
    const id = state.selectedTaskId || getActiveOrSelectedTaskId();
    if (id) window.api.resumeDownload(id);
  });

  document.getElementById('tbStop').addEventListener('click', () => {
    const id = state.selectedTaskId || getActiveOrSelectedTaskId();
    if (id) window.api.pauseDownload(id);
  });

  document.getElementById('tbStopAll').addEventListener('click', () => {
    window.api.pauseAll();
  });

  document.getElementById('tbStartQueue').addEventListener('click', () => {
    window.api.resumeAll();
  });

  document.getElementById('tbStopQueue').addEventListener('click', () => {
    window.api.pauseAll();
  });

  document.getElementById('tbDelete').addEventListener('click', () => {
    const id = state.selectedTaskId || getActiveOrSelectedTaskId();
    if (id) {
      openDeleteModal(id);
    }
  });

  if (btnConfirmDelete) {
    btnConfirmDelete.addEventListener('click', () => {
      if (pendingDeleteTaskId) {
        const deleteFile = chkDeleteDiskFile ? chkDeleteDiskFile.checked : false;
        window.api.deleteDownload(pendingDeleteTaskId, deleteFile, false);
      }
      closeDeleteModal();
    });
  }
  if (btnCancelDelete) btnCancelDelete.addEventListener('click', closeDeleteModal);
  if (delDlgClose) delDlgClose.addEventListener('click', closeDeleteModal);

  document.getElementById('tbDeleteCompleted').addEventListener('click', () => {
    for (const task of state.tasks.values()) {
      if (task.status === 'completed') {
        window.api.deleteDownload(task.id, false, false);
      }
    }
  });

  // Options Button & Dialog
  document.getElementById('tbOptions').addEventListener('click', async () => {
    const currentSettings = await window.api.getSettings();
    applySettingsToUI(currentSettings);
    const port = await window.api.getServerPort();
    const portLbl = document.getElementById('optActivePortLabel');
    if (portLbl) portLbl.textContent = `127.0.0.1:${port}`;
    optionsDialogModal?.classList.add('open');
  });

  document.getElementById('optionsCloseBtn').addEventListener('click', () => {
    optionsDialogModal?.classList.remove('open');
  });
  document.getElementById('optCancelBtn').addEventListener('click', () => {
    optionsDialogModal?.classList.remove('open');
  });

  document.getElementById('optBrowseBtn').addEventListener('click', async () => {
    const dir = await window.api.selectDirectory();
    if (dir) document.getElementById('optSaveDir').value = dir;
  });

  document.getElementById('optSaveBtn').addEventListener('click', async () => {
    try {
      const themeSel = document.getElementById('optThemeSelect');
      if (themeSel) {
        const selectedTheme = themeSel.value;
        document.documentElement.setAttribute('data-theme', selectedTheme);
        localStorage.setItem('personal-idm-theme', selectedTheme);
      }

      const newSettings = {
        defaultDownloadDir: document.getElementById('optSaveDir').value.trim(),
        defaultConnections: parseInt(document.getElementById('optDefaultConn').value, 10) || 8,
        maxConcurrent: parseInt(document.getElementById('optMaxConcurrent').value, 10) || 3,
        speedLimitKbps: Math.max(0, parseInt(document.getElementById('optSpeedLimit').value, 10) || 0)
      };
      const saved = await window.api.saveSettings(newSettings);
      applySettingsToUI(saved);
      optionsDialogModal?.classList.remove('open');
    } catch (err) {
      alert('Invalid configuration: ' + err.message);
    }
  });

  // MANDATORY TOOLBAR BUTTON 1: Scheduler (#tbScheduler)
  const tbScheduler = document.getElementById('tbScheduler');
  if (tbScheduler && schedulerDialogModal) {
    tbScheduler.addEventListener('click', () => {
      schedulerDialogModal.classList.add('open');
    });
    document.getElementById('schedulerCloseBtn')?.addEventListener('click', () => {
      schedulerDialogModal.classList.remove('open');
    });
    document.getElementById('schedulerOkBtn')?.addEventListener('click', () => {
      schedulerDialogModal.classList.remove('open');
    });
  }

  // MANDATORY TOOLBAR BUTTON 2: Site Grabber (#tbGrabber)
  const tbGrabber = document.getElementById('tbGrabber');
  if (tbGrabber && grabberDialogModal) {
    tbGrabber.addEventListener('click', () => {
      grabberDialogModal.classList.add('open');
    });
    document.getElementById('grabberCloseBtn')?.addEventListener('click', () => {
      grabberDialogModal.classList.remove('open');
    });
    document.getElementById('grabberOkBtn')?.addEventListener('click', () => {
      grabberDialogModal.classList.remove('open');
    });
  }

  // About Dialog
  document.getElementById('aboutCloseBtn')?.addEventListener('click', () => {
    aboutDialogModal?.classList.remove('open');
  });
  document.getElementById('aboutOkBtn')?.addEventListener('click', () => {
    aboutDialogModal?.classList.remove('open');
  });

  // Add URL Dialog Actions
  document.getElementById('addUrlDlgClose').addEventListener('click', () => {
    addUrlDialogModal?.classList.remove('open');
  });
  document.getElementById('btnCancelAdd').addEventListener('click', () => {
    addUrlDialogModal?.classList.remove('open');
  });

  document.getElementById('btnPasteUrl').addEventListener('click', async () => {
    const txt = await navigator.clipboard.readText();
    if (txt) {
      document.getElementById('newUrlInput').value = txt.trim();
      probeEnteredUrl(txt.trim());
    }
  });

  document.getElementById('newUrlInput').addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val.startsWith('http://') || val.startsWith('https://')) {
      probeEnteredUrl(val);
    }
  });

  document.getElementById('btnBrowseDir').addEventListener('click', async () => {
    const dir = await window.api.selectDirectory();
    if (dir) document.getElementById('savePathInput').value = dir;
  });

  document.getElementById('btnStartDownload').addEventListener('click', () => {
    submitDownload();
  });

  // Download Status Dialog Actions
  document.getElementById('dlgCloseBtn').addEventListener('click', () => {
    downloadDialogModal?.classList.remove('open');
    state.currentDetailsTaskId = null;
  });
  document.getElementById('dlgHideBtn').addEventListener('click', () => {
    downloadDialogModal?.classList.remove('open');
    state.currentDetailsTaskId = null;
  });

  document.getElementById('dlgPauseResumeBtn').addEventListener('click', () => {
    if (!state.currentDetailsTaskId) return;
    const task = state.tasks.get(state.currentDetailsTaskId);
    if (!task) return;

    if (task.status === 'downloading' || task.status === 'connecting') {
      window.api.pauseDownload(task.id);
    } else {
      window.api.resumeDownload(task.id);
    }
  });

  document.getElementById('dlgCancelBtn').addEventListener('click', () => {
    if (state.currentDetailsTaskId) {
      window.api.pauseDownload(state.currentDetailsTaskId);
      downloadDialogModal?.classList.remove('open');
    }
  });

  document.getElementById('dlgOpenFileBtn').addEventListener('click', () => {
    if (state.currentDetailsTaskId) {
      const task = state.tasks.get(state.currentDetailsTaskId);
      if (task && task.targetPath) window.api.openFile(task.targetPath);
    }
  });

  document.getElementById('dlgOpenFolderBtn').addEventListener('click', () => {
    if (state.currentDetailsTaskId) {
      const task = state.tasks.get(state.currentDetailsTaskId);
      if (task && task.targetPath) window.api.showInFolder(task.targetPath);
      else window.api.openFile(state.defaultDir);
    }
  });
}

async function openAddUrlDialog(prefillUrl = '', prefillFilename = '') {
  document.getElementById('newUrlInput').value = prefillUrl || '';
  document.getElementById('customFilenameInput').value = prefillFilename || '';
  const shaInput = document.getElementById('expectedSha256Input');
  if (shaInput) shaInput.value = '';
  document.getElementById('savePathInput').value = state.defaultDir;
  document.getElementById('urlProbeBox').style.display = 'none';
  addUrlDialogModal?.classList.add('open');

  if (prefillUrl) {
    probeEnteredUrl(prefillUrl);
    return;
  }

  try {
    const text = await navigator.clipboard.readText();
    if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
      document.getElementById('newUrlInput').value = text.trim();
      probeEnteredUrl(text.trim());
    }
  } catch {}
}

async function probeEnteredUrl(url) {
  const box = document.getElementById('urlProbeBox');
  const fnLbl = document.getElementById('probeFn');
  const sizeLbl = document.getElementById('probeSize');
  const resumeLbl = document.getElementById('probeResume');
  const catBadge = document.getElementById('probeCategoryBadge');

  box.style.display = 'flex';
  fnLbl.textContent = 'Probing server...';
  sizeLbl.textContent = '...';
  resumeLbl.textContent = '...';

  try {
    const info = await window.api.probeUrl(url);
    fnLbl.textContent = info.filename || 'Unknown';
    sizeLbl.textContent = formatBytes(info.totalBytes);
    resumeLbl.textContent = info.acceptRanges ? 'Yes (Accelerated Range Multi-Part)' : 'No (Single stream)';
    resumeLbl.style.color = info.acceptRanges ? 'var(--color-success)' : 'var(--color-warning)';

    if (catBadge && info.category) {
      catBadge.textContent = getCategoryFolderName(info.category);
    }

    // DYNAMIC DESTINATION FOLDER BASED ON CATEGORY
    if (info.suggestedDir) {
      document.getElementById('savePathInput').value = info.suggestedDir;
    }

    if (!document.getElementById('customFilenameInput').value && info.filename) {
      document.getElementById('customFilenameInput').value = info.filename;
    }
  } catch {
    fnLbl.textContent = 'Could not probe URL metadata';
    sizeLbl.textContent = '—';
    resumeLbl.textContent = '—';
  }
}

async function submitDownload() {
  const url = document.getElementById('newUrlInput').value.trim();
  if (!url) {
    alert('Please enter a valid URL');
    return;
  }

  const targetDir = document.getElementById('savePathInput').value.trim() || state.defaultDir;
  const filename = document.getElementById('customFilenameInput').value.trim();
  const expectedSha256 = (document.getElementById('expectedSha256Input')?.value || '').trim();

  addUrlDialogModal?.classList.remove('open');

  try {
    const task = await window.api.addDownload({
      url,
      targetDir,
      filename: filename || undefined,
      maxConnections: 'auto',
      autoCategorize: true,
      expectedSha256: expectedSha256 || undefined,
      autoStart: true
    });

    openDownloadStatus(task.id);
  } catch (err) {
    alert('Failed to start download: ' + err.message);
  }
}

// IPC Real-time Event Subscriptions
function setupIPCListeners() {
  window.api.onTaskAdded((task) => {
    state.tasks.set(task.id, task);
    renderTable();
    updateCategoryCounts();
  });

  window.api.onTaskUpdated((task) => {
    state.tasks.set(task.id, task);
    updateTableRow(task);
    updateCategoryCounts();

    if (state.currentDetailsTaskId === task.id) {
      updateDownloadDialog(task);
    }
  });

  window.api.onTaskCompleted((task) => {
    state.tasks.set(task.id, task);
    updateTableRow(task);
    updateCategoryCounts();

    if (state.currentDetailsTaskId === task.id) {
      updateDownloadDialog(task);
    }
  });

  window.api.onTaskDeleted((id) => {
    state.tasks.delete(id);
    if (state.selectedTaskId === id) state.selectedTaskId = null;
    if (state.currentDetailsTaskId === id) {
      downloadDialogModal?.classList.remove('open');
      state.currentDetailsTaskId = null;
    }
    renderTable();
    updateCategoryCounts();
  });

  window.api.onTaskError(({ id, error }) => {
    const task = state.tasks.get(id);
    if (task) {
      task.status = 'error';
      task.error = error;
      updateTableRow(task);
      if (state.currentDetailsTaskId === id) {
        updateDownloadDialog(task);
      }
    }
  });

  if (window.api.onSettingsUpdated) {
    window.api.onSettingsUpdated((settings) => {
      applySettingsToUI(settings);
    });
  }
}

init();
