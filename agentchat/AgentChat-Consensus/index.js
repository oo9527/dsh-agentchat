#!/usr/bin/env node
/**
 * AgentChat-Consensus — Cross-Validation + Agreement Scoring
 *
 * Asks the SAME prompt of N providers in parallel, computes a machine
 * agreement score (bigram Jaccard on normalized text), and returns a
 * consensus answer (the medoid — the answer most similar to the others).
 *
 * Why this exists: the other AgentChat skills either fall back (OneWeb),
 * partition tasks (IndependentTasks), or chain steps (WebSubAgent). None of
 * them answers "which AI is right?" — that needs the SAME question asked of
 * multiple independent models, with agreement measured, not assumed.
 *
 * Design:
 *   - Parallel dispatch through the shared executor (lib/execute.js
 *     callProvider → worker pool → OneWeb --only/--single), one provider per
 *     call, no internal cascade (fallback control lives here).
 *   - Scoring is pure text similarity, no external deps: normalize (lowercase,
 *     strip whitespace/punctuation) → character bigram sets → Jaccard.
 *   - Consensus = medoid: the answer with the highest mean pairwise
 *     similarity to all others. Not a merge, not a vote, not a rewrite —
 *     the calling agent must not hand-edit it.
 *   - Verdict thresholds: >=0.60 high, 0.35-0.60 partial, <0.35 low.
 *
 * Exit codes: 0 = at least one provider answered (consensus computed on the
 * successful subset); 2 = all providers failed; 64 = usage error.
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ══════════════════════════════════════════════════════════════════════════
// GUARD: ../lib is a sibling tree shared by all AgentChat skills
// ══════════════════════════════════════════════════════════════════════════
let acquireProviderSlot, releaseLock, cleanupAllLocks, makeRunId, emitReceipt;
try {
    ({ acquireProviderSlot, releaseLock, cleanupAllLocks } = require('../lib/locks'));
    ({ makeRunId, emitReceipt } = require('../lib/receipt'));
} catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
        process.stderr.write(
            '[consensus] FATAL: ../lib not found — this skill requires the sibling skills/lib/ tree.\n' +
            `[consensus]   fix: clone the full AgentChat repo (or copy skills/lib alongside).\n`);
        process.exit(4);
    }
    throw e;
}

process.on('exit', () => { cleanupAllLocks(); disposeSharedPool(); });
process.on('SIGINT', () => { cleanupAllLocks(); disposeSharedPool(); process.exit(130); });
process.on('SIGTERM', () => { cleanupAllLocks(); disposeSharedPool(); process.exit(143); });

// ══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════

const WEBEXT = path.resolve(__dirname, '..', 'AgentChat-OneWeb', 'index.js');
const { PROVIDER_CHAIN } = require('../lib/providers/chain');
const ALL_KEYS = PROVIDER_CHAIN.map(p => p.key);

const DEFAULT_PROVIDERS = ['gemini', 'chatgpt', 'claude'];
const MIN_PROVIDERS = 2;
const MAX_PROVIDERS = 5;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MIN_CALL_MS = 30_000; // per-provider floor (executor default)

// Verdict thresholds (documented in SKILL.md — keep in sync)
const HIGH_SCORE = 0.60;
const PARTIAL_SCORE = 0.35;

const { createExecutor } = require('../lib/execute');
const { getSharedPool, disposeSharedPool } = require('../lib/shared-pool');
const workerPool = getSharedPool();
const { callProvider, cleanResponse } = createExecutor({
    webextPath: WEBEXT,
    logPrefix: 'consensus',
    minCallBudgetMs: DEFAULT_MIN_CALL_MS,
    holdLockOnSuccess: false,
    acceptUsedMarker: true,
    workerPool,
});

function log(msg) { process.stderr.write(`[consensus] ${msg}\n`); }

// ══════════════════════════════════════════════════════════════════════════
// AGREEMENT SCORING — bigram Jaccard on normalized text
// ══════════════════════════════════════════════════════════════════════════

/** Normalize: lowercase, strip whitespace + punctuation, keep alnum+CJK. */
function normalizeText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .trim();
}

