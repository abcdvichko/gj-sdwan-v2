/**
 * scheduler.js - 精准定时调度器
 * 替代 node-cron，纯 Node.js 实现
 * 特性：
 *  - 支持间隔调度（每N秒）
 *  - 支持防并发（上次未完成则跳过）
 *  - 支持错误捕获 + 重试
 *  - 支持动态调整间隔
 */

class Job {
  constructor(name, fn, intervalMs, options = {}) {
    this.name       = name;
    this.fn         = fn;
    this.intervalMs = intervalMs;
    this.running    = false;
    this.lastRun    = null;
    this.lastError  = null;
    this.runCount   = 0;
    this.errCount   = 0;
    this.skipOnBusy = options.skipOnBusy !== false; // 默认跳过
    this.retryDelay = options.retryDelay || 0;
    this._timer     = null;
    this._stopped   = false;
  }

  async _run() {
    if (this._stopped) return;
    if (this.running && this.skipOnBusy) {
      console.log(`[Scheduler] ${this.name} 上次仍在运行，跳过本次`);
      return;
    }
    this.running = true;
    this.lastRun = new Date();
    try {
      await this.fn();
      this.runCount++;
      this.lastError = null;
    } catch (e) {
      this.errCount++;
      this.lastError = e.message;
      console.error(`[Scheduler] ${this.name} 执行出错:`, e.message);
    } finally {
      this.running = false;
    }
  }

  start(runImmediately = false) {
    this._stopped = false;
    if (runImmediately) {
      setTimeout(() => this._run(), 1000);
    }
    this._timer = setInterval(() => this._run(), this.intervalMs);
    return this;
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  setInterval(ms) {
    this.intervalMs = ms;
    this.stop();
    this.start();
  }

  status() {
    return {
      name:       this.name,
      running:    this.running,
      lastRun:    this.lastRun,
      lastError:  this.lastError,
      runCount:   this.runCount,
      errCount:   this.errCount,
      intervalMs: this.intervalMs,
    };
  }
}

class Scheduler {
  constructor() {
    this._jobs = {};
  }

  every(name, intervalMs, fn, options = {}) {
    const job = new Job(name, fn, intervalMs, options);
    this._jobs[name] = job;
    return job;
  }

  start(name, runImmediately = false) {
    const job = this._jobs[name];
    if (job) job.start(runImmediately);
    return job;
  }

  stop(name) {
    const job = this._jobs[name];
    if (job) job.stop();
  }

  stopAll() {
    Object.values(this._jobs).forEach(j => j.stop());
  }

  status() {
    return Object.values(this._jobs).map(j => j.status());
  }

  getJob(name) {
    return this._jobs[name];
  }
}

module.exports = Scheduler;
