// Personal IDM Browser Content Script — Modern Video Downloader Widget

(function () {
  if (window.__personal_idm_injected__) return;
  window.__personal_idm_injected__ = true;

  let floatingBtn = null;
  let activeMediaEl = null;
  let hideTimeout = null;

  function isFullscreenActive() {
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      (window.innerWidth === screen.width && window.innerHeight === screen.height)
    );
  }

  function updateFullscreenClass() {
    if (isFullscreenActive()) {
      document.documentElement.classList.add('idm-is-fullscreen');
      document.body.classList.add('idm-is-fullscreen');
      hideFloatingButton();
    } else {
      document.documentElement.classList.remove('idm-is-fullscreen');
      document.body.classList.remove('idm-is-fullscreen');
    }
  }

  document.addEventListener('fullscreenchange', updateFullscreenClass);
  document.addEventListener('webkitfullscreenchange', updateFullscreenClass);
  document.addEventListener('mozfullscreenchange', updateFullscreenClass);
  window.addEventListener('resize', updateFullscreenClass);

  function resetBtnContent() {
    if (!floatingBtn) return;
    floatingBtn.classList.remove('loading');
    floatingBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      <span>Download this video</span>
    `;
  }

  function createFloatingButton() {
    if (floatingBtn) return floatingBtn;
    floatingBtn = document.createElement('div');
    floatingBtn.id = 'personal-idm-video-btn';
    resetBtnContent();

    floatingBtn.addEventListener('mouseenter', () => {
      if (hideTimeout) clearTimeout(hideTimeout);
    });

    floatingBtn.addEventListener('mouseleave', () => {
      scheduleHide();
    });

    floatingBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!activeMediaEl) return;

      let src = activeMediaEl.currentSrc || activeMediaEl.src;
      if (!src || src.startsWith('blob:') || src.startsWith('mediasource:')) {
        const sourceTag = activeMediaEl.querySelector('source[src]');
        if (sourceTag && sourceTag.src) src = sourceTag.src;
      }
      if (!src) {
        src = window.location.href;
      }

      let filename = '';
      try {
        const cleanTitle = (document.title || '').replace(/[^\w\s.-]/g, '').trim();
        filename = cleanTitle ? `${cleanTitle}.mp4` : 'video.mp4';
      } catch {
        filename = 'video.mp4';
      }

      floatingBtn.classList.add('loading');
      floatingBtn.innerHTML = `
        <svg class="idm-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-opacity="0.25"></circle>
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor"></path>
        </svg>
        <span>Sending to IDM...</span>
      `;

      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_WITH_IDM',
          url: src,
          filename
        }, () => {
          setTimeout(() => {
            resetBtnContent();
            hideFloatingButton();
          }, 700);
        });
      }
    });

    document.body.appendChild(floatingBtn);
    return floatingBtn;
  }

  function showFloatingButtonFor(el) {
    if (isFullscreenActive()) return;

    activeMediaEl = el;
    const btn = createFloatingButton();
    const rect = el.getBoundingClientRect();

    // Ignore tiny media elements (audio indicators, trackers)
    if (rect.width < 100 || rect.height < 60) return;

    if (hideTimeout) clearTimeout(hideTimeout);

    const btnWidth = 145;
    const topPos = Math.max(10, window.scrollY + rect.top + 10);
    const leftPos = Math.max(10, window.scrollX + rect.right - btnWidth - 14);

    btn.style.top = `${topPos}px`;
    btn.style.left = `${leftPos}px`;
    btn.classList.add('visible');
  }

  function scheduleHide() {
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      hideFloatingButton();
    }, 400);
  }

  function hideFloatingButton() {
    if (floatingBtn) {
      floatingBtn.classList.remove('visible');
    }
    activeMediaEl = null;
  }

  // Hover detection over media elements
  document.addEventListener('mouseover', (e) => {
    if (isFullscreenActive()) return;
    const target = e.target;
    if (target && (target.tagName === 'VIDEO' || target.tagName === 'AUDIO')) {
      showFloatingButtonFor(target);
    }
  }, true);

  document.addEventListener('mouseout', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'VIDEO' || target.tagName === 'AUDIO')) {
      scheduleHide();
    }
  }, true);

})();
