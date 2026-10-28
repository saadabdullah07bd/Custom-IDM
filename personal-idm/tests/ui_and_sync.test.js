import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startLocalServer } from '../src/bridge/localServer.js';
import {
  discoverSession,
  sendToPersonalIDM,
  clearStoredSession
} from '../browser-extension/background.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
const VALID_EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopqrstuvwxzyabcdef';

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

// ============================================================================
// PART 1: MANDATORY TOOLBAR PRESERVATION & UI VERIFICATION
// ============================================================================

test('Mandatory Toolbar Preservation: Scheduler and Site Grabber buttons, bitmap assets, and dialogs', async () => {
  const indexHtml = await fs.promises.readFile(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  const styleCss = await fs.promises.readFile(path.join(RENDERER_DIR, 'style.css'), 'utf8');
  const appJs = await fs.promises.readFile(path.join(RENDERER_DIR, 'app.js'), 'utf8');

  // 1. Verify original toolbar bitmap sprite files exist on disk
  const normalBmp = path.join(RENDERER_DIR, 'assets', 'toolbar', '3d_large_3.bmp');
  const hotBmp = path.join(RENDERER_DIR, 'assets', 'toolbar', '3d_largeHot_3.bmp');
  assert.equal(fs.existsSync(normalBmp), true, 'Original 3d_large_3.bmp sprite must exist');
  assert.equal(fs.existsSync(hotBmp), true, 'Original 3d_largeHot_3.bmp hot sprite must exist');

  // 2. Verify #tbScheduler and #tbGrabber buttons exist in index.html in exact order
  const resumeIdx = indexHtml.indexOf('id="tbResume"');
  const stopIdx = indexHtml.indexOf('id="tbStop"');
  const stopAllIdx = indexHtml.indexOf('id="tbStopAll"');
  const deleteIdx = indexHtml.indexOf('id="tbDelete"');
  const deleteCompIdx = indexHtml.indexOf('id="tbDeleteCompleted"');
  const optionsIdx = indexHtml.indexOf('id="tbOptions"');
  const schedulerIdx = indexHtml.indexOf('id="tbScheduler"');
  const startQueueIdx = indexHtml.indexOf('id="tbStartQueue"');
  const stopQueueIdx = indexHtml.indexOf('id="tbStopQueue"');
  const grabberIdx = indexHtml.indexOf('id="tbGrabber"');

  assert.ok(schedulerIdx > optionsIdx, '#tbScheduler must appear after #tbOptions');
  assert.ok(startQueueIdx > schedulerIdx, '#tbStartQueue must appear after #tbScheduler');
  assert.ok(stopQueueIdx > startQueueIdx, '#tbStopQueue must appear after #tbStartQueue');
  assert.ok(grabberIdx > stopQueueIdx, '#tbGrabber must appear after #tbStopQueue');
  assert.ok(resumeIdx > 0 && stopIdx > resumeIdx && stopAllIdx > stopIdx && deleteIdx > stopAllIdx && deleteCompIdx > deleteIdx);

  // 3. Verify icon classes and labels on #tbScheduler and #tbGrabber
  assert.match(indexHtml, /id="tbScheduler"[\s\S]*?class="tb-icon icon-scheduler"[\s\S]*?<span class="tb-label">Scheduler<\/span>/);
  assert.match(indexHtml, /id="tbGrabber"[\s\S]*?class="tb-icon icon-grabber"[\s\S]*?<span class="tb-label">Grabber<\/span>/);

  // 4. Verify CSS sprite offsets remain untouched (-294px 0px for Scheduler, -420px 0px for Grabber)
  assert.match(styleCss, /\.icon-scheduler\s*\{\s*background-position:\s*-294px\s+0px;\s*\}/);
  assert.match(styleCss, /\.icon-grabber\s*\{\s*background-position:\s*-420px\s+0px;\s*\}/);

  // 5. Verify informative Scheduler & Site Grabber dialogs exist in index.html with honest status messaging
  assert.match(indexHtml, /id="schedulerDialogModal"/);
  assert.match(indexHtml, /Download Scheduler — Queue &amp; Timed Automation/);
  assert.match(indexHtml, /Timed Scheduling Not Yet Implemented in Current Build/);
  assert.match(indexHtml, /id="grabberDialogModal"/);
  assert.match(indexHtml, /IDM Site Grabber — Website Resource Collector/);
  assert.match(indexHtml, /Website Crawling Not Yet Implemented in Current Build/);

  // 6. Verify click handlers in app.js wire #tbScheduler and #tbGrabber to open their modals and close buttons close them
  assert.match(appJs, /getElementById\('tbScheduler'\)/);
  assert.match(appJs, /schedulerDialogModal\.classList\.add\('open'\)/);
  assert.match(appJs, /getElementById\('schedulerCloseBtn'\)/);
  assert.match(appJs, /getElementById\('schedulerOkBtn'\)/);

  assert.match(appJs, /getElementById\('tbGrabber'\)/);
  assert.match(appJs, /grabberDialogModal\.classList\.add\('open'\)/);
  assert.match(appJs, /getElementById\('grabberCloseBtn'\)/);
  assert.match(appJs, /getElementById\('grabberOkBtn'\)/);

  // 7. Verify modernized UI features exist (search/filter bar, sortable columns, inline status badges, multi-tab options)
  assert.match(indexHtml, /id="searchFilterInput"/);
  assert.match(indexHtml, /id="statusFilterSelect"/);
  assert.match(indexHtml, /sortable-th/);
  assert.match(indexHtml, /id="optionsDialogModal"/);
  assert.match(styleCss, /font-variant-numeric:\s*tabular-nums/);
});

// ============================================================================
// PART 2: 8-CASE EXTENSION <-> LOCAL SERVER SYNCHRONIZATION SUITE
// ============================================================================

test('Extension-Server Sync All 8 Cases: Port binding, fallback, discovery, restart recovery, non-IDM skip, 401/403 auth, and clean offline fallback', async () => {
  await clearStoredSession();
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'idm-sync-all8-'));
  const addedTasks = [];
  const mockQM = {
    defaultDownloadDir: tmpDir,
    getAllTasks: () => addedTasks,
    addTask: async (opts) => {
      const t = { id: `task_${addedTasks.length + 1}`, ...opts };
      addedTasks.push(t);
      return t;
    }
  };

  // Obtain 2 free ports by binding ephemeral servers first
  const probeFreePort = async () => {
    const s = http.createServer();
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    const p = s.address().port;
    await closeServer(s);
    return p;
  };

  const freePrimaryPort = await probeFreePort();
  const freeFallbackPort = await probeFreePort();

  // Case 1: Primary candidate port available -> Server binds to primary port
  const bridgePrimary = startLocalServer(mockQM, freePrimaryPort, {
    candidatePorts: [freePrimaryPort, freeFallbackPort],
    storageDir: path.join(tmpDir, 'case1')
  });
  await new Promise(r => bridgePrimary.once('listening', r));
  assert.equal(bridgePrimary.getActivePort(), freePrimaryPort, 'Case 1: Binds to primary port when available');
  await closeServer(bridgePrimary);

  // Case 2: Primary port occupied -> Server falls back to next candidate port (freeFallbackPort)
  const occupier = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'other-local-app' }));
  });
  await new Promise(r => occupier.listen(0, '127.0.0.1', r));
  const occupiedPort = occupier.address().port;

  const bridgeFallback = startLocalServer(mockQM, occupiedPort, {
    candidatePorts: [occupiedPort, freeFallbackPort],
    storageDir: path.join(tmpDir, 'case2')
  });
  await new Promise(r => bridgeFallback.once('listening', r));
  assert.equal(bridgeFallback.getActivePort(), freeFallbackPort, 'Case 2: Falls back to next candidate port when primary is occupied');

  // Case 3 & Case 5: Extension skips non-IDM service on occupiedPort and discovers & handshakes with bridgeFallback
  const session1 = await discoverSession({
    candidatePorts: [occupiedPort, freeFallbackPort],
    headers: { Origin: VALID_EXT_ORIGIN }
  });
  assert.equal(session1.port, freeFallbackPort, 'Case 3 & 5: Skips non-IDM server and discovers active Personal IDM port');
  assert.equal(session1.token, bridgeFallback.getAuthToken(), 'Case 3: Handshake returns active server token');

  // Case 6: Missing or invalid token -> Server returns 401
  const resMissingToken = await fetch(`http://127.0.0.1:${freeFallbackPort}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/file.zip' })
  });
  assert.equal(resMissingToken.status, 401, 'Case 6: Rejects missing token with 401');
  await resMissingToken.text();

  const resInvalidToken = await fetch(`http://127.0.0.1:${freeFallbackPort}/api/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer 0000000000000000000000000000000000000000000000000000000000000000'
    },
    body: JSON.stringify({ url: 'https://example.com/file.zip' })
  });
  assert.equal(resInvalidToken.status, 401, 'Case 6: Rejects invalid token with 401');
  await resInvalidToken.text();

  // Case 7: Unauthorized website origin -> Server rejects request (403) and does not start download
  const resWebOrigin = await fetch(`http://127.0.0.1:${freeFallbackPort}/api/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://evil-website.example',
      'Authorization': `Bearer ${bridgeFallback.getAuthToken()}`
    },
    body: JSON.stringify({ url: 'https://example.com/file.zip' })
  });
  assert.equal(resWebOrigin.status, 403, 'Case 7: Rejects unauthorized website Origin with 403');
  await resWebOrigin.text();
  assert.equal(addedTasks.length, 0, 'Case 7: Unauthorized origin must not start any download');

  // Case 4: App restarts and port/token changes -> Extension detects stale port/token and reconnects automatically
  await closeServer(bridgeFallback);
  const bridgeRestarted = startLocalServer(mockQM, 0, {
    storageDir: path.join(tmpDir, 'case4')
  });
  await new Promise(r => bridgeRestarted.once('listening', r));
  const restartedPort = bridgeRestarted.getActivePort();

  // Use a fast-failing fetch wrapper for closed port probing so Windows TCP SYN doesn't stall
  const fastFetch = (urlStr, opts) => {
    if (urlStr.includes(`:${freeFallbackPort}/`)) {
      return Promise.reject(new Error('ECONNREFUSED'));
    }
    return fetch(urlStr, opts);
  };

  const sentAfterRestart = await sendToPersonalIDM(
    'https://example.com/recovered.zip',
    'recovered.zip',
    {
      fetchImpl: fastFetch,
      candidatePorts: [occupiedPort, freeFallbackPort, restartedPort],
      headers: { Origin: VALID_EXT_ORIGIN }
    }
  );
  assert.equal(sentAfterRestart, true, 'Case 4: Extension automatically reconnects after app restart and port change');
  assert.equal(addedTasks.length, 1);
  assert.equal(addedTasks[0].filename, 'recovered.zip');

  await closeServer(bridgeRestarted);
  await closeServer(occupier);

  // Case 8: Server unavailable or times out -> Extension fails cleanly (returns false) without throwing
  const offlineFetch = () => Promise.reject(new Error('ECONNREFUSED'));
  const sentWhenOffline = await sendToPersonalIDM(
    'https://example.com/offline.zip',
    'offline.zip',
    {
      fetchImpl: offlineFetch,
      candidatePorts: [freePrimaryPort, freeFallbackPort]
    }
  );
  assert.equal(sentWhenOffline, false, 'Case 8: Returns false cleanly when local server is unavailable');

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});