/** Character bigrams of a normalized string. */
function bigrams(norm) {
    const set = new Set();
    for (let i = 0; i + 1 < norm.length; i++) set.add(norm.slice(i, i + 2));
    return set;
}

/** Jaccard similarity of two raw texts (0..1). Empty → 0. */
function similarity(a, b) {
    const na = normalizeText(a), nb = normalizeText(b);
    if (!na || !nb) return 0;
    const A = bigrams(na), B = bigrams(nb);
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    const union = A.size + B.size - inter;
    return union === 0 ? 0 : inter / union;
}

/** Verdict from a score. */
function verdictFor(score) {
    if (score >= HIGH_SCORE) return 'high';
    if (score >= PARTIAL_SCORE) return 'partial';
    return 'low';
}

/**
 * Compute pairwise scores + consensus (medoid) over successful answers.
 * @param {Array<{provider: string, text: string}>} answers
 * @returns {{agreement_score: number, verdict: string, consensus: string|null,
 *            pairwise: Record<string, number>, medoid: string|null}}
 */
function scoreConsensus(answers) {
    if (answers.length === 0) {
        return { agreement_score: 0, verdict: 'low', consensus: null, pairwise: {}, medoid: null };
    }
    if (answers.length === 1) {
        // Single survivor: no cross-validation possible — report honestly.
        return {
            agreement_score: 0,
            verdict: 'low',
            consensus: answers[0].text,
            pairwise: {},
            medoid: answers[0].provider,
        };
    }
    const pairwise = {};
    const meanSim = {};
    for (const a of answers) meanSim[a.provider] = 0;
    let total = 0, pairs = 0;
    for (let i = 0; i < answers.length; i++) {
        for (let j = i + 1; j < answers.length; j++) {
            const s = similarity(answers[i].text, answers[j].text);
            const key = `${answers[i].provider}↔${answers[j].provider}`;
            pairwise[key] = Math.round(s * 100) / 100;
            meanSim[answers[i].provider] += s;
            meanSim[answers[j].provider] += s;
            total += s;
            pairs++;
        }
    }
    // Medoid: the answer whose mean pairwise similarity to all others is highest.
    let medoid = null, best = -1;
    for (const a of answers) {
        const m = meanSim[a.provider] / Math.max(1, answers.length - 1);
        if (m > best) { best = m; medoid = a.provider; }
    }
    const agreement = pairs === 0 ? 0 : total / pairs;
    const consensus = answers.find(a => a.provider === medoid)?.text || null;
    return {
        agreement_score: Math.round(agreement * 100) / 100,
        verdict: verdictFor(agreement),
        consensus,
        pairwise,
        medoid,
    };
}

// ══════════════════════════════════════════════════════════════════════════
// DISPATCH — parallel single-provider calls with per-provider locks
// ══════════════════════════════════════════════════════════════════════════

/**
 * Ask ONE provider via the shared executor, guarding with its provider lock
 * (mutual exclusion against other workers). Returns a normalized entry.
 */
async function askOne(provider, prompt, timeoutMs) {
    const slot = acquireProviderSlot(provider, { max: 1 });
    if (!slot) {
        log(`${provider}: ⏭ locked (in use elsewhere) — skipped`);
        return { provider, ok: false, reason: 'locked' };
    }
    try {
        log(`${provider}: asking… (${Math.round(timeoutMs / 1000)}s budget)`);
        const r = await callProvider(prompt, provider, timeoutMs);
        if (r.ok) {
            const text = cleanResponse(r.text, provider);
            log(`${provider}: ✓ ${text.length} chars`);
            return { provider, ok: true, text, chars: text.length };
        }
        log(`${provider}: ✗ ${r.reason}`);
        return { provider, ok: false, reason: r.reason };
    } finally {
        releaseLock(slot.lockKey);
    }
}

/** Ask all providers in parallel; returns entries in the same order. */
async function askAll(providers, prompt, timeoutMs) {
    const results = await Promise.all(
        providers.map(p => askOne(p, prompt, timeoutMs))
    );
    return results;
}

// ══════════════════════════════════════════════════════════════════════════
// SMOKE / DOCTOR
// ══════════════════════════════════════════════════════════════════════════

