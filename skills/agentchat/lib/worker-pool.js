'use strict';

/**
 * Worker pool (v27) — amortize per-call startup cost across many provider
 * attempts.
 *
 * The pre-pool model (lib/execute.js callProvider) spawned a fresh `node
 * AgentChat-OneWeb/index.js` for EVERY provider attempt: each child paid
 * ~50MB of playwright-core loading plus a full ensureChromeCdp + CDP
 * handshake. Under an 8-way IndependentTasks wave that is 8 processes ×
 * (50MB + ~300ms handshake) per wave. This pool forks a small set of
 * long-lived workers (lib/worker-entry.js), each holding one warm CDP
 * browser, and routes requests to them over IPC.
 *
 * Design constraints:
 *   - ONE request at a time per worker. Provider/browser admission control
 *     (lib/locks.js) already caps concurrent automations; the pool exists to
 *     amortize startup, not to add a parallel layer that races the locks.
 *   - Pool size mirrors AGENTCHAT_MAX_CONCURRENT_PAGES (default 3), clamped
 *     1..8. Override explicitly with AGENTCHAT_WORKER_POOL_SIZE.
 *   - The pool is an ACCELERATION LAYER, never a new failure class: a busy or
 *     unhealthy pool degrades to `null` from execute() so the caller falls
 *     back to the battle-tested spawn path. Queue waits are bounded by the
 *     caller's remaining budget.
 *   - Crash resilience: a dead worker is restarted (bounded) and its pending
 *     request rejects to spawn fallback; a worker that stops answering a
 *     request within budget+grace is killed and replaced.
 */

const { fork } = require('child_process');
const path = require('path');

const WORKER_ENTRY = path.join(__dirname, 'worker-entry.js');
const DEFAULT_POOL_SIZE = 3;
const MAX_POOL_SIZE = 8;
const MAX_WORKER_RESTARTS = 3;        // per worker slot, before declaring the pool broken
const REQUEST_GRACE_MS = 15_000;      // beyond the request budget before we kill the worker
const QUEUE_MAX_WAIT_MS = 20_000;     // a queued request waits at most this long for a free worker

function resolvePoolSize(env = process.env) {
    const n = parseInt(env.AGENTCHAT_WORKER_POOL_SIZE || env.AGENTCHAT_MAX_CONCURRENT_PAGES, 10);
    if (Number.isFinite(n) && n >= 1) return Math.min(n, MAX_POOL_SIZE);
    return DEFAULT_POOL_SIZE;
}

class WorkerPool {
    /**
     * @param {object} [opts]
     * @param {number} [opts.size]  pool size (default: resolvePoolSize())
     * @param {(msg: string) => void} [opts.log]  stderr log sink
     */
    constructor({ size, log } = {}) {
        this.size = size || resolvePoolSize();
        this.log = log || ((msg) => process.stderr.write(`[worker-pool] ${msg}\n`));
        /** workerId -> { proc, busy, restarts } */
        this.workers = new Map();
        /** FIFO of idle worker entries (least-recently-freed first). */
        this.idle = [];
        /** FIFO of requests waiting for a free worker. */
        this.queue = [];
        this.nextId = 1;
        this.closed = false;
        this._spawnAll();
    }

    /** Fork `size` workers. Caller must tolerate partial spawn (fork errors). */
    _spawnAll() {
        for (let i = 0; i < this.size; i++) this._spawnWorker();
    }

    _spawnWorker() {
        const id = `w${this.nextId++}`;
        let proc;
        try {
            // silent:true → we own stdout/stderr forwarding (receipts and logs
            // must still reach the user's terminal; the response itself rides
            // the IPC result, never the worker's stdout).
            proc = fork(WORKER_ENTRY, [], { silent: true });
        } catch (err) {
            this.log(`spawn ${id} failed: ${err.message}`);
            return null;
        }
        const entry = { proc, busy: false, restarts: 0, id };
        this.workers.set(id, entry);
        this.idle.push(entry);

        proc.stdout.on('data', (d) => process.stdout.write(d));
        proc.stderr.on('data', (d) => process.stderr.write(d));

        proc.on('message', (msg) => this._onMessage(id, msg));
        proc.on('error', (err) => this.log(`worker ${id} error: ${err.message}`));
        proc.on('exit', (code, signal) => this._onExit(id, code, signal));
        return entry;
    }

    _onMessage(id, msg) {
        const entry = this.workers.get(id);
        if (!entry || !entry.busy) return; // stale result after restart — drop
        if (msg && msg.type === 'result') {
            entry.busy = false;
            const settle = entry.settle;
            entry.settle = null;
            clearTimeout(entry.killTimer);
            entry.killTimer = null;
            this._recycle(entry);
            if (settle) {
                if (msg.error) settle.reject(new Error(msg.error));
                else settle.resolve({ ...(msg.outcome || {}), workerId: id });
            }
            this._drainQueue();
        }
    }

