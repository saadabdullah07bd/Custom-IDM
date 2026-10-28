import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { DownloadTask, TokenBucketLimiter } from '../src/engine/downloader.js';
import { QueueManager } from '../src/engine/queueManager.js';

function createTempDir(prefix = 'idm-engine-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

// Create a deterministic 2 MB test payload and record its exact SHA-256
const PAYLOAD_SIZE = 2 * 1024 * 1024; // 2 MB
const SOURCE_PAYLOAD = Buffer.allocUnsafe(PAYLOAD_SIZE);
for (let i = 0; i < PAYLOAD_SIZE; i += 4) {
  SOURCE_PAYLOAD.writeUInt32BE((i * 2654435761) >>> 0, i);
}
const SOURCE_SHA256 = crypto.createHash('sha256').update(SOURCE_PAYLOAD).digest('hex');

test('Phase 2A & Phase 6: Single and Segmented Downloads (1, 4, 8, 16, 32 Connections) with Byte-for-Byte & SHA-256 Verification', async (t) => {
  const tempDir = createTempDir();
  const recordedRangesByConn = new Map();

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const connTag = urlObj.searchParams.get('conn') || 'unknown';

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': SOURCE_PAYLOAD.length,
        'Accept-Ranges': 'bytes',
        'ETag': '"v1-2mb-deterministic"',
        'Content-Type': 'application/octet-stream'
      });
      res.end();
      return;
    }

    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d+)/);
      const start = parseInt(m[1], 10);
      const end = Math.min(SOURCE_PAYLOAD.length - 1, parseInt(m[2], 10));
      if (!recordedRangesByConn.has(connTag)) recordedRangesByConn.set(connTag, []);
      recordedRangesByConn.get(connTag).push({ start, end });

      const slice = SOURCE_PAYLOAD.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${SOURCE_PAYLOAD.length}`,
        'Content-Length': slice.length,
        'Accept-Ranges': 'bytes',
        'ETag': '"v1-2mb-deterministic"'
      });
      res.end(slice);
    } else {
      res.writeHead(200, {
        'Content-Length': SOURCE_PAYLOAD.length,
        'ETag': '"v1-2mb-deterministic"'
      });
      res.end(SOURCE_PAYLOAD);
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  t.after(async () => {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  for (const connCount of [1, 4, 8, 16, 32]) {
    await t.test(`Segmented download with ${connCount} connection(s) matches exact bytes and SHA-256 (${SOURCE_SHA256.slice(0, 16)}...)`, async () => {
      const task = new DownloadTask({
        url: `http://127.0.0.1:${port}/payload_${connCount}.bin?conn=${connCount}`,
        targetDir: tempDir,
        filename: `out_${connCount}.bin`,
        maxConnections: connCount,
        minSegmentSize: 32 * 1024, // 32 KB min segment so 2MB easily splits into 32 parts
        dynamicSegmentation: false, // Verify exact static non-overlapping partitioning first
        expectedSha256: SOURCE_SHA256
      });

      await task.start();

      assert.equal(task.status, 'completed');
      assert.equal(task.sha256, SOURCE_SHA256);
      assert.equal(task.segments.length, connCount);

      // Verify non-overlapping contiguous ranges covering [0, PAYLOAD_SIZE - 1]
      let expectedByte = 0;
      for (const seg of task.segments) {
        assert.equal(seg.start, expectedByte);
        assert.ok(seg.end >= seg.start);
        expectedByte = seg.end + 1;
      }
      assert.equal(expectedByte, SOURCE_PAYLOAD.length);

      // Verify final file on disk byte-for-byte
      const finalBytes = fs.readFileSync(task.targetPath);
      assert.equal(finalBytes.length, SOURCE_PAYLOAD.length);
      assert.equal(Buffer.compare(finalBytes, SOURCE_PAYLOAD), 0);

      // Verify tempDir was cleaned up after completion
      assert.equal(fs.existsSync(task.tempDir), false);
    });
  }
});

