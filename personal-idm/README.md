# Personal IDM (Internet Download Manager)
> *The "brother from another mother" of IDM — with multi-part dynamic segmentation acceleration and modern Windows 11 Fluent styling.*

---

## ✨ Features

- **Multi-Part Dynamic Segmentation**: Splits files into up to **32 concurrent connections** using HTTP `Range: bytes=start-end`.
- **Zero-Stitch Direct Offset I/O**: Each thread streams directly to its assigned file sector via pre-allocated file descriptors. No post-download stitching delay!
- **Pause & Resume**: Fully preserves segment offsets in `.personal-idm/tasks.json` so downloads can pause and resume across restarts.
- **The Iconic IDM Segment Visualizer**:
  - Live animated visualizer showing parallel thread lanes (`Part 1`, `Part 2`, ..., `Part N`) filling up dynamically in real time.
  - Live speedometer with exponential moving average, remaining time estimation, and resume capability badge.
- **Modern Fluent Aesthetic**:
  - Exact functional layout of classic IDM (Categories sidebar, Action Toolbar, Data Grid).
  - Dark Mode and Light Mode support with smooth transitions.
  - Media categorizer (Compressed, Documents, Music, Programs, Video).
- **Browser Integration & Local API**:
  - Runs a local bridge server on `http://127.0.0.1:1001` (matching IDM's local port!).
  - **1-Click Bookmarklet**: Instant download catcher for Chrome, Edge, Firefox, Brave, and Opera.
  - **Manifest V3 Browser Extension**: Found in `browser-extension/` to intercept downloads and provide right-click context menu: *"Download with Personal IDM"*.

---

## 🚀 How to Run

### Option 1: Double-Click Launcher
Double-click [`Run-Personal-IDM.bat`](file:///d:/My%20Projects/Personal%20IDM/Run-Personal-IDM.bat) in the project root.

### Option 2: Terminal / Command Prompt
```bash
cd "d:\My Projects\Personal IDM\personal-idm"
npm start
```

---

## 🌐 Browser Integration Setup

### A. 1-Click Browser Bookmarklet (Zero Installation)
1. In your browser (Chrome/Edge/Firefox/Brave), open the Bookmark Manager or show the Bookmarks bar (`Ctrl + Shift + B`).
2. Add a new bookmark with:
   - **Name**: `Download with Personal IDM`
   - **URL**:
     ```javascript
     javascript:fetch('http://127.0.0.1:1001/api/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:prompt('Download with Personal IDM:',window.location.href)})}).then(r=>r.json()).then(d=>alert('Added to Personal IDM!'));
     ```
3. Whenever you are on a download page or file link, click this bookmark to immediately catch it into Personal IDM!

### B. Chrome / Edge Unpacked Extension
1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle on **Developer mode** in the top right.
3. Click **Load unpacked** and select the [`personal-idm/browser-extension`](file:///d:/My%20Projects/Personal%20IDM/personal-idm/browser-extension) folder.
4. Right-click any link on the web to see **"Download with Personal IDM"**!
