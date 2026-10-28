# Personal IDM (Custom-IDM)

An Internet Download Manager (IDM 6.43)-inspired desktop download manager built with **Electron** and **Node.js**, featuring dynamic multi-connection HTTP range segmentation, strict TLS verification, an authenticated loopback browser extension bridge, and a classic Win32 3D toolbar UI modernized with live filtering, column sorting, and inline transfer telemetry.

---

## Key Features

### 1. Dynamic Segmented Download Engine (`src/engine/downloader.js`)
- **Multi-Connection Acceleration:** Supports `1`, `4`, `8`, `16`, and `32` concurrent connections per download task.
- **Cooperative Work-Stealing Segmentation:** When a worker finishes its assigned byte range early, it dynamically splits the largest remaining active segment (`>= 2 * minSegmentSize`, default `512 KB`) at its midpoint without byte overlap or omission.
- **Strict Protocol Validation:**
  - Enforces strict TLS certificate verification (`rejectUnauthorized: true`) and blocks `HTTPS -> HTTP` redirect downgrades.
  - Parses and validates `206 Partial Content` and `Content-Range: bytes start-end/total` headers against the requested segment bounds before writing to disk.
  - Protects partial downloads from servers that ignore `Range` headers and return `200 OK`.
  - Validates `ETag` and `Last-Modified` continuity across pause/resume cycles to detect remote file changes.
- **Atomic Finalization & Integrity Verification:**
  - Assembles verified `.part` files into a temporary staging file (`.idm_assembling_<taskId>.tmp`), computes the full-file **SHA-256** digest during assembly, verifies against an optional user-supplied expected SHA-256 checksum, and atomically renames to the target path.
- **Global Bandwidth Rate Limiter:** Token-bucket rate limiter (`TokenBucketLimiter`) enforces configurable KB/s speed caps across active connections.

### 2. Authenticated Loopback Browser Integration (`src/bridge/localServer.js` & `browser-extension/`)
- **Loopback-Only Binding:** Strictly binds to `127.0.0.1` and refuses `0.0.0.0` or external interfaces.
- **Port Discovery & Failover:** Binds to primary port `1001` with automatic failover across candidate ports `10010`–`10014` if occupied, writing discovery metadata to `~/.personal-idm/bridge-info.json`.
- **Authenticated Extension Handshake:**
  - Browser extension (`browser-extension/background.js`) probes `/api/v1/discovery` across candidate ports, verifies `service: "personal-idm"`, and performs an Origin-verified handshake via `POST /api/v1/handshake` to obtain the 256-bit Bearer token (`crypto.timingSafeEqual`).
  - Automatically re-discovers and re-authenticates if the desktop app restarts on a different port or rotates its token.
  - Rejects arbitrary website origins (`https://...`) with `403 Forbidden` (no wildcard `*` CORS).

### 3. Classic Win32 IDM UI + Modern Telemetry (`src/renderer/`)
- Preserves the authentic Win32 IDM 6.43 3D toolbar bitmap sprites (`3d_large_3.bmp`, `3d_largeHot_3.bmp`), including **Scheduler** (`#tbScheduler`) and **Site Grabber** (`#tbGrabber`) in their original toolbar positions with dedicated feature preview dialogs.
- **Modern Table Enhancements:** Live search & status filter bar, clickable sortable column headers (`File Name`, `Size`, `Status`, `Time left`, `Transfer rate`, `Last Try Date`), inline progress bars, semantic status badges, `tabular-nums` alignment, and SHA-256 copy badges.

---

## Project Structure

```text
├── Run-Personal-IDM.bat               # Windows quick-launch script
├── TECHNICAL_AUDIT_REPORT.md          # Full technical audit & architecture review
└── personal-idm/
    ├── package.json
    ├── src/
    │   ├── main/
    │   │   ├── main.js                # Electron main process & IPC handlers
    │   │   └── preload.cjs            # Context-isolated renderer bridge
    │   ├── engine/
    │   │   ├── downloader.js          # Segmented HTTP/HTTPS engine & work-stealing scheduler
    │   │   └── queueManager.js        # Persistent task queue, config.json & temp cleanup
    │   ├── bridge/
    │   │   └── localServer.js         # Loopback integration server & token auth
    │   └── renderer/
    │       ├── index.html             # Main window, toolbar & modal dialogs
    │       ├── style.css              # Classic Win32 + modern telemetry styling
    │       ├── app.js                 # Renderer state, sorting, filtering & IPC events
    │       └── assets/                # Original 3D toolbar bitmaps & icons
    ├── browser-extension/
    │   ├── manifest.json              # Chrome/Edge Manifest V3 extension
    │   └── background.js              # Port discovery, handshake & download interception
    └── tests/
        ├── engine.test.js             # Multi-connection, resume, work-stealing & SHA-256 tests
        ├── security.test.js           # TLS validation, downgrade & bridge security tests
        ├── ui_and_sync.test.js        # Toolbar preservation & 8-case extension sync tests
        └── benchmark.js               # Reproducible local throughput & work-stealing benchmark
```

---

## Getting Started

### Prerequisites
- **Node.js** `v20+` (tested on Node `v24.20.0`)
- **npm**

### Install & Run
```bash
cd personal-idm
npm install
npm start
```

### Run Automated Tests & Benchmarks
```bash
cd personal-idm
npm test
npm run benchmark
```
