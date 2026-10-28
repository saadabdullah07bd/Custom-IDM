import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// Dedicated high-capacity agents with strict TLS verification enabled
const defaultHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 128,
  timeout: 60000
});

const defaultHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 128,
  timeout: 60000,
  rejectUnauthorized: true
});

function getAgentForUrl(urlObj, tlsOptions = null) {
  if (urlObj.protocol === 'https:') {
    if (tlsOptions && tlsOptions.ca) {
      return new https.Agent({
        keepAlive: true,
        maxSockets: 128,
        timeout: 60000,
        rejectUnauthorized: true,
        ca: tlsOptions.ca
      });
    }
    return defaultHttpsAgent;
  }
  return defaultHttpAgent;
}

function sleep(ms, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

/**
 * Token Bucket Rate Limiter for smooth bandwidth throttling
 */
export class TokenBucketLimiter {
  constructor(bytesPerSec = 0) {
    this.setRate(bytesPerSec);
  }

  setRate(bytesPerSec) {
    this.rate = Math.max(0, Number(bytesPerSec) || 0);
    this.capacity = this.rate > 0 ? Math.max(this.rate, 64 * 1024) : 0;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  async throttle(bytes, signal = null) {
    if (this.rate <= 0 || bytes <= 0) return;

    let remaining = bytes;
    while (remaining > 0) {
      if (signal?.aborted) return;
      const now = Date.now();
      const elapsedSec = Math.max(0, (now - this.lastRefill) / 1000);
      if (elapsedSec > 0) {
        this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate);
        this.lastRefill = now;
      }

      if (this.tokens >= remaining) {
        this.tokens -= remaining;
        return;
      }

      if (this.tokens > 0) {
        remaining -= this.tokens;
        this.tokens = 0;
      }

      const waitMs = Math.min(250, Math.max(15, Math.ceil((remaining / this.rate) * 1000)));
      await sleep(waitMs, signal);
    }
  }
}

/**
 * Extracts a safe filename from the Content-Disposition header
 */
export function parseFilenameFromHeader(header) {
  if (!header) return null;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return sanitizeDownloadFilename(decodeURIComponent(utf8Match[1]));
    } catch {}
  }
  const match = header.match(/filename=["']?([^"';]+)["']?/i);
  if (match && match[1]) {
    return sanitizeDownloadFilename(match[1].trim());
  }
  return null;
}

export function sanitizeDownloadFilename(name) {
  if (!name || typeof name !== 'string') return '';
  let base = path.basename(name.trim().replace(/\\/g, '/'));
  base = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  if (base === '.' || base === '..' || base.startsWith('.idm_temp_')) {
    return '';
  }
  return base.slice(0, 240);
}

/**
 * Categorizes a file based on extension
 */
export function getCategoryByFilename(filename) {
  const ext = path.extname(filename || '').toLowerCase().replace('.', '');
  const categories = {
    compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz', 'dmg'],
    documents: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'csv'],
    music: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'alac', 'opus'],
    programs: ['exe', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'apk', 'pkg', 'deb', 'rpm'],
    video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ts']
  };

  for (const [cat, exts] of Object.entries(categories)) {
    if (exts.includes(ext)) return cat;
  }
  return 'general';
}

/**
 * Returns human-readable category folder matching IDM
 */
export function getCategoryFolderName(category) {
  switch (category) {
    case 'compressed': return 'Compressed';
    case 'documents': return 'Documents';
    case 'music': return 'Music';
    case 'programs': return 'Programs';
    case 'video': return 'Video';
    default: return 'General';
  }
}

/**
 * Dynamically determines optimal thread count based on payload size & range support
 */
export function calculateOptimalConnections(totalBytes, resumable = true) {
  if (!resumable || !totalBytes || totalBytes <= 0) return 1;
  if (totalBytes < 1024 * 1024) return 1;             // < 1 MB: 1 connection
  if (totalBytes < 10 * 1024 * 1024) return 4;        // 1 - 10 MB: 4 connections
  if (totalBytes < 100 * 1024 * 1024) return 8;       // 10 - 100 MB: 8 connections
  if (totalBytes < 500 * 1024 * 1024) return 16;      // 100 - 500 MB: 16 connections
  return 32;                                          // > 500 MB: 32 connections
}

function formatNetworkError(err) {
  if (!err) return new Error('Unknown network error');
  const code = err.code || '';
  if (
    code.includes('CERT_') ||
    code.includes('UNABLE_TO_VERIFY') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    (err.message && /certificate|tls|ssl/i.test(err.message))
  ) {
    const tlsErr = new Error(`TLS certificate validation failed (${code || err.message})`);
    tlsErr.code = code || 'ERR_TLS_VALIDATION';
    tlsErr.isFatal = true;
    return tlsErr;
  }
  return err;
}

const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 405, 410, 416]);
const THROTTLE_STATUS_CODES = new Set([429, 503]);

/**
 * Probes target URL for size, resume support, validators (ETag/Last-Modified), and filename
 */
