/**
 * Doubao (豆包) provider adapter config — ByteDance AI chat.
 *
 * Key differences from standard pipeline:
 *   - React SPA — needs 4s navPostDelay
 *   - Chinese UI (send/stop buttons use aria-label 发送/停止)
 *   - Agentic product with tool/search phases → stillWorkingCheck
 */

const { COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Hoisted so the still-working probe judges the same container family the
// factory polls (same pattern as kimi/minimax/mimo adapters).
//
// Doubao uses CSS Modules with hash suffixes (e.g. message-list-zLoNs1,
// flow-ext-disable-selec).  Prefix-based [class*="…"] selectors survive
// hash rotation across builds.
const RESPONSE_SELECTORS = [
    '[class*="message-list"]',                  // primary: chat message list (CSS Module hash: message-list-zLoNs1)
    '[class*="flow-ext-disable"]',              // main chat content area
    '[class*="markdown"]',
    '[class*="message-content"]',
    '[class*="response"]',
    '[class*="answer"]',
    '[class*="chat-message"]',
    '[class*="assistant"]',
];

module.exports = {
    key: 'doubao',
    url: 'https://www.doubao.com/chat/',
    navPostDelay: 4000, // React SPA mount
    authDomains: ['doubao.com/login', 'www.doubao.com/login', 'passport.doubao.com'],
    quotaPatterns: [
        ...COMMON_CN_QUOTA_PATTERNS,
        /(?:额度|次数).*(?:已|用).*(?:完|尽)/i,
        /升级.*会员/i,
        /免费.*额度.*(?:已|用).*(?:完|尽)/i,
    ],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS],
    editorSelectors: [
        'textarea[placeholder*="输入"]',
        'textarea[placeholder*="消息"]',
        'textarea',                               // generic fallback
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[class*="editor"]',
    ],
    sendSelectors: [
        'button[aria-label*="发送"]',
        '[class*="send-btn"]',
        '[class*="send"]',
    ],
    sendFallback: 'Enter',
    // Stop button: Chinese AI UIs show ■ (square) during generation.
    // Adapter-specific variants first, generic CSS4 `i` fallback for resilience.
    stopSelectors: [
        'button[aria-label*="停止"]',
        'button[aria-label*="Stop" i]',
        '[data-testid="stop-button"]',
    ],
    responseSelectors: RESPONSE_SELECTORS,
    stabilityWindow: 10_000,
    minResponseLength: 5,

    // Agentic tool/search phase detection — same pattern as MiniMax/MiMo/Kimi.
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 120_000,
};
