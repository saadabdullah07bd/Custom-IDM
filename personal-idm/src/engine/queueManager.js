import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { DownloadTask, TokenBucketLimiter } from './downloader.js';

export class QueueManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.storageDir = options.storageDir || path.join(os.homedir(), '.personal-idm');
    this.storageFile = path.join(this.storageDir, 'tasks.json');
    this.configFile = path.join(this.storageDir, 'config.json');

    // Sensible defaults
    this.defaultDownloadDir = options.defaultDownloadDir || path.join(os.homedir(), 'Downloads');
    this.maxConcurrent = options.maxConcurrent || 3;
    this.defaultConnections = options.defaultConnections || 8;
    this.speedLimitKbps = options.speedLimitKbps || 0;
    this.notificationsEnabled = options.notificationsEnabled !== undefined ? Boolean(options.notificationsEnabled) : true;

    this.speedLimiter = new TokenBucketLimiter(this.speedLimitKbps * 1024);
    this.tasks = new Map(); // id -> DownloadTask

    this._ensureStorage();
    this._loadConfig(options);
    this._loadTasks();
    this._cleanupAbandonedTempDirs();
  }

  _ensureStorage() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    if (!fs.existsSync(this.defaultDownloadDir)) {
      try {
        fs.mkdirSync(this.defaultDownloadDir, { recursive: true });
      } catch {}
    }
  }

  _loadConfig(initialOptions = {}) {
    if (fs.existsSync(this.configFile)) {
      try {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          if (typeof saved.defaultDownloadDir === 'string' && saved.defaultDownloadDir.trim() && !initialOptions.defaultDownloadDir) {
            this.defaultDownloadDir = saved.defaultDownloadDir.trim();
          }
          if (Number.isInteger(saved.defaultConnections) && saved.defaultConnections >= 1 && saved.defaultConnections <= 32 && !initialOptions.defaultConnections) {
            this.defaultConnections = saved.defaultConnections;
          }
          if (Number.isInteger(saved.maxConcurrent) && saved.maxConcurrent >= 1 && saved.maxConcurrent <= 10 && !initialOptions.maxConcurrent) {
            this.maxConcurrent = saved.maxConcurrent;
          }
          if (typeof saved.speedLimitKbps === 'number' && saved.speedLimitKbps >= 0 && initialOptions.speedLimitKbps === undefined) {
            this.speedLimitKbps = Math.floor(saved.speedLimitKbps);
            this.speedLimiter.setRate(this.speedLimitKbps * 1024);
          }
          if (typeof saved.notificationsEnabled === 'boolean' && initialOptions.notificationsEnabled === undefined) {
            this.notificationsEnabled = saved.notificationsEnabled;
          }
        }
      } catch (err) {
        console.error('Error loading configuration, using defaults:', err.message);
      }
    }
    if (!fs.existsSync(this.defaultDownloadDir)) {
      try {
        fs.mkdirSync(this.defaultDownloadDir, { recursive: true });
      } catch {}
    }
  }

  saveConfig() {
    try {
      const cfg = this.getSettings();
      fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (err) {
      console.error('Error saving configuration:', err.message);
    }
  }

  getSettings() {
    return {
      defaultDownloadDir: this.defaultDownloadDir,
      defaultConnections: this.defaultConnections,
      maxConcurrent: this.maxConcurrent,
      speedLimitKbps: this.speedLimitKbps,
      notificationsEnabled: this.notificationsEnabled
    };
  }

  /**
   * Validates and persists user settings without disrupting active tasks
   */
  updateSettings(partial = {}) {
    if (!partial || typeof partial !== 'object') {
      throw new Error('Settings payload must be an object');
    }

    if (partial.defaultDownloadDir !== undefined) {
      if (typeof partial.defaultDownloadDir !== 'string' || !partial.defaultDownloadDir.trim() || partial.defaultDownloadDir.includes('\0')) {
        throw new Error('defaultDownloadDir must be a valid non-empty directory path');
      }
      const resolvedDir = path.resolve(partial.defaultDownloadDir.trim());
      if (!fs.existsSync(resolvedDir)) {
        fs.mkdirSync(resolvedDir, { recursive: true });
      }
      const stat = fs.statSync(resolvedDir);
      if (!stat.isDirectory()) {
        throw new Error('defaultDownloadDir path is not a directory');
      }
      this.defaultDownloadDir = resolvedDir;
    }

    if (partial.defaultConnections !== undefined) {
      const conn = Number(partial.defaultConnections);
      if (!Number.isInteger(conn) || conn < 1 || conn > 32) {
        throw new Error('defaultConnections must be an integer between 1 and 32');
      }
      this.defaultConnections = conn;
    }

    if (partial.maxConcurrent !== undefined) {
      const maxC = Number(partial.maxConcurrent);
      if (!Number.isInteger(maxC) || maxC < 1 || maxC > 10) {
        throw new Error('maxConcurrent must be an integer between 1 and 10');
      }
      this.maxConcurrent = maxC;
    }

    if (partial.speedLimitKbps !== undefined) {
      const limit = Number(partial.speedLimitKbps);
      if (!Number.isFinite(limit) || limit < 0 || limit > 10000000) {
        throw new Error('speedLimitKbps must be a non-negative number');
      }
      this.speedLimitKbps = Math.floor(limit);
      this.speedLimiter.setRate(this.speedLimitKbps * 1024);
    }

    if (partial.notificationsEnabled !== undefined) {
      this.notificationsEnabled = Boolean(partial.notificationsEnabled);
    }

    this.saveConfig();
    this._scheduleNext();
    this.emit('settings-updated', this.getSettings());
    return this.getSettings();
  }

  _loadTasks() {
    if (fs.existsSync(this.storageFile)) {
      try {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const data of list) {
            if (data.status === 'downloading' || data.status === 'connecting' || data.status === 'merging') {
              data.status = 'paused';
            }
            const task = new DownloadTask({
              ...data,
              speedLimiter: this.speedLimiter
            });
            // Synchronize downloadedBytes with verified part files on disk if unfinished
            if (task.status !== 'completed' && fs.existsSync(task.tempDir)) {
              task._syncSegmentsFromDisk();
            }
            this._bindTaskEvents(task);
            this.tasks.set(task.id, task);
          }
        }
      } catch (err) {
        console.error('Error loading tasks storage:', err);
      }
    }
  }

  /**
   * Safely cleans up abandoned .idm_temp_${taskId} directories and .idm_assembling_${taskId}.tmp files
   * whose tasks no longer exist or are already completed.
   */
  _cleanupAbandonedTempDirs() {
    const dirsToScan = new Set([this.defaultDownloadDir]);
    for (const task of this.tasks.values()) {
      if (task.targetDir) dirsToScan.add(task.targetDir);
    }

    for (const dir of dirsToScan) {
      if (!dir || !fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('.idm_temp_')) {
            const taskId = entry.name.slice('.idm_temp_'.length);
            const task = this.tasks.get(taskId);
            if (!task || task.status === 'completed') {
              const fullPath = path.join(dir, entry.name);
              try {
                fs.rmSync(fullPath, { recursive: true, force: true });
              } catch {}
            }
          } else if (entry.isFile() && entry.name.startsWith('.idm_assembling_') && entry.name.endsWith('.tmp')) {
            const taskId = entry.name.slice('.idm_assembling_'.length, -'.tmp'.length);
            const task = this.tasks.get(taskId);
            if (!task || task.status !== 'merging') {
              const fullPath = path.join(dir, entry.name);
              try {
                fs.unlinkSync(fullPath);
              } catch {}
            }
          }
        }
      } catch {}
    }
  }

  saveTasks() {
    try {
      const data = Array.from(this.tasks.values()).map(t => t.toJSON());
      fs.writeFileSync(this.storageFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('Error saving tasks:', err);
    }
  }

  _bindTaskEvents(task) {
    task.on('update', (taskData) => {
      this.emit('task-updated', taskData);
      this.saveTasks();
    });

    task.on('complete', (taskData) => {
      this.emit('task-completed', taskData);
      this.saveTasks();
      this._scheduleNext();
    });

    task.on('error', (err) => {
      this.emit('task-error', { id: task.id, error: err.message });
      this.saveTasks();
      this._scheduleNext();
    });
  }

  /**
   * Adds a new download task
   */
  async addTask(options) {
    const task = new DownloadTask({
      url: options.url,
      targetDir: options.targetDir || this.defaultDownloadDir,
      filename: options.filename,
      maxConnections: options.maxConnections || this.defaultConnections,
      expectedSha256: options.expectedSha256,
      conflictPolicy: options.conflictPolicy || 'rename',
      maxRetries: options.maxRetries,
      baseRetryDelayMs: options.baseRetryDelayMs,
      requestTimeoutMs: options.requestTimeoutMs,
      minSegmentSize: options.minSegmentSize,
      dynamicSegmentation: options.dynamicSegmentation,
      mergeStrategy: options.mergeStrategy,
      tlsOptions: options.tlsOptions,
      speedLimiter: options.speedLimiter || this.speedLimiter,
      addedAt: new Date().toISOString()
    });

    this._bindTaskEvents(task);
    this.tasks.set(task.id, task);
    this.saveTasks();
    this.emit('task-added', task.toJSON());

    await task.init();

    if (options.autoStart !== false) {
      this.startTask(task.id);
    } else {
      task.status = 'pending';
      this.saveTasks();
      this.emit('task-updated', task.toJSON());
    }

    return task.toJSON();
  }

  startTask(id) {
    const task = this.tasks.get(id);
    if (!task || task.status === 'completed') return;

    const activeCount = this.getActiveCount();
    if (activeCount >= this.maxConcurrent) {
      task.status = 'pending';
      this.saveTasks();
      this.emit('task-updated', task.toJSON());
      return;
    }

    task.start();
  }

  async pauseTask(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    await task.pause();
    this.saveTasks();
    this._scheduleNext();
  }

  resumeTask(id) {
    this.startTask(id);
  }

  /**
   * Cancels and deletes a task, cleaning up its temporary directory (unless retainPartial is true)
   */
  async deleteTask(id, deleteFile = false, retainPartial = false) {
    const task = this.tasks.get(id);
    if (!task) return;

    await task.cancel(!retainPartial);

    if (deleteFile && task.targetPath && fs.existsSync(task.targetPath)) {
      const resolvedTarget = path.resolve(task.targetPath);
      const resolvedDir = path.resolve(task.targetDir);
      if (path.dirname(resolvedTarget) === resolvedDir) {
        try {
          fs.unlinkSync(resolvedTarget);
        } catch (err) {
          console.error('Failed to delete file from disk:', err);
        }
      }
    }

    this.tasks.delete(id);
    this.saveTasks();
    this.emit('task-deleted', id);
    this._scheduleNext();
  }

  async pauseAll() {
    const promises = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'downloading' || task.status === 'connecting' || task.status === 'pending') {
        if (task.status === 'pending') {
          task.status = 'paused';
          this.emit('task-updated', task.toJSON());
        } else {
          promises.push(task.pause());
        }
      }
    }
    await Promise.allSettled(promises);
    this.saveTasks();
  }

  resumeAll() {
    for (const task of this.tasks.values()) {
      if (task.status === 'paused' || task.status === 'pending' || task.status === 'error') {
        task.status = 'pending';
      }
    }
    this.saveTasks();
    this._scheduleNext();
  }

  getActiveCount() {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'downloading' || task.status === 'connecting' || task.status === 'merging') {
        count++;
      }
    }
    return count;
  }

  _scheduleNext() {
    if (this.getActiveCount() >= this.maxConcurrent) return;

    for (const task of this.tasks.values()) {
      if (task.status === 'pending') {
        this.startTask(task.id);
        if (this.getActiveCount() >= this.maxConcurrent) break;
      }
    }
  }

  getAllTasks() {
    return Array.from(this.tasks.values()).map(t => t.toJSON());
  }

  getTask(id) {
    const task = this.tasks.get(id);
    return task ? task.toJSON() : null;
  }
}