export async function probeUrl(urlStr, headers = {}, options = {}) {
  let currentUrl = urlStr;
  let redirects = 0;
  const maxRedirects = 10;
  const timeoutMs = options.timeoutMs || 12000;
  const tlsOptions = options.tlsOptions || null;

  while (redirects < maxRedirects) {
    let urlObj;
    try {
      urlObj = new URL(currentUrl);
    } catch {
      const err = new Error(`Invalid URL: ${currentUrl}`);
      err.isFatal = true;
      throw err;
    }

    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      const err = new Error(`Unsupported protocol "${urlObj.protocol}". Only http: and https: are allowed.`);
      err.isFatal = true;
      throw err;
    }

    const client = urlObj.protocol === 'https:' ? https : http;
    const agent = getAgentForUrl(urlObj, tlsOptions);

    const res = await new Promise((resolve, reject) => {
      const req = client.request(currentUrl, {
        method: 'HEAD',
        agent,
        ...(tlsOptions?.ca ? { ca: tlsOptions.ca } : {}),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
          'Connection': 'keep-alive',
          ...headers
        }
      }, (response) => {
        response.resume();
        resolve(response);
      });

      req.on('error', (err) => reject(formatNetworkError(err)));
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Probe timeout')));

      if (options.signal) {
        if (options.signal.aborted) {
          req.destroy(new Error('Aborted'));
          return reject(new Error('Aborted'));
        }
        options.signal.addEventListener('abort', () => {
          req.destroy(new Error('Aborted'));
          reject(new Error('Aborted'));
        }, { once: true });
      }

      req.end();
    });

    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      const nextUrlObj = new URL(res.headers.location, currentUrl);
      if (urlObj.protocol === 'https:' && nextUrlObj.protocol === 'http:') {
        const downgradeErr = new Error('Refusing insecure redirect downgrade from HTTPS to HTTP');
        downgradeErr.code = 'ERR_HTTPS_DOWNGRADE';
        downgradeErr.isFatal = true;
        throw downgradeErr;
      }
      currentUrl = nextUrlObj.href;
      redirects++;
      continue;
    }

    // If HEAD is not allowed or rejected, fall back to ranged GET probe
    if (res.statusCode === 405 || res.statusCode === 501 || res.statusCode === 400) {
      return await probeUrlWithGet(currentUrl, headers, options, redirects);
    }

    if (res.statusCode >= 400) {
      const statusErr = new Error(`Server returned HTTP ${res.statusCode} during probe`);
      statusErr.statusCode = res.statusCode;
      if (NON_RETRYABLE_STATUS_CODES.has(res.statusCode)) statusErr.isFatal = true;
      throw statusErr;
    }

    const contentLength = parseInt(res.headers['content-length'] || '0', 10);
    const acceptRanges = (res.headers['accept-ranges'] || '').toLowerCase() === 'bytes' || res.headers['content-range'] !== undefined;

    // If HEAD didn't advertise Accept-Ranges, verify with a 1-byte Range GET probe
    if (!acceptRanges && contentLength > 0) {
      try {
        const getProbe = await probeUrlWithGet(currentUrl, headers, options, redirects);
        return getProbe;
      } catch {
        // Ignore fallback failure if HEAD succeeded
      }
    }

    let filename = parseFilenameFromHeader(res.headers['content-disposition']);
    if (!filename) {
      try {
        const base = path.basename(new URL(currentUrl).pathname);
        if (base && base !== '/' && base !== '.') filename = sanitizeDownloadFilename(decodeURIComponent(base));
      } catch {}
    }
    if (!filename) filename = 'download_' + Date.now();

    return {
      finalUrl: currentUrl,
      statusCode: res.statusCode,
      contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0,
      acceptRanges,
      etag: res.headers['etag'] || null,
      lastModified: res.headers['last-modified'] || null,
      filename,
      contentType: res.headers['content-type'] || 'application/octet-stream'
    };
  }

  throw new Error('Too many redirects');
}

async function probeUrlWithGet(urlStr, headers = {}, options = {}, initialRedirects = 0) {
  let currentUrl = urlStr;
  let redirects = initialRedirects;
  const maxRedirects = 10;
  const timeoutMs = options.timeoutMs || 12000;
  const tlsOptions = options.tlsOptions || null;

  while (redirects < maxRedirects) {
    const urlObj = new URL(currentUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const agent = getAgentForUrl(urlObj, tlsOptions);

    const result = await new Promise((resolve, reject) => {
      const req = client.request(currentUrl, {
        method: 'GET',
        agent,
        ...(tlsOptions?.ca ? { ca: tlsOptions.ca } : {}),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Range': 'bytes=0-0',
          'Accept-Encoding': 'identity',
          ...headers
        }
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.destroy();
          return resolve({ redirectLocation: res.headers.location });
        }

        if (res.statusCode >= 400) {
          res.destroy();
          const statusErr = new Error(`Server returned HTTP ${res.statusCode}`);
          statusErr.statusCode = res.statusCode;
          if (NON_RETRYABLE_STATUS_CODES.has(res.statusCode)) statusErr.isFatal = true;
          return reject(statusErr);
        }

        let totalLength = 0;
        let acceptRanges = false;

        if (res.statusCode === 206 && res.headers['content-range']) {
          acceptRanges = true;
          const match = res.headers['content-range'].match(/bytes\s+\d+-\d+\/(\d+)/i);
          if (match) totalLength = parseInt(match[1], 10);
        } else if (res.headers['content-length']) {
          totalLength = parseInt(res.headers['content-length'], 10);
          if ((res.headers['accept-ranges'] || '').toLowerCase() === 'bytes' && res.statusCode === 206) {
            acceptRanges = true;
          }
        }

        let filename = parseFilenameFromHeader(res.headers['content-disposition']);
        if (!filename) {
          try {
            const base = path.basename(new URL(currentUrl).pathname);
            if (base && base !== '/' && base !== '.') filename = sanitizeDownloadFilename(decodeURIComponent(base));
          } catch {}
        }
        if (!filename) filename = 'download_' + Date.now();

        res.destroy();

        resolve({
          finalUrl: currentUrl,
          statusCode: res.statusCode,
          contentLength: Number.isFinite(totalLength) && totalLength > 0 ? totalLength : 0,
          acceptRanges,
          etag: res.headers['etag'] || null,
          lastModified: res.headers['last-modified'] || null,
          filename,
          contentType: res.headers['content-type'] || 'application/octet-stream'
        });
      });

      req.on('error', (err) => reject(formatNetworkError(err)));
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Probe timeout')));

      if (options.signal) {
        if (options.signal.aborted) {
          req.destroy(new Error('Aborted'));
          return reject(new Error('Aborted'));
        }
        options.signal.addEventListener('abort', () => {
          req.destroy(new Error('Aborted'));
          reject(new Error('Aborted'));
        }, { once: true });
      }

      req.end();
    });

    if (result.redirectLocation) {
      const nextUrlObj = new URL(result.redirectLocation, currentUrl);
      if (urlObj.protocol === 'https:' && nextUrlObj.protocol === 'http:') {
        const downgradeErr = new Error('Refusing insecure redirect downgrade from HTTPS to HTTP');
        downgradeErr.code = 'ERR_HTTPS_DOWNGRADE';
        downgradeErr.isFatal = true;
        throw downgradeErr;
      }
      currentUrl = nextUrlObj.href;
      redirects++;
      continue;
    }

    return result;
  }

  throw new Error('Too many redirects');
}

/**
 * Parses and validates an HTTP Content-Range header: "bytes start-end/total"
 */
export function parseContentRange(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const match = headerValue.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  const total = match[3] === '*' ? null : parseInt(match[3], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end, total };
}

/**
 * DownloadTask implements IDM's multi-part part-file isolation architecture
 * with adaptive work-stealing segmentation, strict Range validation, and SHA-256 verification.
 */
