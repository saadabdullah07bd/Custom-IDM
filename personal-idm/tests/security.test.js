import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { DownloadTask, probeUrl } from '../src/engine/downloader.js';
import { QueueManager } from '../src/engine/queueManager.js';
import { startLocalServer } from '../src/bridge/localServer.js';
import { discoverSession, sendToPersonalIDM } from '../browser-extension/background.js';
import { generateTestCertificate } from './helpers/tlsFixtures.js';

function createTempWorkspace(prefix = 'idm-sec-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

test('Phase 1A: HTTPS Certificate Verification & Insecure Redirect Protection', async (t) => {
  const tempDir = createTempWorkspace();
  const payload = crypto.randomBytes(300 * 1024); // 300 KB
  const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

  const validTls = generateTestCertificate({ expired: false });
  const expiredTls = generateTestCertificate({ expired: true });

  const httpsValidServer = https.createServer({ key: validTls.key, cert: validTls.cert }, (req, res) => {
    if (req.url === '/downgrade') {
      res.writeHead(302, { Location: 'http://127.0.0.1:80/insecure.bin' });
      res.end();
      return;
    }

    const range = req.headers.range;
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': payload.length,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream'
      });
      res.end();
      return;
    }

    if (range) {
      const m = range.match(/bytes=(\d+)-(\d+)/);
      const start = parseInt(m[1], 10);
      const end = Math.min(payload.length - 1, parseInt(m[2], 10));
      const chunk = payload.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': chunk.length,
        'Accept-Ranges': 'bytes'
      });
      res.end(chunk);
    } else {
      res.writeHead(200, { 'Content-Length': payload.length });
      res.end(payload);
    }
  });

  const httpsExpiredServer = https.createServer({ key: expiredTls.key, cert: expiredTls.cert }, (req, res) => {
    res.writeHead(200, { 'Content-Length': payload.length });
    res.end(payload);
  });

  await new Promise(r => httpsValidServer.listen(0, '127.0.0.1', r));
  await new Promise(r => httpsExpiredServer.listen(0, '127.0.0.1', r));

  const validPort = httpsValidServer.address().port;
  const expiredPort = httpsExpiredServer.address().port;

  t.after(async () => {
    await closeServer(httpsValidServer);
    await closeServer(httpsExpiredServer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('Rejects untrusted self-signed certificate by default (rejectUnauthorized: true)', async () => {
    await assert.rejects(
      async () => {
        await probeUrl(`https://127.0.0.1:${validPort}/secure.bin`);
      },
      (err) => {
        assert.match(err.message, /TLS certificate validation failed/i);
        return true;
      }
    );
  });

  await t.test('Rejects expired certificate even when CA is provided', async () => {
    await assert.rejects(
      async () => {
        await probeUrl(`https://127.0.0.1:${expiredPort}/expired.bin`, {}, {
          tlsOptions: { ca: expiredTls.ca }
        });
      },
      (err) => {
        assert.match(err.message, /TLS certificate validation failed/i);
        return true;
      }
    );
  });

  await t.test('Rejects HTTPS to HTTP redirect downgrade', async () => {
    await assert.rejects(
      async () => {
        await probeUrl(`https://127.0.0.1:${validPort}/downgrade`, {}, {
          tlsOptions: { ca: validTls.ca }
        });
      },
      (err) => {
        assert.match(err.message, /Refusing insecure redirect downgrade from HTTPS to HTTP/i);
        return true;
      }
    );
  });

  await t.test('Succeeds with valid certificate when CA is trusted and matches SHA-256', async () => {
    const task = new DownloadTask({
      url: `https://127.0.0.1:${validPort}/verified_https.bin`,
      targetDir: tempDir,
      maxConnections: 4,
      minSegmentSize: 32 * 1024,
      tlsOptions: { ca: validTls.ca }
    });

    await task.start();
    assert.equal(task.status, 'completed');
    assert.equal(task.sha256, expectedHash);
    const downloadedBuf = fs.readFileSync(task.targetPath);
    assert.equal(Buffer.compare(downloadedBuf, payload), 0);
  });
});

test('Phase 1B: Local Integration API Security, Auth, CORS & Input Validation', async (t) => {
  const tempDir = createTempWorkspace('idm-bridge-sec-');
  const qm = new QueueManager({
    storageDir: path.join(tempDir, 'storage'),
    defaultDownloadDir: path.join(tempDir, 'downloads')
  });

  // Dummy file server for valid downloads
  const fileBuf = Buffer.from('Hello from secure local test server!');
  const fileServer = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Length': fileBuf.length,
      'Content-Type': 'text/plain'
    });
    res.end(fileBuf);
  });
  await new Promise(r => fileServer.listen(0, '127.0.0.1', r));
  const fileServerPort = fileServer.address().port;

  let bridgeServer = null;

  t.after(async () => {
    await qm.pauseAll();
    await closeServer(bridgeServer);
    await closeServer(fileServer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('Refuses binding to non-loopback interfaces (0.0.0.0 / public IP)', () => {
    assert.throws(() => {
      startLocalServer(qm, 0, { host: '0.0.0.0', storageDir: path.join(tempDir, 'storage') });
    }, /Security Violation/i);

    assert.throws(() => {
      startLocalServer(qm, 0, { host: '192.168.1.50', storageDir: path.join(tempDir, 'storage') });
    }, /Security Violation/i);
  });

  bridgeServer = startLocalServer(qm, 0, { storageDir: path.join(tempDir, 'storage') });
  await new Promise(r => bridgeServer.once('listening', r));
  const bridgePort = bridgeServer.getActivePort();
  const validToken = bridgeServer.getAuthToken();

  await t.test('Rejects unauthenticated requests with 401 Unauthorized', async () => {
    const res1 = await fetch(`http://127.0.0.1:${bridgePort}/api/tasks`);
    assert.equal(res1.status, 401);

    const res2 = await fetch(`http://127.0.0.1:${bridgePort}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${fileServerPort}/test.txt` })
    });
    assert.equal(res2.status, 401);
  });

  await t.test('Rejects unauthorized web origins (https://evil.com) even with valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/api/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://evil.example.com',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({ url: `http://127.0.0.1:${fileServerPort}/test.txt` })
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  await t.test('Permits valid browser extension Origin handshake and echoes exact Origin (never wildcard *)', async () => {
    const extOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const res = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': extOrigin
      },
      body: JSON.stringify({ extensionVersion: '1.0.0', apiVersion: '1.0' })
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), extOrigin);
    const data = await res.json();
    assert.equal(data.token, validToken);
    assert.equal(data.apiVersion, '1.0');
  });

  await t.test('Validates URL schemes, blocks path traversal, and enforces 16KB body limit', async () => {
    // 1. Disallowed scheme (file://)
    const badSchemeRes = await fetch(`http://127.0.0.1:${bridgePort}/api/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({ url: 'file:///C:/Windows/win.ini' })
    });
    assert.equal(badSchemeRes.status, 400);

    // 2. Path traversal in targetDir
    const badDirRes = await fetch(`http://127.0.0.1:${bridgePort}/api/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        url: `http://127.0.0.1:${fileServerPort}/test.txt`,
        targetDir: path.join(tempDir, '..', 'outside')
      })
    });
    assert.equal(badDirRes.status, 400);

    // 3. Malformed JSON
    const badJsonRes = await fetch(`http://127.0.0.1:${bridgePort}/api/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: '{bad_json'
    });
    assert.equal(badJsonRes.status, 400);

    // 4. Oversized body (> 16 KB)
    const hugeBody = JSON.stringify({
      url: `http://127.0.0.1:${fileServerPort}/test.txt`,
      padding: 'A'.repeat(24 * 1024)
    });
    const oversizedRes = await fetch(`http://127.0.0.1:${bridgePort}/api/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: hugeBody
    });
    assert.equal(oversizedRes.status, 413);
  });
});

test('Phase 1C: Port Discovery, Conflict Failover, and Restart Recovery', async (t) => {
  const tempDir = createTempWorkspace('idm-port-disc-');
  const qm = new QueueManager({
    storageDir: path.join(tempDir, 'storage'),
    defaultDownloadDir: path.join(tempDir, 'downloads')
  });

  const payload = Buffer.from('Payload for extension port discovery test');
  const fileServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': payload.length });
    res.end(payload);
  });
  await new Promise(r => fileServer.listen(0, '127.0.0.1', r));
  const fileServerPort = fileServer.address().port;

  // Create a dummy non-IDM server occupying the first candidate port
  const fakeOccupier = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'unrelated-windows-service' }));
  });
  await new Promise(r => fakeOccupier.listen(0, '127.0.0.1', r));
  const occupiedPort = fakeOccupier.address().port;

  let server1 = null;
  let server2 = null;

  t.after(async () => {
    await qm.pauseAll();
    await closeServer(fakeOccupier);
    await closeServer(server1);
    await closeServer(server2);
    await closeServer(fileServer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Start bridge server on an ephemeral port and test discovery skipping occupiedPort
  server1 = startLocalServer(qm, 0, {
    storageDir: path.join(tempDir, 'storage'),
    authToken: crypto.randomBytes(32).toString('hex')
  });
  await new Promise(r => server1.once('listening', r));
  const activePort1 = server1.getActivePort();

  const extHeaders = { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' };

  // 1. Extension discovers activePort1 while skipping occupiedPort
  const session1 = await discoverSession({
    candidatePorts: [occupiedPort, activePort1],
    headers: extHeaders
  });
  assert.equal(session1.port, activePort1);
  assert.equal(session1.token, server1.getAuthToken());

  // 2. Simulate application restart on a NEW port with a NEW auth token
  await closeServer(server1);

  server2 = startLocalServer(qm, 0, {
    storageDir: path.join(tempDir, 'storage2'),
    authToken: crypto.randomBytes(32).toString('hex')
  });
  await new Promise(r => server2.once('listening', r));
  const activePort2 = server2.getActivePort();

  // Extension automatically detects dead server1, re-discovers server2, handshakes, and starts download
  const sent = await sendToPersonalIDM(
    `http://127.0.0.1:${fileServerPort}/discovered_file.bin`,
    'discovered_file.bin',
    {
      candidatePorts: [occupiedPort, activePort1, activePort2],
      headers: extHeaders
    }
  );
  assert.equal(sent, true);

  // Wait briefly for download completion
  await new Promise(r => setTimeout(r, 150));
  const tasks = qm.getAllTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].filename, 'discovered_file.bin');
});
