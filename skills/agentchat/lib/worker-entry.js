#!/usr/bin/env node
/**
 * Worker-pool entry (v27) — one forked process per pool slot.
 *
 * Each worker is a long-lived Node process that:
 *   1. Loads playwright-core ONCE (shared with the CLI entry via the same
 *      module instance) — the per-call `spawn` model paid this ~50MB load
 *      for every provider attempt.
 *   2. Connects to Chrome CDP ONCE and keeps the browser warm — the
 *      per-call model re-ran ensureChromeCdp() + connectWithRetry() every
 *      time, adding hundreds of ms of handshake to each subprocess.
 *   3. Serves requests over IPC: `{type:'run', id, prompt, opts}` →
 *      executes the SAME pipeline as the CLI (AgentChat-OneWeb's exported
 *      executeOnce) and replies `{type:'result', id, outcome}`.
 *
 * Concurrency is deliberately ONE request at a time per worker: browser-slot
 * admission control (lib/locks.js) already caps concurrent page automations
 * across all callers, and the pool's job is to amortize startup cost, not to
 * add another parallel execution layer that would race the same provider
 * locks. Pool size therefore mirrors AGENTCHAT_MAX_CONCURRENT_PAGES (default
 * 3) in lib/worker-pool.js.
 *
 * stdout/stderr are PIPED to the parent (fork's silent:true) so the pool can
 * forward them — worker logs and receipts still reach the user's terminal,
 * and execute.js's structured-error parsing sees the same stderr lines it
 * would from a fresh subprocess.
 */

'use strict';

const path = require('path');
const { createRequire } = require('module');

// Resolve playwright-core + the OneWeb module FROM the OneWeb skill directory
// (this lib/ dir has no node_modules — see lib/cdp.js header). createRequire
// anchors resolution at AgentChat-OneWeb/package.json so both the module load
// and its internal `require('playwright-core')` find the installed copy.
const ONEWEB_DIR = path.resolve(__dirname, '..', 'AgentChat-OneWeb');
const onewebRequire = createRequire(path.join(ONEWEB_DIR, 'package.json'));
const { chromium } = onewebRequire('playwright-core');
const oneweb = onewebRequire('./index.js');

const cdp = require('./cdp');

// ── Warm connection state ──────────────────────────────────────────────────

let browser = null;      // warm CDP browser, reused across requests
let connecting = null;   // in-flight (re)connect promise — dedupes burst starts

/**
 * Return a warm CDP browser, (re)connecting on demand. Serializes concurrent
 * starters so a wave of requests sharing this worker triggers ONE handshake.
 * @returns {Promise<object>} playwright browser (CDP guest session)
 */
async function ensureBrowser() {
    if (browser && browser.isConnected && browser.isConnected()) return browser;
    if (connecting) return connecting;
    connecting = (async () => {
        const ensured = await cdp.ensureChromeCdp(cdp.CDP_URL, () => {});
        if (!ensured.up) {
            throw new Error(`Chrome CDP not reachable: ${ensured.reason || cdp.CDP_URL}`);
        }
        browser = await cdp.connectWithRetry(chromium, cdp.CDP_URL, 3, () => {});
        return browser;
    })().finally(() => { connecting = null; });
    return connecting;
}

/**
 * Send a reply to the pool, tolerating a disconnected parent.
 * @returns {boolean} true when the message was actually sent
 */
function send(msg) {
    try {
        if (!process.connected) return false;
        process.send(msg);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Handle one IPC request. Never throws across the boundary — every failure
 * path answers with `{type:'result', id, error}` so the pool can settle its
 * pending promise instead of hanging on a dead worker.
 */
async function handle(msg) {
    const { id, prompt, opts } = msg;
    try {
        const b = await ensureBrowser();
        const ctx = new oneweb.InvocationContext();
        // v27: streaming-delta lines from executeOnce land on THIS worker's
        // stderr, which the pool forwards to the parent's stderr (see
        // worker-pool.js proc.stderr piping) — the caller sees live progress
        // exactly as it would from a fresh subprocess.
        const outcome = await oneweb.executeOnce(b, prompt, ctx, opts || {});
        send({ type: 'result', id, outcome });
    } catch (err) {
        const detail = String((err && err.message) || err);
        send({ type: 'result', id, error: detail });
        // A failed (re)connect poisons the browser handle; drop it so the next
        // request tries a fresh connection instead of a dead one.
        if (browser) { try { browser.close().catch(() => {}); } catch (_) {} browser = null; }
    }
}

process.on('message', (msg) => {
    if (!msg || msg.type !== 'run') return;
    // Fire-and-forget: reply via process.send inside handle().
    handle(msg).catch(() => {});
});

process.on('disconnect', () => {
    // Parent pool disposed or crashed — exit cleanly (no zombies).
    process.exit(0);
});

// Warm up immediately: the pool pays the playwright-core + CDP handshake
// during startup rather than on the first request. Failure is non-fatal —
// ensureBrowser() retries on demand.
ensureBrowser().catch(() => {});
