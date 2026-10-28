import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const API_VERSION = '1.0';
const MAX_BODY_BYTES = 16 * 1024; // 16 KB strict request body limit
const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const CANDIDATE_PORTS = [1001, 10010, 10011, 10012, 10013, 10014];

/**
 * Validates whether an HTTP Origin header belongs to a permitted browser extension.
 * Regular web origins (http://, https://) are strictly rejected.
 */
export function isAllowedExtensionOrigin(origin, allowedOrigins = []) {
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  if (/^chrome-extension:\/\/[a-z]{32}$/i.test(origin)) return true;
  if (/^moz-extension:\/\/[0-9a-f-]{36}$/i.test(origin)) return true;
  return false;
}

/**
 * Validates whether a download URL uses an explicitly safe HTTP/HTTPS scheme
 */
export function validateDownloadUrl(urlStr) {
  if (typeof urlStr !== 'string' || urlStr.trim().length === 0 || urlStr.length > 4096) {
    return { valid: false, reason: 'URL must be a non-empty string up to 4096 characters' };
  }
  try {
    const parsed = new URL(urlStr.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: `Unsupported URL scheme "${parsed.protocol}". Only http: and https: are allowed.` };
    }
    if (!parsed.hostname) {
      return { valid: false, reason: 'URL is missing a valid hostname' };
    }
    return { valid: true, url: parsed.href };
  } catch {
    return { valid: false, reason: 'Malformed URL format' };
  }
}

/**
 * Sanitizes a user-supplied filename to prevent path traversal or illegal characters
 */
export function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return '';
  // Strip any directory components
  let base = path.basename(filename.trim().replace(/\\/g, '/'));
  // Remove control characters and Windows reserved characters
  base = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  // Prevent hidden dot-only names or traversal
  if (base === '.' || base === '..' || base.startsWith('.idm_temp_')) {
    return '';
  }
  return base.slice(0, 240);
}

/**
 * Validates that a requested targetDir is safe and within the allowed base directory
 */
export function validateTargetDir(requestedDir, allowedBaseDir) {
  if (!requestedDir) return { valid: true, dir: allowedBaseDir };
  if (typeof requestedDir !== 'string' || requestedDir.includes('\0')) {
    return { valid: false, reason: 'Invalid target directory path' };
  }
  const resolvedBase = path.resolve(allowedBaseDir);
  const resolvedTarget = path.resolve(requestedDir);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { valid: false, reason: 'Target directory must be within the configured default download directory' };
  }
  return { valid: true, dir: resolvedTarget };
}