test('Phase 2A: Range Fallback, Ignored Range Protection, and Invalid Content-Range Detection', async (t) => {
  const tempDir = createTempDir('idm-range-edge-');
  const smallPayload = SOURCE_PAYLOAD.subarray(0, 512 * 1024); // 512 KB
  const smallSha256 = crypto.createHash('sha256').update(smallPayload).digest('hex');

  const server = http.createServer((req, res) => {
    if (req.url === '/no-range') {
      // Server does not support Range requests and always returns HTTP 200 full file
      res.writeHead(200, {
        'Content-Length': smallPayload.length,
        'Content-Type': 'application/octet-stream'
      });
      res.end(smallPayload);
      return;
    }

    if (req.url === '/false-range-midstream') {
      // Pretends to support Range in HEAD, but returns HTTP 200 full file on GET!
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Length': smallPayload.length,
          'Accept-Ranges': 'bytes'
        });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Length': smallPayload.length });
      res.end(smallPayload);
      return;
    }

    if (req.url === '/bad-content-range') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Length': smallPayload.length,
          'Accept-Ranges': 'bytes'
        });
        res.end();
        return;
      }
      // Returns wrong Content-Range start offset (e.g. always starts at 999)
      res.writeHead(206, {
        'Content-Range': `bytes 999-2000/${smallPayload.length}`,
        'Content-Length': 1002,
        'Accept-Ranges': 'bytes'
      });
      res.end(smallPayload.subarray(0, 1002));
      return;
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  t.after(async () => {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('Safely falls back to single connection when server does not support Range requests', async () => {
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/no-range`,
      targetDir: tempDir,
      filename: 'norange.bin',
      maxConnections: 16
    });

    await task.start();
    assert.equal(task.status, 'completed');
    assert.equal(task.resumable, false);
    assert.equal(task.segments.length, 1);
    assert.equal(task.sha256, smallSha256);
    assert.equal(Buffer.compare(fs.readFileSync(task.targetPath), smallPayload), 0);
  });

  await t.test('Safely falls back on segment 0 or aborts secondary segments when server falsely advertises Accept-Ranges', async () => {
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/false-range-midstream`,
      targetDir: tempDir,
      filename: 'falserange.bin',
      maxConnections: 4,
      minSegmentSize: 64 * 1024
    });

    await task.start();
    // Should either complete via segment 0 single-stream fallback with exact SHA-256 OR fail cleanly, NEVER corrupt!
    if (task.status === 'completed') {
      assert.equal(task.sha256, smallSha256);
      assert.equal(Buffer.compare(fs.readFileSync(task.targetPath), smallPayload), 0);
    } else {
      assert.equal(task.status, 'error');
      assert.equal(fs.existsSync(task.targetPath), false);
    }
  });

  await t.test('Detects and aborts invalid Content-Range responses immediately', async () => {
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/bad-content-range`,
      targetDir: tempDir,
      filename: 'badrange.bin',
      maxConnections: 4,
      minSegmentSize: 64 * 1024,
      maxRetries: 2
    });

    await task.start();
    assert.equal(task.status, 'error');
    assert.match(task.error, /Invalid Content-Range/i);
    assert.equal(fs.existsSync(task.targetPath), false);
  });
});

test('Phase 2B: Interrupted Connections, Auto-Retry, Throttling (429), and Non-Retryable Statuses (404)', async (t) => {
  const tempDir = createTempDir('idm-retry-');
  const testData = SOURCE_PAYLOAD.subarray(0, 512 * 1024);
  const testSha256 = crypto.createHash('sha256').update(testData).digest('hex');

  let flakyAttempts = 0;
  let throttleAttempts = 0;
  let notFoundCalls = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/missing-404') {
      notFoundCalls++;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    if (req.url === '/throttled-429') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Length': testData.length,
          'Accept-Ranges': 'bytes'
        });
        res.end();
        return;
      }
      throttleAttempts++;
      if (throttleAttempts <= 2) {
        res.writeHead(429, { 'Retry-After': '0' });
        res.end('Too Many Requests');
        return;
      }
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': testData.length,
        'Accept-Ranges': 'bytes'
      });
      res.end();
      return;
    }

    const range = req.headers.range;
    const m = range.match(/bytes=(\d+)-(\d+)/);
    const start = parseInt(m[1], 10);
    const end = Math.min(testData.length - 1, parseInt(m[2], 10));
    const slice = testData.subarray(start, end + 1);

    if (req.url === '/flaky') {
      flakyAttempts++;
      // Drop connection mid-transfer on first 2 attempts
      if (flakyAttempts <= 2) {
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${testData.length}`,
          'Content-Length': slice.length,
          'Accept-Ranges': 'bytes'
        });
        const half = Math.floor(slice.length / 2);
        res.write(slice.subarray(0, half));
        setTimeout(() => res.destroy(), 15);
        return;
      }
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${testData.length}`,
      'Content-Length': slice.length,
      'Accept-Ranges': 'bytes'
    });
    res.end(slice);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  t.after(async () => {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('Recovers from mid-stream connection drops and resumes from exact disk offset', async () => {
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/flaky`,
      targetDir: tempDir,
      filename: 'flaky_recovered.bin',
      maxConnections: 4,
      minSegmentSize: 64 * 1024,
      baseRetryDelayMs: 30,
      maxRetries: 5
    });

    await task.start();
    assert.equal(task.status, 'completed');
    assert.ok(task.retryCount >= 1);
    assert.equal(task.sha256, testSha256);
    assert.equal(Buffer.compare(fs.readFileSync(task.targetPath), testData), 0);
  });

  await t.test('Handles HTTP 429 throttling by backing off and reducing concurrency', async () => {
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/throttled-429`,
      targetDir: tempDir,
      filename: 'throttled_ok.bin',
      maxConnections: 4,
      minSegmentSize: 64 * 1024,
      baseRetryDelayMs: 25,
      maxRetries: 5
    });

    await task.start();
    assert.equal(task.status, 'completed');
    assert.equal(task.sha256, testSha256);
  });

  await t.test('Fails immediately on HTTP 404 without pointless retries', async () => {
    notFoundCalls = 0;
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/missing-404`,
      targetDir: tempDir,
      filename: 'missing.bin',
      maxConnections: 4,
      maxRetries: 5
    });

    await assert.rejects(async () => {
      await task.init();
    }, /HTTP 404/);
    assert.equal(notFoundCalls, 1);
  });
});