export class DownloadTask extends EventEmitter {
  constructor(options) {
    super();
    const rawId = options.id || ('task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    this.id = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.url = options.url;
    this.finalUrl = options.finalUrl || options.url;
    this.targetDir = options.targetDir;
    let cleanName = sanitizeDownloadFilename(options.filename || '');
    if (!cleanName && options.url) {
      try {
        const u = new URL(options.url);
        const base = path.basename(u.pathname);
        if (base && base !== '/' && base !== '.') {
          cleanName = sanitizeDownloadFilename(decodeURIComponent(base));
        }
      } catch {}
    }
    this.filename = cleanName || ('download_' + Date.now());
    this.category = options.category || getCategoryByFilename(this.filename);
    this.targetPath = options.targetPath || (this.targetDir ? path.join(this.targetDir, this.filename) : '');
    this.totalBytes = options.totalBytes || 0;
    this.downloadedBytes = options.downloadedBytes || 0;
    this.status = options.status || 'pending'; // 'pending' | 'connecting' | 'downloading' | 'paused' | 'merging' | 'completed' | 'error' | 'cancelled'
    this.resumable = options.resumable !== undefined ? options.resumable : false;
    this.isDynamicConnections = (!options.maxConnections || options.maxConnections === 'auto');
    this.maxConnections = this.isDynamicConnections ? 8 : Math.min(32, Math.max(1, parseInt(options.maxConnections, 10) || 8));
    this.autoCategorize = Boolean(options.autoCategorize);
    this.segments = Array.isArray(options.segments) ? options.segments.map(s => ({ ...s, ownerWorkerId: null })) : [];
    this.speed = 0;
    this.timeLeft = null;
    this.error = options.error || null;
    this.addedAt = options.addedAt || new Date().toISOString();
    this.completedAt = options.completedAt || null;

    // Continuity validators
    this.etag = options.etag || null;
    this.lastModified = options.lastModified || null;

    // Integrity verification
    this.expectedSha256 = options.expectedSha256 ? options.expectedSha256.toLowerCase().trim() : null;
    this.sha256 = options.sha256 || null;

    // Engine tunables
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 5;
    this.baseRetryDelayMs = options.baseRetryDelayMs !== undefined ? options.baseRetryDelayMs : 400;
    this.requestTimeoutMs = options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : 15000;
    this.minSegmentSize = options.minSegmentSize !== undefined ? options.minSegmentSize : 128 * 1024; // 128 KB
    this.dynamicSegmentation = options.dynamicSegmentation !== false;
    this.mergeStrategy = options.mergeStrategy || 'stream'; // 'stream' | 'positional'
    this.conflictPolicy = options.conflictPolicy || 'rename'; // 'rename' | 'overwrite'
    this.tlsOptions = options.tlsOptions || null;

    // Rate limiting
    this.speedLimiter = options.speedLimiter || (options.speedLimitBytesPerSec ? new TokenBucketLimiter(options.speedLimitBytesPerSec) : null);

    // Dedicated temporary directory for isolated part files
    this.tempDir = path.join(this.targetDir, `.idm_temp_${this.id}`);

    this._isPaused = false;
    this._isCancelled = false;
    this._isThrottled = false;
    this._activeConcurrencyLimit = this.maxConnections;
    this._abortControllers = new Set();
    this._activeStreamPromises = new Set();
    this._activeRunPromise = null;
    this._speedInterval = null;
    this._lastDownloadedBytes = 0;
    this._lastSpeedSampleTime = Date.now();
    this.retryCount = 0;
  }

  _resolveUniqueTargetPath(desiredFilename) {
    const cleanName = sanitizeDownloadFilename(desiredFilename) || ('download_' + Date.now());
    let candidatePath = path.join(this.targetDir, cleanName);

    if (this.conflictPolicy === 'overwrite') {
      return { filename: cleanName, targetPath: candidatePath };
    }

    if (fs.existsSync(candidatePath)) {
      const ext = path.extname(cleanName);
      const nameWithoutExt = path.basename(cleanName, ext);
      let counter = 1;
      while (fs.existsSync(path.join(this.targetDir, `${nameWithoutExt}_(${counter})${ext}`))) {
        counter++;
      }
      const uniqueName = `${nameWithoutExt}_(${counter})${ext}`;
      return {
        filename: uniqueName,
        targetPath: path.join(this.targetDir, uniqueName)
      };
    }

    return { filename: cleanName, targetPath: candidatePath };
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._runInit();
    try {
      return await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _runInit() {
    this.status = 'connecting';
    this.error = null;
    this.emit('update', this.toJSON());

    const initAbortCtrl = new AbortController();
    this._abortControllers.add(initAbortCtrl);

    try {
      let probe = null;
      try {
        probe = await probeUrl(this.url, {}, {
          timeoutMs: Math.min(this.requestTimeoutMs || 12000, 6000),
          tlsOptions: this.tlsOptions,
          signal: initAbortCtrl.signal
        });
      } catch (probeErr) {
        if (probeErr.isFatal) throw probeErr;
        // Non-fatal probe failure: graceful fallback to single stream with runtime length
      } finally {
        this._abortControllers.delete(initAbortCtrl);
      }

      if (this._isPaused || this._isCancelled) return this;

      if (probe) {
        this.finalUrl = probe.finalUrl;
        this.totalBytes = probe.contentLength || 0;
        this.resumable = probe.acceptRanges;
        this.etag = probe.etag || this.etag;
        this.lastModified = probe.lastModified || this.lastModified;

        if (!this.filename) {
          this.filename = sanitizeDownloadFilename(probe.filename) || ('download_' + Date.now());
        }
      } else {
        this.totalBytes = 0;
        this.resumable = false;
        if (!this.filename) {
          try {
            const base = path.basename(new URL(this.url).pathname);
            if (base && base !== '/' && base !== '.') this.filename = sanitizeDownloadFilename(decodeURIComponent(base));
          } catch {}
          if (!this.filename) this.filename = 'download_' + Date.now();
        }
      }

      this.category = getCategoryByFilename(this.filename);

      if (this.autoCategorize && this.category) {
        const catFolder = getCategoryFolderName(this.category);
        if (!this.targetDir.endsWith(catFolder) && !this.targetDir.endsWith(catFolder.toLowerCase())) {
          this.targetDir = path.join(this.targetDir, catFolder);
        }
      }

      if (this.isDynamicConnections) {
        this.maxConnections = calculateOptimalConnections(this.totalBytes, this.resumable);
        this._activeConcurrencyLimit = this.maxConnections;
      }

      if (!fs.existsSync(this.targetDir)) {
        fs.mkdirSync(this.targetDir, { recursive: true });
      }

      if (!this.targetPath || this.downloadedBytes === 0) {
        const resolved = this._resolveUniqueTargetPath(this.filename);
        this.filename = resolved.filename;
        this.targetPath = resolved.targetPath;
      }

      this.tempDir = path.join(this.targetDir, `.idm_temp_${this.id}`);

      if (this.segments.length === 0) {
        this._planSegments();
      }

      this.emit('update', this.toJSON());
      return this;
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      this.emit('update', this.toJSON());
      throw err;
    } finally {
      this._abortControllers.delete(initAbortCtrl);
    }
  }

  _planSegments() {
    if (!this.resumable || this.totalBytes <= 0 || this.totalBytes < this.minSegmentSize * 2 || this.maxConnections <= 1) {
      this.segments = [{
        index: 0,
        start: 0,
        end: this.totalBytes > 0 ? this.totalBytes - 1 : 0,
        downloaded: 0,
        status: 'pending',
        ownerWorkerId: null
      }];
      return;
    }

    const maxSensibleSegments = Math.max(1, Math.floor(this.totalBytes / this.minSegmentSize));
    const numSegments = Math.min(this.maxConnections, maxSensibleSegments);
    const partSize = Math.floor(this.totalBytes / numSegments);
    this.segments = [];

    for (let i = 0; i < numSegments; i++) {
      const start = i * partSize;
      const end = (i === numSegments - 1) ? (this.totalBytes - 1) : ((i + 1) * partSize - 1);
      this.segments.push({
        index: i,
        start,
        end,
        downloaded: 0,
        status: 'pending',
        ownerWorkerId: null
      });
    }
  }

  /**
   * Synchronizes segment progress from actual verified part files on disk
   */
  _syncSegmentsFromDisk() {
    let existingTotal = 0;
    for (const seg of this.segments) {
      seg.ownerWorkerId = null;
      const partFile = path.join(this.tempDir, `part_${seg.index}.dat`);
      const expectedLen = (this.totalBytes > 0 && seg.end >= seg.start) ? (seg.end - seg.start + 1) : 0;

      if (fs.existsSync(partFile)) {
        let diskSize = fs.statSync(partFile).size;
        // If disk file somehow exceeded segment boundary, truncate safely to exact boundary
        if (expectedLen > 0 && diskSize > expectedLen) {
          fs.truncateSync(partFile, expectedLen);
          diskSize = expectedLen;
        }
        seg.downloaded = diskSize;
      } else {
        seg.downloaded = 0;
      }

      existingTotal += seg.downloaded;
      if (expectedLen > 0 && seg.downloaded === expectedLen) {
        seg.status = 'completed';
      } else {
        seg.status = 'pending';
      }
    }
    this.downloadedBytes = existingTotal;
    return existingTotal;
  }

  /**
   * Verifies that the remote resource has not changed before resuming partial data
   */
  async _verifyContinuityBeforeResume() {
    if (!this.resumable) {
      // Non-resumable downloads must restart from byte 0
      this._resetPartialData();
      return;
    }

    try {
      const probe = await probeUrl(this.url, {}, {
        timeoutMs: this.requestTimeoutMs,
        tlsOptions: this.tlsOptions
      });

      const sizeChanged = (this.totalBytes > 0 && probe.contentLength > 0 && probe.contentLength !== this.totalBytes);
      const etagChanged = Boolean(this.etag && probe.etag && this.etag !== probe.etag);
      const lastModChanged = Boolean(this.lastModified && probe.lastModified && this.lastModified !== probe.lastModified);
      const rangeLost = !probe.acceptRanges;

      if (sizeChanged || etagChanged || lastModChanged || rangeLost) {
        // Remote file changed! Discard stale partial files and restart cleanly
        this.finalUrl = probe.finalUrl;
        this.totalBytes = probe.contentLength;
        this.resumable = probe.acceptRanges;
        this.etag = probe.etag;
        this.lastModified = probe.lastModified;
        this._resetPartialData();
      } else {
        this.finalUrl = probe.finalUrl;
      }
    } catch (err) {
      if (err.isFatal) throw err;
    }
  }

  _resetPartialData() {
    this._safeCleanTempFilesOnly();
    this.downloadedBytes = 0;
    this._planSegments();
  }

  _safeCleanTempFilesOnly() {
    if (!this._isValidTempDir()) return;
    if (fs.existsSync(this.tempDir)) {
      for (const entry of fs.readdirSync(this.tempDir)) {
        if (entry.startsWith('part_') || entry.endsWith('.tmp')) {
          try {
            fs.unlinkSync(path.join(this.tempDir, entry));
          } catch {}
        }
      }
    }
  }

  _isValidTempDir() {
    if (!this.tempDir || !this.targetDir || !this.id) return false;
    const base = path.basename(this.tempDir);
    if (base !== `.idm_temp_${this.id}`) return false;
    const resolvedParent = path.resolve(this.targetDir);
    const resolvedTemp = path.resolve(this.tempDir);
    return path.dirname(resolvedTemp) === resolvedParent;
  }

  async cleanupTempDir() {
    if (!this._isValidTempDir()) return;
    if (this._activeStreamPromises.size > 0) {
      await Promise.allSettled(Array.from(this._activeStreamPromises));
    }
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch {}
  }

  async start() {
    if (this.status === 'downloading' || this.status === 'merging') {
      return this._activeRunPromise;
    }

    this._isPaused = false;
    this._isCancelled = false;
    this._activeRunPromise = this._executeDownload();
    return this._activeRunPromise;
  }

  async _executeDownload() {
    try {
      if (!this.targetPath || this.segments.length === 0) {
        await this.init();
      }

      if (this._isPaused || this._isCancelled) return;

      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      const existingBytes = this._syncSegmentsFromDisk();
      if (existingBytes > 0) {
        await this._verifyContinuityBeforeResume();
        if (!fs.existsSync(this.tempDir)) {
          fs.mkdirSync(this.tempDir, { recursive: true });
        }
        this._syncSegmentsFromDisk();
      }

      this.status = 'downloading';
      this._isPaused = false;
      this._isCancelled = false;
      this._isThrottled = false;
      this.error = null;
      this._activeConcurrencyLimit = this.resumable ? this.maxConnections : 1;

      this._startSpeedMonitor();
      this.emit('update', this.toJSON());

      const initialWorkerCount = this.resumable
        ? Math.min(this._activeConcurrencyLimit, Math.max(1, this.segments.length))
        : 1;

      const workerPromises = [];
      for (let w = 0; w < initialWorkerCount; w++) {
        workerPromises.push((async () => {
          if (w > 0) await sleep(Math.min(80, w * 4));
          await this._workerLoop(w + 1);
        })());
      }

      await Promise.all(workerPromises);

      if (this._isPaused || this._isCancelled) {
        return;
      }

      // Check if fallback to single connection occurred during segment 0
      const allFinished = this.segments.length > 0 && this.segments.every(s => s.status === 'completed');
      if (allFinished && this.status === 'downloading') {
        await this._mergeParts();
      } else if (!this._isPaused && !this._isCancelled) {
        throw new Error('Download incomplete: one or more segments failed to finish');
      }
    } catch (err) {
      this._stopSpeedMonitor();
      if (this._isPaused || this._isCancelled) {
        return;
      }
      this.status = 'error';
      this.error = err.message;
      this.speed = 0;
      this.timeLeft = null;
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      this.emit('update', this.toJSON());
    } finally {
      this._activeRunPromise = null;
    }
  }

  /**
   * Central Range Scheduler: Assigns unclaimed ranges or safely splits the largest slow active range
   */
  _acquireNextSegment(workerId) {
    if (this._isPaused || this._isCancelled) return null;

    // Respect throttled concurrency cap
    const activeOwnedCount = this.segments.filter(s => s.status === 'downloading' && s.ownerWorkerId !== null && s.ownerWorkerId !== workerId).length;
    if (activeOwnedCount >= this._activeConcurrencyLimit) {
      return null;
    }

    // 1. Find any unclaimed pending segment
    const pendingSeg = this.segments.find(s => s.status === 'pending' && s.ownerWorkerId === null);
    if (pendingSeg) {
      pendingSeg.status = 'downloading';
      pendingSeg.ownerWorkerId = workerId;
      return pendingSeg;
    }

    // 2. Dynamic Work-Stealing: Split the largest in-flight segment if justified
    if (!this.dynamicSegmentation || !this.resumable || this._isThrottled || this.totalBytes <= 0) {
      return null;
    }

    let largestSeg = null;
    let maxRemaining = 0;

    for (const seg of this.segments) {
      if (seg.status === 'downloading' && seg.end > seg.start) {
        const remaining = (seg.end - seg.start + 1) - seg.downloaded;
        if (remaining > maxRemaining) {
          maxRemaining = remaining;
          largestSeg = seg;
        }
      }
    }

    // Only split if remaining work is at least 2x minSegmentSize so neither half is tiny
    if (!largestSeg || maxRemaining < this.minSegmentSize * 2) {
      return null;
    }

    const halfRemaining = Math.floor(maxRemaining / 2);
    const splitByte = largestSeg.start + largestSeg.downloaded + halfRemaining;
    const oldEnd = largestSeg.end;

    if (splitByte <= largestSeg.start + largestSeg.downloaded || splitByte > oldEnd) {
      return null;
    }

    // Narrow the original segment's upper bound; its active stream checks seg.end on every chunk
    largestSeg.end = splitByte - 1;

    const newIndex = this.segments.reduce((maxIdx, s) => Math.max(maxIdx, s.index), -1) + 1;
    const newSeg = {
      index: newIndex,
      start: splitByte,
      end: oldEnd,
      downloaded: 0,
      status: 'downloading',
      ownerWorkerId: workerId
    };

    this.segments.push(newSeg);
    this.emit('update', this.toJSON());
    return newSeg;
  }

  async _workerLoop(workerId) {
    while (!this._isPaused && !this._isCancelled) {
      const seg = this._acquireNextSegment(workerId);
      if (!seg) break;

      try {
        await this._runSegmentWithRetries(seg, workerId);
      } catch (err) {
        seg.ownerWorkerId = null;
        if (this._isPaused || this._isCancelled) return;
        throw err;
      }
    }
  }

  async _runSegmentWithRetries(seg, workerId) {
    let retries = 0;

    while (!this._isPaused && !this._isCancelled) {
      const expectedTotal = (this.totalBytes > 0 && seg.end >= seg.start) ? (seg.end - seg.start + 1) : 0;
      if (expectedTotal > 0 && seg.downloaded >= expectedTotal) {
        seg.status = 'completed';
        seg.ownerWorkerId = null;
        return;
      }

      const bytesBeforeAttempt = seg.downloaded;

      try {
        await this._downloadSlice(seg, workerId);

        if (this._isPaused || this._isCancelled) {
          seg.ownerWorkerId = null;
          if (seg.status !== 'completed') seg.status = 'pending';
          return;
        }

        const currentExpected = (this.totalBytes > 0 && seg.end >= seg.start) ? (seg.end - seg.start + 1) : 0;
        if ((currentExpected > 0 && seg.downloaded >= currentExpected) || (!this.resumable && seg.status === 'completed')) {
          seg.status = 'completed';
          seg.ownerWorkerId = null;
          return;
        }

        // If stream ended prematurely without throwing
        throw new Error(`Premature EOF on segment ${seg.index}: received ${seg.downloaded}/${currentExpected} bytes`);
      } catch (err) {
        if (this._isPaused || this._isCancelled || seg._abortedByFallback) {
          seg.ownerWorkerId = null;
          return;
        }

        // Check if segment was completed due to a dynamic range split narrowing seg.end
        const updatedExpected = (this.totalBytes > 0 && seg.end >= seg.start) ? (seg.end - seg.start + 1) : 0;
        if (updatedExpected > 0 && seg.downloaded >= updatedExpected) {
          seg.status = 'completed';
          seg.ownerWorkerId = null;
          return;
        }

        if (err.isFatal) {
          seg.status = 'error';
          seg.ownerWorkerId = null;
          throw err;
        }

        // Reset consecutive retry count if substantial progress was made during this attempt
        if (seg.downloaded > bytesBeforeAttempt + 65536) {
          retries = 0;
        }

        retries++;
        this.retryCount++;

        if (retries > this.maxRetries) {
          seg.status = 'error';
          seg.ownerWorkerId = null;
          throw new Error(`Segment ${seg.index + 1} failed after ${this.maxRetries} retries: ${err.message}`);
        }

        // Handle throttling / Retry-After
        let delayMs = this.baseRetryDelayMs * Math.pow(2, retries - 1);
        if (err.retryAfterMs && err.retryAfterMs > delayMs) {
          delayMs = err.retryAfterMs;
        }

        if (err.isThrottle) {
          this._isThrottled = true;
          this._activeConcurrencyLimit = Math.max(1, Math.floor(this._activeConcurrencyLimit / 2));
          // If too many workers are active, yield this segment back to pending pool
          const activeCount = this.segments.filter(s => s.status === 'downloading').length;
          if (activeCount > this._activeConcurrencyLimit) {
            seg.status = 'pending';
            seg.ownerWorkerId = null;
            return;
          }
        }

        this.emit('update', this.toJSON());
        await sleep(delayMs);
      }
    }
  }

  /**
   * Downloads a byte range into its isolated part file with strict HTTP Range / Content-Range validation
   */
  async _downloadSlice(seg, workerId) {
    const partFile = path.join(this.tempDir, `part_${seg.index}.dat`);

    // Always verify actual disk offset before sending HTTP Range request
    if (fs.existsSync(partFile)) {
      const diskBytes = fs.statSync(partFile).size;
      const expectedMax = (this.totalBytes > 0 && seg.end >= seg.start) ? (seg.end - seg.start + 1) : Infinity;
      if (diskBytes > expectedMax) {
        fs.truncateSync(partFile, expectedMax);
        const diff = seg.downloaded - expectedMax;
        seg.downloaded = expectedMax;
        this.downloadedBytes = Math.max(0, this.downloadedBytes - diff);
      } else if (diskBytes !== seg.downloaded) {
        const diff = diskBytes - seg.downloaded;
        seg.downloaded = diskBytes;
        this.downloadedBytes = Math.max(0, this.downloadedBytes + diff);
      }
    } else if (seg.downloaded > 0) {
      this.downloadedBytes = Math.max(0, this.downloadedBytes - seg.downloaded);
      seg.downloaded = 0;
    }

    const initialExpected = (this.totalBytes > 0 && seg.end >= seg.start) ? (seg.end - seg.start + 1) : 0;
    if (initialExpected > 0 && seg.downloaded >= initialExpected) {
      seg.status = 'completed';
      return;
    }

    const abortCtrl = new AbortController();
    seg.abortController = abortCtrl;
    this._abortControllers.add(abortCtrl);

    const currentByte = seg.start + seg.downloaded;
    const requestedEndByte = seg.end;
    const isRangeRequest = Boolean(this.resumable && (requestedEndByte > 0 || currentByte > 0));

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive'
    };

    if (isRangeRequest) {
      headers['Range'] = `bytes=${currentByte}-${requestedEndByte}`;
    }

    const urlObj = new URL(this.finalUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const agent = getAgentForUrl(urlObj, this.tlsOptions);

    let streamPromiseResolve;
    const streamBarrier = new Promise(r => { streamPromiseResolve = r; });
    this._activeStreamPromises.add(streamBarrier);

    try {
      await new Promise((resolve, reject) => {
        let writeStream = null;
        let settled = false;

        const finishWith = (err = null) => {
          if (settled) return;
          settled = true;
          this._abortControllers.delete(abortCtrl);
          seg.abortController = null;

          if (writeStream) {
            writeStream.end(() => {
              streamPromiseResolve();
              if (err) reject(err);
              else resolve();
            });
          } else {
            streamPromiseResolve();
            if (err) reject(err);
            else resolve();
          }
        };

        const req = client.request(this.finalUrl, {
          method: 'GET',
          agent,
          ...(this.tlsOptions?.ca ? { ca: this.tlsOptions.ca } : {}),
          headers,
          signal: abortCtrl.signal
        }, (res) => {
          // Handle Redirects during slice download
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.destroy();
            try {
              const nextUrlObj = new URL(res.headers.location, this.finalUrl);
              if (urlObj.protocol === 'https:' && nextUrlObj.protocol === 'http:') {
                const downgradeErr = new Error('Refusing insecure redirect downgrade from HTTPS to HTTP');
                downgradeErr.isFatal = true;
                return finishWith(downgradeErr);
              }
              this.finalUrl = nextUrlObj.href;
              return finishWith(new Error('Redirected to new URL'));
            } catch (e) {
              e.isFatal = true;
              return finishWith(e);
            }
          }

          // Check HTTP status codes
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.destroy();
            const statusErr = new Error(`Server returned HTTP ${res.statusCode}`);
            statusErr.statusCode = res.statusCode;

            if (NON_RETRYABLE_STATUS_CODES.has(res.statusCode)) {
              statusErr.isFatal = true;
            } else if (THROTTLE_STATUS_CODES.has(res.statusCode)) {
              statusErr.isThrottle = true;
              const retryAfter = res.headers['retry-after'];
              if (retryAfter) {
                const secs = parseInt(retryAfter, 10);
                if (Number.isFinite(secs) && secs > 0) {
                  statusErr.retryAfterMs = Math.min(30000, secs * 1000);
                }
              }
            }
            return finishWith(statusErr);
          }

          // Validate Range semantics
          if (isRangeRequest) {
            if (res.statusCode === 200) {
              // Server ignored Range header and sent HTTP 200 OK (full file from byte 0)
              if (seg.index === 0 && currentByte === 0) {
                // Safe fallback to single connection if no other segment has committed data
                this.resumable = false;
                this._activeConcurrencyLimit = 1;
                const reportedLen = parseInt(res.headers['content-length'] || '0', 10);
                if (reportedLen > 0) this.totalBytes = reportedLen;
                seg.start = 0;
                seg.end = this.totalBytes > 0 ? this.totalBytes - 1 : 0;

                // Cancel and remove all other segments
                for (const other of this.segments) {
                  if (other.index !== 0) {
                    other._abortedByFallback = true;
                    other.status = 'completed';
                    if (other.abortController) {
                      try { other.abortController.abort(); } catch {}
                    }
                  }
                }
                this.segments = [seg];
              } else {
                // NEVER append a 200 full-file response to a non-zero partial offset or secondary segment!
                res.destroy();
                const rangeIgnoredErr = new Error(`Server ignored Range request (bytes=${currentByte}-${requestedEndByte}) and returned HTTP 200`);
                rangeIgnoredErr.isFatal = true;
                return finishWith(rangeIgnoredErr);
              }
            } else if (res.statusCode === 206) {
              // Strictly validate Content-Range header on 206 Partial Content
              const cr = parseContentRange(res.headers['content-range']);
              if (!cr || cr.start !== currentByte || cr.end < currentByte || (requestedEndByte > 0 && cr.end > requestedEndByte)) {
                res.destroy();
                const badRangeErr = new Error(
                  `Invalid Content-Range header "${res.headers['content-range'] || 'missing'}" for requested range bytes=${currentByte}-${requestedEndByte}`
                );
                badRangeErr.isFatal = true;
                return finishWith(badRangeErr);
              }

              // Validate Content-Length if present on 206 response
              if (res.headers['content-length']) {
                const cl = parseInt(res.headers['content-length'], 10);
                const expectedSliceLen = cr.end - cr.start + 1;
                if (Number.isFinite(cl) && cl !== expectedSliceLen) {
                  res.destroy();
                  const lenMismatchErr = new Error(`Inconsistent Content-Length (${cl}) vs Content-Range length (${expectedSliceLen})`);
                  lenMismatchErr.isFatal = true;
                  return finishWith(lenMismatchErr);
                }
              }
            }
          } else if (res.statusCode === 200 && currentByte > 0) {
            // Non-range request when partial bytes existed: truncate part_0.dat to restart cleanly from 0
            this.downloadedBytes = Math.max(0, this.downloadedBytes - seg.downloaded);
            seg.downloaded = 0;
          }

          const writeFlags = (seg.downloaded === 0) ? 'w' : 'a';
          writeStream = fs.createWriteStream(partFile, { flags: writeFlags });

          writeStream.on('error', (diskErr) => {
            diskErr.isFatal = true;
            res.destroy();
            finishWith(new Error(`Disk write error: ${diskErr.message}`));
          });

          const initialExpectedSlice = (this.totalBytes > 0 && requestedEndByte >= currentByte)
            ? (requestedEndByte - currentByte + 1)
            : Infinity;
          let rawWireBytes = 0;

          res.on('data', async (chunk) => {
            if (this._isPaused || this._isCancelled || settled) {
              res.destroy();
              return;
            }

            rawWireBytes += chunk.length;

            // Detect server overflowing requested range when no dynamic split occurred
            if (seg.end === requestedEndByte && rawWireBytes > initialExpectedSlice) {
              res.destroy();
              const overflowErr = new Error(`Server sent more bytes (${rawWireBytes}) than requested range (${initialExpectedSlice})`);
              overflowErr.isFatal = true;
              finishWith(overflowErr);
              return;
            }

            // Dynamically compute remaining needed bytes (supports safe cooperative range splitting)
            const hasKnownBounds = (this.totalBytes > 0 && seg.end >= seg.start);
            const maxRemaining = hasKnownBounds
              ? ((seg.end - seg.start + 1) - seg.downloaded)
              : Infinity;

            if (maxRemaining <= 0) {
              seg.status = 'completed';
              res.destroy();
              finishWith(null);
              return;
            }

            const sliceToWrite = (chunk.length > maxRemaining)
              ? chunk.subarray(0, maxRemaining)
              : chunk;

            // Apply speed limiter if active
            if (this.speedLimiter && this.speedLimiter.rate > 0) {
              res.pause();
              await this.speedLimiter.throttle(sliceToWrite.length, abortCtrl.signal);
              if (this._isPaused || this._isCancelled || settled) {
                res.destroy();
                return;
              }
              res.resume();
            }

            const canContinue = writeStream.write(sliceToWrite);
            seg.downloaded += sliceToWrite.length;
            this.downloadedBytes += sliceToWrite.length;

            if (!canContinue) {
              res.pause();
              writeStream.once('drain', () => {
                if (!this._isPaused && !this._isCancelled && !settled) {
                  res.resume();
                }
              });
            }

            if (hasKnownBounds && seg.downloaded >= (seg.end - seg.start + 1)) {
              seg.status = 'completed';
              res.destroy();
              finishWith(null);
            }
          });

          res.on('end', () => {
            if (settled) return;
            const hasKnownBounds = (this.totalBytes > 0 && seg.end >= seg.start);
            if (!hasKnownBounds) {
              this.totalBytes = seg.downloaded;
              seg.end = seg.downloaded > 0 ? seg.downloaded - 1 : 0;
              seg.status = 'completed';
            } else if (seg.downloaded >= (seg.end - seg.start + 1)) {
              seg.status = 'completed';
            }
            finishWith(null);
          });

          res.on('error', (err) => {
            if (settled) return;
            if (abortCtrl.signal.aborted || this._isPaused || this._isCancelled || seg.status === 'completed') {
              finishWith(null);
            } else {
              finishWith(formatNetworkError(err));
            }
          });
        });

        req.setTimeout(this.requestTimeoutMs, () => {
          req.destroy(new Error('Connection timed out'));
        });

        req.on('error', (err) => {
          if (settled) return;
          if (abortCtrl.signal.aborted || this._isPaused || this._isCancelled || seg.status === 'completed') {
            finishWith(null);
          } else {
            finishWith(formatNetworkError(err));
          }
        });

        req.end();
      });
    } finally {
      this._activeStreamPromises.delete(streamBarrier);
    }
  }

  /**
   * Validates all segment part files, merges into a temporary staging file while computing SHA-256,
   * verifies checksum and final size, and atomically moves into destination.
   */
  async _mergeParts() {
    if (this._isPaused || this._isCancelled) return;

    this.status = 'merging';
    this.speed = 0;
    this.timeLeft = 0;
    this._stopSpeedMonitor();
    this.emit('update', this.toJSON());

    // 1. Sort segments by start byte offset and validate contiguity
    const orderedSegments = [...this.segments].sort((a, b) => a.start - b.start);
    let expectedStart = 0;

    for (const seg of orderedSegments) {
      const partFile = path.join(this.tempDir, `part_${seg.index}.dat`);
      if (!fs.existsSync(partFile)) {
        throw new Error(`Missing temporary part file for segment ${seg.index}`);
      }

      const stat = fs.statSync(partFile);
      if (this.totalBytes > 0) {
        if (seg.start !== expectedStart) {
          throw new Error(`Segment contiguity error: expected start ${expectedStart}, found ${seg.start}`);
        }
        const expectedPartSize = seg.end - seg.start + 1;
        if (stat.size !== expectedPartSize) {
          throw new Error(`Corrupt segment ${seg.index}: expected ${expectedPartSize} bytes on disk, found ${stat.size}`);
        }
        expectedStart = seg.end + 1;
      }
    }

    if (this.totalBytes > 0 && expectedStart !== this.totalBytes) {
      throw new Error(`Incomplete byte coverage: assembled ranges cover ${expectedStart} of ${this.totalBytes} bytes`);
    }

    // 2. Assemble into an isolated staging file before exposing at final targetPath
    const stagingPath = path.join(this.targetDir, `.idm_assembling_${this.id}.tmp`);
    const hash = crypto.createHash('sha256');

    try {
      if (this.mergeStrategy === 'positional' && this.totalBytes > 0) {
        await this._mergePositional(orderedSegments, stagingPath, hash);
      } else {
        await this._mergeSequentialStream(orderedSegments, stagingPath, hash);
      }

      if (this._isPaused || this._isCancelled) {
        try { fs.unlinkSync(stagingPath); } catch {}
        return;
      }

      // 3. Verify final file size
      const finalStat = fs.statSync(stagingPath);
      if (this.totalBytes > 0 && finalStat.size !== this.totalBytes) {
        throw new Error(`Finalized file size mismatch: expected ${this.totalBytes}, got ${finalStat.size}`);
      }

      // 4. Finalize SHA-256 and verify against expected hash if provided
      this.sha256 = hash.digest('hex');
      if (this.expectedSha256 && this.sha256 !== this.expectedSha256.toLowerCase()) {
        throw new Error(`SHA-256 checksum mismatch: expected ${this.expectedSha256}, computed ${this.sha256}`);
      }

      // 5. Re-check targetPath conflict policy right before atomic rename
      const resolved = this._resolveUniqueTargetPath(this.filename);
      this.filename = resolved.filename;
      this.targetPath = resolved.targetPath;

      fs.renameSync(stagingPath, this.targetPath);
    } catch (err) {
      try {
        if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
      } catch {}
      throw err;
    }

    // 6. Clean up temporary directory after successful finalization
    await this.cleanupTempDir();

    this.status = 'completed';
    this.speed = 0;
    this.timeLeft = 0;
    this.completedAt = new Date().toISOString();
    this.emit('complete', this.toJSON());
    this.emit('update', this.toJSON());
  }

  async _mergeSequentialStream(orderedSegments, stagingPath, hash) {
    const destStream = fs.createWriteStream(stagingPath, { flags: 'w' });
    let streamErr = null;
    destStream.on('error', (err) => { streamErr = err; });

    for (const seg of orderedSegments) {
      if (streamErr) throw streamErr;
      const partFile = path.join(this.tempDir, `part_${seg.index}.dat`);
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(partFile);
        readStream.on('data', (chunk) => {
          hash.update(chunk);
        });
        readStream.on('error', reject);
        destStream.once('error', reject);
        readStream.pipe(destStream, { end: false });
        readStream.on('end', () => {
          destStream.removeListener('error', reject);
          resolve();
        });
      });
    }