    _onExit(id, code, signal) {
        const entry = this.workers.get(id);
        if (!entry) return;
        this.workers.delete(id);
        const i = this.idle.indexOf(entry);
        if (i >= 0) this.idle.splice(i, 1);
        const settle = entry.settle;
        if (settle) {
            entry.busy = false;
            entry.settle = null;
            clearTimeout(entry.killTimer);
            settle.reject(new Error(`worker ${id} exited (code=${code} signal=${signal})`));
        }
        // Restart unless we're shutting down or this slot has crashed too often.
        if (!this.closed && entry.restarts < MAX_WORKER_RESTARTS) {
            entry.restarts++;
            this._spawnWorker();
        } else if (!this.closed) {
            this.log(`worker ${id} exceeded ${MAX_WORKER_RESTARTS} restarts — pool degraded`);
        }
        this._drainQueue();
    }

    /** Move an idle worker to the back of the idle FIFO (round-robin reuse). */
    _recycle(entry) {
        const i = this.idle.indexOf(entry);
        if (i >= 0) this.idle.splice(i, 1);
        this.idle.push(entry);
    }

    _drainQueue() {
        while (this.queue.length > 0 && this.idle.length > 0) {
            const { request, settle } = this.queue.shift();
            const entry = this.idle.shift();
            if (!entry) { settle.reject(new Error('pool drained without a worker')); continue; }
            this._dispatch(entry, request).then(settle.resolve, settle.reject);
        }
    }

    _dispatch(entry, request) {
        return new Promise((resolve, reject) => {
            entry.busy = true;
            entry.settle = { resolve, reject };
            // Budget + grace: if the worker neither answers nor dies, kill it
            // and reject — the caller falls back to spawn for this request.
            const budget = Number.isFinite(request.timeoutMs) ? request.timeoutMs : 180_000;
            entry.killTimer = setTimeout(() => {
                if (!entry.busy) return;
                this.log(`worker ${entry.id} exceeded budget+grace (${budget + REQUEST_GRACE_MS}ms) — killing`);
                try { entry.proc.kill('SIGKILL'); } catch (_) {}
            }, budget + REQUEST_GRACE_MS);
            const opts = {
                totalTimeout: budget,
                providerTimeout: budget,
                startFrom: request.provider,
                singleAttempt: true,
                keepTabs: true,
                ephemeralTab: !!request.ephemeralTab,
                downloadImages: request.downloadImages !== false,
                images: request.images || [],
                cwd: request.cwd || process.cwd(),
            };
            try {
                entry.proc.send({ type: 'run', id: entry.id, prompt: request.prompt, opts });
            } catch (err) {
                entry.busy = false;
                entry.settle = null;
                clearTimeout(entry.killTimer);
                reject(err);
                this._recycle(entry);
            }
        });
    }

    /**
     * Execute one single-provider call through the pool.
     *
     * @param {object} request
     * @param {string} request.prompt       the prompt to send
     * @param {string} request.provider     provider key (--only semantics)
     * @param {number} request.timeoutMs    wall-clock budget for this attempt
     * @param {boolean} [request.ephemeralTab] dedicated tab, never reused
     * @param {boolean} [request.downloadImages] auto-download response images
     * @param {Array} [request.images]      pre-encoded images
     * @param {string} [request.cwd]        download target directory
     * @returns {Promise<{exitCode: number, stdout: string|null, workerId: string}>}
     *          Rejects when the pool is unhealthy or the worker dies — the
     *          caller should fall back to its spawn path.
     */
    execute(request) {
        if (this.closed || this.workers.size === 0) {
            return Promise.reject(new Error('worker pool unavailable'));
        }
        if (this.idle.length > 0) {
            const entry = this.idle.shift();
            return this._dispatch(entry, request);
        }
        // All workers busy — queue with a bounded wait, then degrade to spawn.
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = this.queue.findIndex(q => q.settle === settle);
                if (i >= 0) this.queue.splice(i, 1);
                reject(new Error('worker pool queue wait exceeded'));
            }, QUEUE_MAX_WAIT_MS);
            const settle = {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            };
            this.queue.push({ request, settle });
        });
    }

    /** Number of live workers (for diagnostics). */
    get liveCount() { return this.workers.size; }

    /** Dispose every worker. Idempotent. */
    dispose() {
        if (this.closed) return;
        this.closed = true;
        for (const entry of this.workers.values()) {
            clearTimeout(entry.killTimer);
            if (entry.settle) {
                entry.settle.reject(new Error('worker pool disposed'));
                entry.settle = null;
            }
            try { entry.proc.disconnect(); } catch (_) {}
            try { entry.proc.kill('SIGTERM'); } catch (_) {}
        }
        this.workers.clear();
        this.idle = [];
        for (const q of this.queue) q.settle.reject(new Error('worker pool disposed'));
        this.queue = [];
    }
}

module.exports = { WorkerPool, resolvePoolSize, DEFAULT_POOL_SIZE, MAX_POOL_SIZE };