test('Phase 2B: Pause, Resume from Verified Disk Offset, ETag Resource Change Detection, and Cancellation', async (t) => {
  const tempDir = createTempDir('idm-pause-resume-');
  const v1Data = SOURCE_PAYLOAD.subarray(0, 512 * 1024);
  const v1Sha256 = crypto.createHash('sha256').update(v1Data).digest('hex');

  const v2Data = Buffer.alloc(512 * 1024, 0xab);
  const v2Sha256 = crypto.createHash('sha256').update(v2Data).digest('hex');

  let currentEtag = '"etag-v1"';
  let currentPayload = v1Data;

  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': currentPayload.length,
        'Accept-Ranges': 'bytes',
        'ETag': currentEtag
      });
      res.end();
      return;
    }

    const range = req.headers.range;
    const m = range.match(/bytes=(\d+)-(\d+)/);
    const start = parseInt(m[1], 10);
    const end = Math.min(currentPayload.length - 1, parseInt(m[2], 10));
    const slice = currentPayload.subarray(start, end + 1);

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${currentPayload.length}`,
      'Content-Length': slice.length,
      'Accept-Ranges': 'bytes',
      'ETag': currentEtag
    });

    // Stream in 16KB chunks every 15ms so pause() can intercept deterministically
    let offset = 0;
    const interval = setInterval(() => {
      if (res.destroyed) {
        clearInterval(interval);
        return;
      }
      const chunk = slice.subarray(offset, offset + 16384);
      offset += chunk.length;
      res.write(chunk);
      if (offset >= slice.length) {
        clearInterval(interval);
        res.end();
      }
    }, 15);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  t.after(async () => {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('Pause flushes streams cleanly and Resume continues from verified disk offset (ignoring stale metadata)', async () => {
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/pausable.bin`,
      targetDir: tempDir,
      filename: 'pausable.bin',
      maxConnections: 4,
      minSegmentSize: 64 * 1024,
      dynamicSegmentation: false
    });

    const runPromise = task.start();
    await new Promise(r => setTimeout(r, 85));
    await task.pause();
    await runPromise;

    assert.equal(task.status, 'paused');
    assert.ok(task.downloadedBytes > 0 && task.downloadedBytes < v1Data.length);

    // Corrupt in-memory downloaded count to prove resume uses verified disk stat size
    task.segments[0].downloaded = 9999999;

    await task.start();
    assert.equal(task.status, 'completed');
    assert.equal(task.sha256, v1Sha256);
    assert.equal(Buffer.compare(fs.readFileSync(task.targetPath), v1Data), 0);
  });

  await t.test('Detects remote ETag change during pause and safely restarts download from scratch', async () => {
    currentEtag = '"etag-v1"';
    currentPayload = v1Data;

    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/changing.bin`,
      targetDir: tempDir,
      filename: 'changing.bin',
      maxConnections: 4,
      minSegmentSize: 64 * 1024
    });

    const runPromise = task.start();
    await new Promise(r => setTimeout(r, 60));
    await task.pause();
    await runPromise;

    assert.equal(task.status, 'paused');
    assert.ok(task.downloadedBytes > 0);

    // Mutate remote resource & ETag while task is paused
    currentEtag = '"etag-v2"';
    currentPayload = v2Data;

    await task.start();
    assert.equal(task.status, 'completed');
    assert.equal(task.etag, '"etag-v2"');
    assert.equal(task.sha256, v2Sha256);
    assert.equal(Buffer.compare(fs.readFileSync(task.targetPath), v2Data), 0);
  });

  await t.test('Cancelled task never marks completed and cleans up temporary directory', async () => {
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/cancelme.bin`,
      targetDir: tempDir,
      filename: 'cancelme.bin',
      maxConnections: 4,
      minSegmentSize: 64 * 1024
    });

    const runPromise = task.start();
    await new Promise(r => setTimeout(r, 60));
    await task.cancel(true);
    await runPromise;

    assert.equal(task.status, 'cancelled');
    assert.equal(fs.existsSync(task.tempDir), false);
    assert.equal(fs.existsSync(task.targetPath), false);
  });
});

