// Personal IDM Chrome/Edge Extension Background Service Worker

export const EXPECTED_API_VERSION = '1.0';
export const DEFAULT_CANDIDATE_PORTS = [1001, 10010, 10011, 10012, 10013, 10014];

let cachedSession = {
  port: null,
  token: null,
  apiVersion: null
};

async function loadStoredSession() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      const data = await chrome.storage.local.get(['idmPort', 'idmToken', 'idmApiVersion']);
      if (data.idmPort && data.idmToken) {
        cachedSession = {
          port: data.idmPort,
          token: data.idmToken,
          apiVersion: data.idmApiVersion || EXPECTED_API_VERSION
        };
      }
    } catch {}
  }
  return cachedSession;
}

async function saveStoredSession(session) {
  cachedSession = { ...session };
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      await chrome.storage.local.set({
        idmPort: session.port,
        idmToken: session.token,
        idmApiVersion: session.apiVersion
      });
    } catch {}
  }
}

export async function clearStoredSession() {
  cachedSession = { port: null, token: null, apiVersion: null };
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      await chrome.storage.local.remove(['idmPort', 'idmToken', 'idmApiVersion']);
    } catch {}
  }
}

/**
 * Probes a single port for a valid Personal IDM discovery endpoint
 */
export async function probePort(port, fetchImpl = fetch, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/v1/discovery`, {
      method: 'GET',
      signal: controller.signal
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (data && data.service === 'personal-idm' && data.apiVersion === EXPECTED_API_VERSION) {
      return data.port || port;
    }
  } catch {} finally {
    clearTimeout(timer);
  }
  return null;
}

/**
 * Performs an authenticated extension handshake with the discovered local server
 */
export async function handshakeWithPort(port, fetchImpl = fetch, customHeaders = {}) {
  const res = await fetchImpl(`http://127.0.0.1:${port}/api/v1/handshake`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...customHeaders
    },
    body: JSON.stringify({
      extensionVersion: '1.0.0',
      apiVersion: EXPECTED_API_VERSION
    })
  });
  if (!res.ok) {
    throw new Error(`Handshake failed with status ${res.status}`);
  }
  const data = await res.json();
  if (data.service !== 'personal-idm' || data.apiVersion !== EXPECTED_API_VERSION || !data.token) {
    throw new Error('Invalid handshake response from local server');
  }
  const session = {
    port: data.port || port,
    token: data.token,
    apiVersion: data.apiVersion
  };
  await saveStoredSession(session);
  return session;
}

/**
 * Discovers the active Personal IDM port and establishes an authenticated session
 */
export async function discoverSession(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const candidatePorts = options.candidatePorts || DEFAULT_CANDIDATE_PORTS;
  const customHeaders = options.headers || {};

  await loadStoredSession();

  // Check cached port first if available
  const portsToTry = cachedSession.port
    ? [cachedSession.port, ...candidatePorts.filter(p => p !== cachedSession.port)]
    : [...candidatePorts];

  for (const port of portsToTry) {
    const verifiedPort = await probePort(port, fetchImpl);
    if (verifiedPort) {
      // If we already have a cached token for this port, return it (will re-handshake if 401)
      if (cachedSession.port === verifiedPort && cachedSession.token) {
        return cachedSession;
      }
      return await handshakeWithPort(verifiedPort, fetchImpl, customHeaders);
    }
  }

  throw new Error('Personal IDM active instance could not be discovered on any candidate port');
}

/**
 * Sends a download request to Personal IDM with automatic discovery & failover recovery
 */
export async function sendToPersonalIDM(url, filename = '', options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const customHeaders = options.headers || {};

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const session = await discoverSession({
        fetchImpl,
        candidatePorts: options.candidatePorts,
        headers: customHeaders
      });

      const res = await fetchImpl(`http://127.0.0.1:${session.port}/api/download`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.token}`,
          ...customHeaders
        },
        body: JSON.stringify({
          url,
          filename,
          autoStart: options.autoStart !== undefined ? options.autoStart : false
        })
      });

      if (res.status === 401 || res.status === 403) {
        // Token rotated or app restarted; clear session and retry discovery on next iteration
        await clearStoredSession();
        continue;
      }

      if (res.ok) {
        return true;
      }
      return false;
    } catch {
      await clearStoredSession();
    }
  }
  return false;
}

// Register browser listeners only when running inside Chrome/Firefox/Edge extension environment
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: 'personal-idm-download-link',
      title: 'Download with Personal IDM',
      contexts: ['link', 'video', 'audio', 'image']
    });

    chrome.contextMenus.create({
      id: 'personal-idm-download-page',
      title: 'Download this page with Personal IDM',
      contexts: ['page']
    });
  });

  chrome.contextMenus.onClicked.addListener((info) => {
    const targetUrl = info.linkUrl || info.srcUrl || info.pageUrl;
    if (!targetUrl) return;
    sendToPersonalIDM(targetUrl, '', { autoStart: false });
  });

  // Handle messages from extension popup or other scripts
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'DOWNLOAD_WITH_IDM' && message.url) {
      sendToPersonalIDM(message.url, message.filename || '', { autoStart: false })
        .then((ok) => sendResponse({ success: ok }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // Keep message channel open for async response
    }
  });

  chrome.downloads.onCreated.addListener(async (downloadItem) => {
    if (downloadItem.url && (downloadItem.url.startsWith('http://') || downloadItem.url.startsWith('https://'))) {
      const success = await sendToPersonalIDM(downloadItem.url, downloadItem.filename, { autoStart: false });
      if (success) {
        try {
          await chrome.downloads.cancel(downloadItem.id);
          await chrome.downloads.erase({ id: downloadItem.id });
        } catch {}
      }
    }
  });
}
