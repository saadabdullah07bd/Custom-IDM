import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DownloadTask } from '../src/engine/downloader.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idm-bench-'));

// Deterministic 8 MB buffer for benchmarks
const BENCH_SIZE = 8 * 1024 * 1024;
const BENCH_BUF = Buffer.allocUnsafe(BENCH_SIZE);
for (let i = 0; i < BENCH_SIZE; i += 4) {
  BENCH_BUF.writeUInt32BE((i * 1664525 + 1013904223) >>> 0, i);
}
const BENCH_SHA256 = crypto.createHash('sha256').update(BENCH_BUF).digest('hex');

async function runBenchmarks() {
  console.log('==============================================================');
  console.log(' Personal IDM — Reproducible Local Benchmark Suite');
  console.log(` Environment: Node ${process.version} (${process.platform}/${process.arch})`);
  console.log(` Source Payload Size: ${(BENCH_SIZE / (1024 * 1024)).toFixed(2)} MB`);
  console.log(` Source SHA-256: ${BENCH_SHA256}`);
  console.log('==============================================================\n');

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const mode = urlObj.searchParams.get('mode') || 'fast';
    const size = parseInt(urlObj.searchParams.get('size') || String(BENCH_SIZE), 10);
    const payload = BENCH_BUF.subarray(0, size);

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': payload.length,
        'Accept-Ranges': 'bytes'
      });
      res.end();
      return;
    }

    const range = req.headers.range;
    const m = range ? range.match(/bytes=(\d+)-(\d+)/) : null;
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m ? Math.min(payload.length - 1, parseInt(m[2], 10)) : (payload.length - 1);
    const slice = payload.subarray(start, end + 1);

    res.writeHead(m ? 206 : 200, {
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}),
      'Content-Length': slice.length,
      'Accept-Ranges': 'bytes'
    });

    if (mode === 'straggler' && start === 0) {
      // Simulate a slow straggler on the first segment (32 KB every 25ms = ~1.28 MB/s)
      let offset = 0;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        const chunk = slice.subarray(offset, offset + 32768);
        offset += chunk.length;
        res.write(chunk);
        if (offset >= slice.length) {
          clearInterval(timer);
          res.end();
        }
      }, 25);
      return;
    }

    if (mode === 'per-socket-cap') {
      // Simulate per-socket bandwidth cap (64 KB every 15ms = ~4.2 MB/s per connection)
      let offset = 0;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        const chunk = slice.subarray(offset, offset + 65536);
        offset += chunk.length;
        res.write(chunk);
        if (offset >= slice.length) {
          clearInterval(timer);
          res.end();
        }
      }, 15);
      return;
    }

    res.end(slice);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 1. Merge Strategy Benchmark (Stream vs Positional on 8 MB across 16 segments)
    console.log('--- Benchmark 1: File Finalization Strategy (8 MB, 16 Segments) ---');
    for (const strategy of ['stream', 'positional']) {
      const t0 = performance.now();
      const task = new DownloadTask({
        url: `http://127.0.0.1:${port}/merge_${strategy}.bin?mode=fast`,
        targetDir: tempDir,
        filename: `merge_${strategy}.bin`,
        maxConnections: 16,
        minSegmentSize: 128 * 1024,
        dynamicSegmentation: false,
        mergeStrategy: strategy,
        expectedSha256: BENCH_SHA256
      });
      await task.start();
      const elapsed = performance.now() - t0;
      console.log(`  Strategy [${strategy.padEnd(10)}]: ${elapsed.toFixed(2)} ms | SHA-256 Verified: ${task.sha256 === BENCH_SHA256}`);
    }

    // 2. Static vs Dynamic Work-Stealing Segmentation under Straggler Conditions (2 MB, 4 Connections)
    const stragglerSize = 2 * 1024 * 1024;
    const stragglerSha = crypto.createHash('sha256').update(BENCH_BUF.subarray(0, stragglerSize)).digest('hex');
    console.log('\n--- Benchmark 2: Static vs Dynamic Work-Stealing Segmentation (2 MB, 4 Conns, Slow Segment 0) ---');
    for (const dyn of [false, true]) {
      const label = dyn ? 'Dynamic Work-Stealing' : 'Static Segmentation  ';
      const t0 = performance.now();
      const task = new DownloadTask({
        url: `http://127.0.0.1:${port}/straggler_${dyn}.bin?mode=straggler&size=${stragglerSize}`,
        targetDir: tempDir,
        filename: `straggler_${dyn}.bin`,
        maxConnections: 4,
        minSegmentSize: 64 * 1024,
        dynamicSegmentation: dyn,
        expectedSha256: stragglerSha
      });
      await task.start();
      const elapsed = performance.now() - t0;
      console.log(`  [${label}]: ${elapsed.toFixed(2)} ms | Final Segments: ${task.segments.length} | SHA-256 Match: ${task.sha256 === stragglerSha}`);
    }

    // 3. Per-Socket Bandwidth Cap Scaling (2 MB file, ~4.2 MB/s cap per socket)
    console.log('\n--- Benchmark 3: Multi-Connection Scaling on Per-Socket Rate-Capped Server (2 MB) ---');
    for (const conns of [1, 4, 8, 16]) {
      const t0 = performance.now();
      const task = new DownloadTask({
        url: `http://127.0.0.1:${port}/scale_${conns}.bin?mode=per-socket-cap&size=${stragglerSize}`,
        targetDir: tempDir,
        filename: `scale_${conns}.bin`,
        maxConnections: conns,
        minSegmentSize: 64 * 1024,
        dynamicSegmentation: true,
        expectedSha256: stragglerSha
      });
      await task.start();
      const elapsed = performance.now() - t0;
      const mbps = ((stragglerSize / (1024 * 1024)) / (elapsed / 1000)).toFixed(2);
      console.log(`  Connections [${String(conns).padStart(2)}]: ${elapsed.toFixed(2)} ms | Effective Throughput: ${mbps} MB/s | SHA-256 Match: ${task.sha256 === stragglerSha}`);
    }
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runBenchmarks().catch((err) => {
  console.error(err);
  process.exit(1);
});