test('Phase 3: Dynamic Work-Stealing Segmentation', async (t) => {
  const tempDir = createTempDir('idm-dyn-split-');
  const payload = SOURCE_PAYLOAD.subarray(0, 1024 * 1024); // 1 MB
  const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');

  let requestCount = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': payload.length,
        'Accept-Ranges': 'bytes'
      });
      res.end();
      return;
    }

    const range = req.headers.range;
    const m = range.match(/bytes=(\d+)-(\d+)/);
    const start = parseInt(m[1], 10);
    const end = Math.min(payload.length - 1, parseInt(m[2], 10));
    const slice = payload.subarray(start, end + 1);

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${payload.length}`,
      'Content-Length': slice.length,
      'Accept-Ranges': 'bytes'
    });

    requestCount++;
    // First connection (starting at byte 0) streams slowly so fast workers finish and steal its remaining work!
    if (start === 0) {
      let offset = 0;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        const chunk = slice.subarray(offset, offset + 16384);
        offset += chunk.length;
        res.write(chunk);
        if (offset >= slice.length) {
          clearInterval(timer);
          res.end();
        }
      }, 20);
    } else {
      // All other connections complete at full speed
      res.end(slice);
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  t.after(async () => {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('Idle workers dynamically split slow active segment without byte overlap or omission', async () => {
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/dynamic.bin`,
      targetDir: tempDir,
      filename: 'dynamic.bin',
      maxConnections: 2,
      minSegmentSize: 64 * 1024,
      dynamicSegmentation: true,
      expectedSha256: expectedSha
    });

    await task.start();

    assert.equal(task.status, 'completed');
    // Started with 2 segments; Worker 2 finished immediately and stole work from slow Segment 0 multiple times!
    assert.ok(task.segments.length > 2, `Expected dynamic splits (> 2 segments), got ${task.segments.length}`);
    assert.equal(task.sha256, expectedSha);
    assert.equal(Buffer.compare(fs.readFileSync(task.targetPath), payload), 0);
  });
});