    await new Promise((resolve, reject) => {
      destStream.once('error', reject);
      destStream.end(() => resolve());
    });
  }

  async _mergePositional(orderedSegments, stagingPath, hash) {
    const fileHandle = await fs.promises.open(stagingPath, 'w');
    try {
      await fileHandle.truncate(this.totalBytes);
      const buf = Buffer.allocUnsafe(256 * 1024);

      for (const seg of orderedSegments) {
        const partFile = path.join(this.tempDir, `part_${seg.index}.dat`);
        const partHandle = await fs.promises.open(partFile, 'r');
        try {
          let readPos = 0;
          let writePos = seg.start;
          while (true) {
            const { bytesRead } = await partHandle.read(buf, 0, buf.length, readPos);
            if (bytesRead === 0) break;
            const slice = buf.subarray(0, bytesRead);
            hash.update(slice);
            await fileHandle.write(slice, 0, bytesRead, writePos);
            readPos += bytesRead;
            writePos += bytesRead;
          }
        } finally {
          await partHandle.close();
        }
      }
    } finally {
      await fileHandle.close();
    }
  }

  async pause() {
    if (this.status !== 'downloading' && this.status !== 'connecting') return;
    this._isPaused = true;
    this.status = 'paused';
    this.speed = 0;
    this.timeLeft = null;

    for (const ctrl of this._abortControllers) {
      try { ctrl.abort(); } catch {}
    }
    this._abortControllers.clear();
    this._stopSpeedMonitor();

    if (this._activeStreamPromises.size > 0) {
      await Promise.allSettled(Array.from(this._activeStreamPromises));
    }

    for (const seg of this.segments) {
      seg.ownerWorkerId = null;
      if (seg.status === 'downloading') seg.status = 'pending';
    }

    this.emit('pause', this.toJSON());
    this.emit('update', this.toJSON());
  }

  async cancel(deleteTemp = true) {
    this._isCancelled = true;
    this._isPaused = true;
    this.status = 'cancelled';
    this.speed = 0;
    this.timeLeft = null;

    for (const ctrl of this._abortControllers) {
      try { ctrl.abort(); } catch {}
    }
    this._abortControllers.clear();
    this._stopSpeedMonitor();

    if (this._activeStreamPromises.size > 0) {
      try {
        await Promise.race([
          Promise.allSettled(Array.from(this._activeStreamPromises)),
          sleep(600)
        ]);
      } catch {}
    }
    if (this._activeRunPromise) {
      try {
        await Promise.race([
          this._activeRunPromise,
          sleep(600)
        ]);
      } catch {}
    }

    if (deleteTemp) {
      await this.cleanupTempDir();
    }

    this.emit('cancelled', this.toJSON());
    this.emit('update', this.toJSON());
  }

  _startSpeedMonitor() {
    this._stopSpeedMonitor();
    this._lastDownloadedBytes = this.downloadedBytes;
    this._lastSpeedSampleTime = Date.now();

    this._speedInterval = setInterval(() => {
      if (this.status !== 'downloading') {
        this._stopSpeedMonitor();
        return;
      }

      const now = Date.now();
      const timeDelta = (now - this._lastSpeedSampleTime) / 1000;
      if (timeDelta > 0.25) {
        const bytesDelta = Math.max(0, this.downloadedBytes - this._lastDownloadedBytes);
        const currentSpeed = bytesDelta / timeDelta;

        this.speed = Math.round(this.speed === 0 ? currentSpeed : (0.65 * currentSpeed + 0.35 * this.speed));

        if (this.speed > 0 && this.totalBytes > this.downloadedBytes) {
          this.timeLeft = Math.ceil((this.totalBytes - this.downloadedBytes) / this.speed);
        } else {
          this.timeLeft = null;
        }

        this._lastDownloadedBytes = this.downloadedBytes;
        this._lastSpeedSampleTime = now;
        this.emit('update', this.toJSON());
      }
    }, 400);
  }

  _stopSpeedMonitor() {
    if (this._speedInterval) {
      clearInterval(this._speedInterval);
      this._speedInterval = null;
    }
  }

  toJSON() {
    const ordered = [...this.segments].sort((a, b) => a.start - b.start);
    return {
      id: this.id,
      url: this.url,
      finalUrl: this.finalUrl,
      targetDir: this.targetDir,
      filename: this.filename,
      targetPath: this.targetPath,
      totalBytes: this.totalBytes,
      downloadedBytes: this.downloadedBytes,
      status: this.status,
      resumable: this.resumable,
      maxConnections: this.maxConnections,
      speed: this.speed,
      timeLeft: this.timeLeft,
      category: this.category,
      error: this.error,
      etag: this.etag,
      lastModified: this.lastModified,
      expectedSha256: this.expectedSha256,
      sha256: this.sha256,
      retryCount: this.retryCount,
      addedAt: this.addedAt,
      completedAt: this.completedAt,
      segments: ordered.map(s => {
        const segTotal = (this.totalBytes > 0 && s.end >= s.start) ? (s.end - s.start + 1) : 1;
        return {
          index: s.index,
          start: s.start,
          end: s.end,
          downloaded: s.downloaded,
          status: s.status,
          percentage: Math.min(100, Math.round((s.downloaded / segTotal) * 100))
        };
      }),
      percentage: this.totalBytes > 0 ? Math.min(100, Math.round((this.downloadedBytes / this.totalBytes) * 100)) : 0
    };
  }
}