/**
 * Reads JSON body safely with a hard byte limit
 */
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        req.resume(); // Drain remaining bytes so client receives HTTP 413 response cleanly
        const err = new Error('Request body exceeds maximum allowed size');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) {
          const err = new Error('Empty request body');
          err.statusCode = 400;
          return reject(err);
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('Request body must be a JSON object');
          err.statusCode = 400;
          return reject(err);
        }
        resolve(parsed);
      } catch {
        const err = new Error('Malformed JSON in request body');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

/**
 * Starts the local integration HTTP server bound strictly to loopback (127.0.0.1).
 */
export function startLocalServer(queueManager, port = 1001, options = {}) {
  const host = options.host || '127.0.0.1';
  if (!ALLOWED_LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Security Violation: Local integration server must bind to loopback (127.0.0.1), refused "${host}"`);
  }

  const storageDir = options.storageDir || queueManager?.storageDir || path.join(os.homedir(), '.personal-idm');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const tokenFile = path.join(storageDir, 'bridge-secret.token');
  const discoveryFile = path.join(storageDir, 'bridge-info.json');

  // Generate or load persistent cryptographic authentication token
  let authToken = options.authToken;
  if (!authToken) {
    if (fs.existsSync(tokenFile)) {
      try {
        const existing = fs.readFileSync(tokenFile, 'utf8').trim();
        if (existing.length >= 32) authToken = existing;
      } catch {}
    }
    if (!authToken) {
      authToken = crypto.randomBytes(32).toString('hex');
      try {
        fs.writeFileSync(tokenFile, authToken, { encoding: 'utf8', mode: 0o600 });
      } catch {}
    }
  }

  const allowedOrigins = options.allowedOrigins || [];
  let activePort = port;

  function writeDiscoveryFile(boundPort) {
    const info = {
      service: 'personal-idm',
      apiVersion: API_VERSION,
      host: '127.0.0.1',
      port: boundPort,
      pid: process.pid,
      updatedAt: new Date().toISOString()
    };
    try {
      fs.writeFileSync(discoveryFile, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {}
  }

  function verifyAuth(req) {
    const authHeader = req.headers['authorization'] || '';
    const customTokenHeader = req.headers['x-personal-idm-token'] || '';
    let providedToken = '';

    if (authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    } else if (typeof customTokenHeader === 'string' && customTokenHeader.trim()) {
      providedToken = customTokenHeader.trim();
    }

    if (!providedToken || providedToken.length !== authToken.length) {
      return false;
    }
    try {
      return crypto.timingSafeEqual(Buffer.from(providedToken, 'utf8'), Buffer.from(authToken, 'utf8'));
    } catch {
      return false;
    }
  }

  const server = http.createServer(async (req, res) => {
    // Verify socket comes from loopback interface
    const remoteAddr = req.socket?.remoteAddress || '';
    if (remoteAddr && remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: non-loopback connection rejected' }));
      return;
    }

    const origin = req.headers['origin'];

    // Strictly reject any web origin (http:// or https://) or unrecognized origin
    if (origin !== undefined) {
      if (!isAllowedExtensionOrigin(origin, allowedOrigins)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: origin is not permitted' }));
        return;
      }
      // Set explicit origin (NEVER wildcard *)
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Personal-IDM-Token');
    }

    // Restrict HTTP methods
    if (!['GET', 'POST', 'OPTIONS'].includes(req.method)) {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${activePort}`);

    // Public loopback discovery endpoint (does NOT leak authToken)
    if (req.method === 'GET' && (url.pathname === '/api/v1/discovery' || url.pathname === '/api/discovery')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'personal-idm',
        apiVersion: API_VERSION,
        port: activePort,
        authRequired: true
      }));
      return;
    }

    // Extension Handshake Endpoint: Only accessible from verified browser extension Origin
    if (req.method === 'POST' && url.pathname === '/api/v1/handshake') {
      if (!origin || !isAllowedExtensionOrigin(origin, allowedOrigins)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Handshake requires a valid browser extension origin' }));
        return;
      }
      try {
        const payload = await readJsonBody(req);
        if (payload.apiVersion && payload.apiVersion !== API_VERSION) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unsupported API version "${payload.apiVersion}". Expected "${API_VERSION}".` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'personal-idm',
          apiVersion: API_VERSION,
          port: activePort,
          token: authToken
        }));
      } catch (err) {
        res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // All remaining endpoints require valid Bearer token authentication
    if (!verifyAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: valid authentication token required' }));
      return;
    }

    // GET /api/tasks
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(queueManager.getAllTasks()));
      return;
    }

    // POST /api/download - Add a new download
    if (req.method === 'POST' && url.pathname === '/api/download') {
      try {
        const payload = await readJsonBody(req);
        const urlCheck = validateDownloadUrl(payload.url);
        if (!urlCheck.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: urlCheck.reason }));
          return;
        }

        const safeFilename = sanitizeFilename(payload.filename);
        const dirCheck = validateTargetDir(payload.targetDir, queueManager.defaultDownloadDir);
        if (!dirCheck.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: dirCheck.reason }));
          return;
        }

        let maxConn = queueManager.defaultConnections || 8;
        if (payload.maxConnections !== undefined) {
          const parsedConn = Number(payload.maxConnections);
          if (!Number.isInteger(parsedConn) || parsedConn < 1 || parsedConn > 32) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'maxConnections must be an integer between 1 and 32' }));
            return;
          }
          maxConn = parsedConn;
        }

        const task = await queueManager.addTask({
          url: urlCheck.url,
          filename: safeFilename || undefined,
          targetDir: dirCheck.dir,
          maxConnections: maxConn,
          autoStart: payload.autoStart !== false,
          expectedSha256: typeof payload.expectedSha256 === 'string' ? payload.expectedSha256.trim() : undefined
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, task }));
      } catch (err) {
        const code = err.statusCode || 500;
        const headers = { 'Content-Type': 'application/json' };
        if (code === 413) headers['Connection'] = 'close';
        res.writeHead(code, headers);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/tasks/:id/pause
    const pauseMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/pause$/);
    if (req.method === 'POST' && pauseMatch) {
      const task = queueManager.getTask(pauseMatch[1]);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      await queueManager.pauseTask(pauseMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // POST /api/tasks/:id/resume
    const resumeMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/resume$/);
    if (req.method === 'POST' && resumeMatch) {
      const task = queueManager.getTask(resumeMatch[1]);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      queueManager.resumeTask(resumeMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });

  // Candidate port fallback sequence
  const candidateSequence = Array.isArray(options.candidatePorts) && options.candidatePorts.length > 0
    ? [...options.candidatePorts]
    : (port === 0
      ? [0]
      : [port, ...CANDIDATE_PORTS.filter(p => p !== port), 0]);
  let attemptIndex = 0;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptIndex + 1 < candidateSequence.length) {
      attemptIndex++;
      const nextPort = candidateSequence[attemptIndex];
      activePort = nextPort;
      server.listen(nextPort, '127.0.0.1');
    } else {
      console.error('[Bridge] Server error:', err.message);
    }
  });

  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      activePort = addr.port;
      writeDiscoveryFile(activePort);
    }
  });

  // Attach helper methods for internal IPC / testing
  server.getAuthToken = () => authToken;
  server.getActivePort = () => activePort;
  server.getDiscoveryFilePath = () => discoveryFile;

  server.listen(candidateSequence[0], '127.0.0.1');

  return server;
}