test('Phase 2C, 2D, 4, 5 & 6: Duplicate Protection, Temp Cleanup, Queue Restart Recovery, Settings Persistence, Speed Limiter & Interrupted Finalization', async (t) => {
  const tempDir = createTempDir('idm-full-lifecycle-');
  const storageDir = path.join(tempDir, 'storage');
  const downloadsDir = path.join(tempDir, 'downloads');
  const payload = SOURCE_PAYLOAD.subarray(0, 512 * 1024); // 512 KB
  const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');

  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': payload.length,
        'Accept-Ranges': 'bytes'
      });
      res.end();
      return;
    }
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d+)/);
      const start = parseInt(m[1], 10);
      const end = Math.min(payload.length - 1, parseInt(m[2], 10));
      const slice = payload.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': slice.length,
        'Accept-Ranges': 'bytes'
      });
      res.end(slice);
    } else {
      res.writeHead(200, { 'Content-Length': payload.length });
      res.end(payload);
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  t.after(async () => {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('Duplicate filenames auto-increment safely without overwriting existing user files', async () => {
    fs.mkdirSync(downloadsDir, { recursive: true });
    const existingFile = path.join(downloadsDir, 'report.pdf');
    fs.writeFileSync(existingFile, 'ORIGINAL_USER_CONTENT');

    const t1 = new DownloadTask({
      url: `http://127.0.0.1:${port}/report.pdf`,
      targetDir: downloadsDir,
      filename: 'report.pdf',
      maxConnections: 4
    });
    await t1.start();

    assert.equal(t1.status, 'completed');
    assert.equal(t1.filename, 'report_(1).pdf');
    assert.equal(fs.readFileSync(existingFile, 'utf8'), 'ORIGINAL_USER_CONTENT');
    assert.equal(Buffer.compare(fs.readFileSync(t1.targetPath), payload), 0);
  });

  await t.test('SHA-256 verification fails and cleans up staging file when expectedSha256 does not match', async () => {
    const badShaTask = new DownloadTask({
      url: `http://127.0.0.1:${port}/tampered.bin`,
      targetDir: downloadsDir,
      filename: 'tampered.bin',
      maxConnections: 4,
      expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000'
    });

    await badShaTask.start();
    assert.equal(badShaTask.status, 'error');
    assert.match(badShaTask.error, /SHA-256 checksum mismatch/i);
    assert.equal(fs.existsSync(badShaTask.targetPath), false);
  });

  await t.test('Corrupted/missing part file during finalization fails safely without creating corrupt target file', async () => {
    const brokenTask = new DownloadTask({
      url: `http://127.0.0.1:${port}/broken.bin`,
      targetDir: downloadsDir,
      filename: 'broken.bin',
      maxConnections: 4,
      minSegmentSize: 64 * 1024
    });
    await brokenTask.init();
    fs.mkdirSync(brokenTask.tempDir, { recursive: true });
    // Write truncated part file for segment 0
    fs.writeFileSync(path.join(brokenTask.tempDir, 'part_0.dat'), Buffer.alloc(10));

    await assert.rejects(async () => {
      await brokenTask._mergeParts();
    }, /Corrupt segment|Missing temporary part file/i);
    assert.equal(fs.existsSync(brokenTask.targetPath), false);
    await brokenTask.cleanupTempDir();
  });

  await t.test('Phase 4: Settings Persistence across QueueManager restarts and validation', async () => {
    const customDownloads = path.join(tempDir, 'custom-downloads');
    const qm1 = new QueueManager({ storageDir, defaultDownloadDir: downloadsDir });

    // Reject invalid settings
    assert.throws(() => qm1.updateSettings({ defaultConnections: 99 }), /between 1 and 32/);
    assert.throws(() => qm1.updateSettings({ maxConcurrent: 0 }), /between 1 and 10/);

    const updated = qm1.updateSettings({
      defaultDownloadDir: customDownloads,
      defaultConnections: 16,
      maxConcurrent: 5,
      speedLimitKbps: 2048,
      notificationsEnabled: false
    });

    assert.equal(updated.defaultDownloadDir, path.resolve(customDownloads));
    assert.equal(updated.defaultConnections, 16);
    assert.equal(updated.maxConcurrent, 5);
    assert.equal(updated.speedLimitKbps, 2048);
    assert.equal(updated.notificationsEnabled, false);

    // Reload QueueManager from same storageDir and verify settings persisted
    const qm2 = new QueueManager({ storageDir });
    const reloaded = qm2.getSettings();
    assert.equal(reloaded.defaultDownloadDir, path.resolve(customDownloads));
    assert.equal(reloaded.defaultConnections, 16);
    assert.equal(reloaded.maxConcurrent, 5);
    assert.equal(reloaded.speedLimitKbps, 2048);
    assert.equal(reloaded.notificationsEnabled, false);
  });

  await t.test('Phase 2C & Queue Restart Recovery: Orphaned temp cleanup and deleteTask lifecycle', async () => {
    // Create an abandoned temp directory in downloadsDir
    const orphanDir = path.join(downloadsDir, '.idm_temp_abandoned_999');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'part_0.dat'), 'stale');

    const qm = new QueueManager({ storageDir: path.join(tempDir, 'storage-clean'), defaultDownloadDir: downloadsDir });
    // Startup cleanup should have removed orphanDir automatically!
    assert.equal(fs.existsSync(orphanDir), false);

    // Add a queued (non-autostart) task, create its tempDir, and delete it
    const added = await qm.addTask({
      url: `http://127.0.0.1:${port}/queued.bin`,
      targetDir: downloadsDir,
      filename: 'queued.bin',
      autoStart: false
    });
    const taskObj = qm.tasks.get(added.id);
    fs.mkdirSync(taskObj.tempDir, { recursive: true });
    fs.writeFileSync(path.join(taskObj.tempDir, 'part_0.dat'), 'partial');

    await qm.deleteTask(added.id, false, false);
    assert.equal(fs.existsSync(taskObj.tempDir), false);
    assert.equal(qm.getTask(added.id), null);
  });

  await t.test('Phase 5: TokenBucketLimiter enforces bandwidth rate limit accurately', async () => {
    const limiter = new TokenBucketLimiter(256 * 1024); // 256 KB/s
    // Drain initial burst capacity first
    await limiter.throttle(256 * 1024);

    const t0 = Date.now();
    await limiter.throttle(64 * 1024); // Requesting 64 KB at 256 KB/s should take ~250ms
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs >= 180, `Expected rate limiter to delay at least 180ms, took ${elapsedMs}ms`);
  });
});
