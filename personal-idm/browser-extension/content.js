// Personal IDM Browser Content Script — In-Page Download Panel & Permission Prompt

(function () {
  if (window.__personal_idm_injected__) return;
  window.__personal_idm_injected__ = true;

  const DOWNLOAD_EXTS = [
    '.zip', '.rar', '.7z', '.tar', '.gz', '.iso', '.exe', '.msi', '.apk',
    '.mp4', '.mkv', '.avi', '.mov', '.mp3', '.flac', '.pdf', '.dmg', '.deb'
  ];

  function isDownloadableUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url, location.href);
      const pathname = parsed.pathname.toLowerCase();
      return DOWNLOAD_EXTS.some(ext => pathname.endsWith(ext));
    } catch {
      return false;
    }
  }

  function getFilenameFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const name = parsed.pathname.split('/').pop() || 'download';
      return decodeURIComponent(name);
    } catch {
      return 'download';
    }
  }

  // Floating Video/Audio Download Button
  let floatingBtn = null;
  function createFloatingButton() {
    if (floatingBtn) return floatingBtn;
    floatingBtn = document.createElement('div');
    floatingBtn.id = 'personal-idm-video-btn';
    floatingBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      <span>Download with IDM</span>
    `;
    document.body.appendChild(floatingBtn);
    return floatingBtn;
  }

  let activeMediaEl = null;
  function showFloatingButtonFor(el) {
    const btn = createFloatingButton();
    activeMediaEl = el;
    const rect = el.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return;

    btn.style.top = `${window.scrollY + rect.top + 8}px`;
    btn.style.left = `${window.scrollX + rect.right - 150}px`;
    btn.classList.add('visible');
  }

  function hideFloatingButton() {
    if (floatingBtn) {
      floatingBtn.classList.remove('visible');
    }
    activeMediaEl = null;
  }

  // Media hover listeners
  document.addEventListener('mouseover', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'VIDEO' || target.tagName === 'AUDIO')) {
      showFloatingButtonFor(target);
    }
  }, true);

  document.addEventListener('click', (e) => {
    if (floatingBtn && floatingBtn.contains(e.target) && activeMediaEl) {
      e.preventDefault();
      e.stopPropagation();
      const mediaSrc = activeMediaEl.currentSrc || activeMediaEl.src;
      if (mediaSrc) {
        showConfirmationModal(mediaSrc, getFilenameFromUrl(mediaSrc));
      }
      hideFloatingButton();
    }
  }, true);

  // In-Page Permission / Confirmation Modal
  let confirmModal = null;
  function showConfirmationModal(url, filename = '') {
    if (!confirmModal) {
      confirmModal = document.createElement('div');
      confirmModal.id = 'personal-idm-confirm-dialog';
      document.body.appendChild(confirmModal);
    }

    const cleanFn = filename || getFilenameFromUrl(url);

    confirmModal.innerHTML = `
      <div class="idm-confirm-box">
        <div class="idm-confirm-header">
          <span class="idm-confirm-title">Download with Personal IDM</span>
          <button class="idm-confirm-close" id="idmBtnCancelX">✕</button>
        </div>
        <div class="idm-confirm-body">
          <div class="idm-confirm-file">
            <span class="idm-confirm-fn" title="${cleanFn}">${cleanFn}</span>
            <span class="idm-confirm-url" title="${url}">${url}</span>
          </div>
          <div class="idm-confirm-msg">Start this accelerated multi-part download now?</div>
        </div>
        <div class="idm-confirm-footer">
          <button class="idm-btn idm-btn-cancel" id="idmBtnCancel">Cancel</button>
          <button class="idm-btn idm-btn-primary" id="idmBtnDownload">Download Now</button>
        </div>
      </div>
    `;

    confirmModal.classList.add('open');

    const close = () => confirmModal.classList.remove('open');
    document.getElementById('idmBtnCancelX')?.addEventListener('click', close);
    document.getElementById('idmBtnCancel')?.addEventListener('click', close);

    document.getElementById('idmBtnDownload')?.addEventListener('click', () => {
      close();
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_WITH_IDM',
          url,
          filename: cleanFn
        });
      }
    });
  }

  // Intercept clicks on downloadable links
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link || !link.href) return;

    if (isDownloadableUrl(link.href)) {
      e.preventDefault();
      e.stopPropagation();
      const fn = link.getAttribute('download') || getFilenameFromUrl(link.href);
      showConfirmationModal(link.href, fn);
    }
  }, true);

})();
