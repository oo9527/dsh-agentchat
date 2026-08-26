'use strict';

/**
 * Shared worker pool (v27) — one pool instance per orchestrator process.
 *
 * Both AgentChat-IndependentTasks and AgentChat-WebSubAgent call
 * createExecutor() (lib/execute.js) to run provider calls. Without a shared
 * pool each createExecutor() would fork its own worker fleet — IndependentTasks
 * alone creates a second executor for --per-call mode, which would double the
 * workers. This module memoizes ONE WorkerPool per process so every executor
 * in the process routes through the same warm workers.
 *
 * The pool is opt-OUT: it activates by default (v27) because any pool failure
 * degrades to the exact pre-v27 spawn path — acceleration with zero new failure
 * classes. Set AGENTCHAT_WORKER_POOL=0 to disable and restore pure spawn.
 */

const { WorkerPool, resolvePoolSize } = require('./worker-pool');
const { log: _log } = require('./terminal');

let shared = null;

/**
 * Resolve whether the shared pool should be enabled.
 * Default ON (v27): the pool is a pure acceleration with spawn fallback on any
 * failure, so it ships enabled. Explicitly disable with AGENTCHAT_WORKER_POOL=0
 * (or 'false'/'off'/'no') to restore the exact pre-v27 spawn behavior.
 * @param {NodeJS.ProcessEnv} env
 */
function poolEnabled(env = process.env) {
    const flag = String(env.AGENTCHAT_WORKER_POOL || '').toLowerCase();
    if (['0', 'false', 'off', 'no'].includes(flag)) return false;
    return true;
}

/**
 * Get (creating on first call) the process-wide shared worker pool.
 * @param {object} [opts]
 * @param {boolean} [opts.force]  create even when poolEnabled() is false
 * @returns {WorkerPool|null} null when disabled (callers then use spawn)
 */
function getSharedPool({ force = false } = {}) {
    if (shared) return shared;
    if (!force && !poolEnabled()) return null;
    shared = new WorkerPool({
        size: resolvePoolSize(),
        log: (msg) => _log('pool', msg),
    });
    return shared;
}

/** Dispose the shared pool (idempotent). Call on process exit. */
function disposeSharedPool() {
    if (shared) {
        shared.dispose();
        shared = null;
    }
}

module.exports = { getSharedPool, disposeSharedPool, poolEnabled, WorkerPool };