async function smokeTest() {
    log('Smoke test — checking OneWeb + at least one provider reachable…');
    if (!fs.existsSync(WEBEXT)) { log(`✗ NOT found: ${WEBEXT}`); return false; }
    const { spawnSync } = require('child_process');
    const r = spawnSync('node', [WEBEXT, '--doctor'], { stdio: 'inherit', timeout: 30000 });
    return (r.status === 0) && !r.error;
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════

async function main() {
    const args = process.argv.slice(2);
    let providers = null, timeout = DEFAULT_TIMEOUT_MS, smoke = false, doctor = false;
    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--smoke') smoke = true;
        else if (a === '--doctor') doctor = true;
        else if (a.startsWith('--providers=')) {
            providers = a.split('=')[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        } else if (a.startsWith('--timeout=')) {
            const v = parseInt(a.split('=')[1], 10);
            if (!isNaN(v) && v > 0) timeout = v < 10000 ? v * 1000 : v;
        } else if (!a.startsWith('--')) positional.push(a);
    }

    // Resolve provider list
    if (providers) {
        const bad = providers.filter(k => !ALL_KEYS.includes(k));
        if (bad.length > 0) {
            log(`ERROR: unknown provider(s): ${bad.join(', ')}. Valid: ${ALL_KEYS.join(', ')}`);
            process.exit(64);
        }
        if (providers.length < MIN_PROVIDERS || providers.length > MAX_PROVIDERS) {
            log(`ERROR: --providers needs ${MIN_PROVIDERS}-${MAX_PROVIDERS} entries, got ${providers.length}`);
            process.exit(64);
        }
    } else {
        providers = DEFAULT_PROVIDERS;
    }

    let prompt = positional.join(' ').trim();
    if (!prompt && !process.stdin.isTTY) {
        try { prompt = fs.readFileSync(0, 'utf8').trim(); } catch (_) { /* stdin not readable */ }
    }

    if (doctor) {
        const { spawnSync } = require('child_process');
        const r = spawnSync('node', [WEBEXT, '--doctor'], { stdio: 'inherit', timeout: 30000 });
        process.exit(r.status || (r.error ? 1 : 0));
    }
    if (!fs.existsSync(WEBEXT)) { log(`FATAL: OneWeb not found: ${WEBEXT}`); process.exit(1); }
    if (smoke) { process.exit(await smokeTest() ? 0 : 2); }
    if (!prompt) {
        log('Usage: node index.js [--providers=gemini,kimi,deepseek] [--timeout=MS] <prompt>');
        process.exit(64);
    }

    const T0 = Date.now();
    log(`Consensus: ${providers.length} providers (${providers.join(', ')}) | budget ${Math.round(timeout / 1000)}s`);

    const answers = await askAll(providers, prompt, timeout);
    const successful = answers.filter(a => a.ok);

    const scored = scoreConsensus(successful.map(a => ({ provider: a.provider, text: a.text })));

    // Execution receipt — embedded INSIDE the output JSON (stdout contract is
    // "one JSON object", matching WebSubAgent); a stderr copy keeps the
    // `[receipt] AGENTCHAT_RUN` grep uniform across skills.
    const exit = successful.length > 0 ? 0 : 2;
    const receipt = emitReceipt({
        skillDir: __dirname,
        skill: 'AgentChat-Consensus',
        runId: makeRunId(),
        fields: {
            exit,
            providers_asked: providers,
            providers_successful: successful.map(a => a.provider),
            agreement_score: scored.agreement_score,
            verdict: scored.verdict,
            elapsed_ms: Date.now() - T0,
        },
        stream: 'stderr',
    });

    console.log(JSON.stringify({
        mode: 'consensus',
        providers,
        successful: successful.length,
        failed: answers.length - successful.length,
        answers,
        ...scored,
        failures: answers.filter(a => !a.ok).map(a => ({ provider: a.provider, reason: a.reason })),
        elapsed_ms: Date.now() - T0,
        receipt,
    }, null, 2));

    process.exitCode = exit;
}

if (require.main === module) {
    main().catch(e => {
        process.stderr.write(`[consensus] CRITICAL: ${e.message}\n`);
        process.exit(4);
    });
}

module.exports = { scoreConsensus, similarity, normalizeText, DEFAULT_PROVIDERS, verdictFor };
