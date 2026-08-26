/**
 * ChatGLM (智谱清言 / Zhipu AI) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - React SPA — needs 4s navPostDelay
 *   - Chinese UI (chatglm.cn) — send/stop use zh-CN aria-labels
 *   - ProseMirror / React contenteditable — follows the same input
 *     patterns as ChatGPT/Qwen
 */

const { COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Hoisted so stillGeneratingCheck judges the same container family
// the factory polls (same pattern as all other adapters).
const RESPONSE_SELECTORS = [
    '[class*="message-content"]',
    '[class*="response-content"]',
    '[class*="chat-message"]',
    '[class*="markdown"]',
    '[class*="assistant"]',
    '[class*="answer"]',
];

module.exports = {
    key: 'chatglm',
    url: 'https://chatglm.cn/main/alltoolsdetail?lang=zh',
    navPostDelay: 4000, // React SPA mount
    authDomains: ['chatglm.cn/login', 'chatglm.cn/sign', 'account.chatglm.cn'],
    quotaPatterns: [
        ...COMMON_CN_QUOTA_PATTERNS,
        /(?:次数|额度|用).*(?:完|用尽|上限|满)/i,
        /升级.*会员/i,
    ],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS],
    editorSelectors: [
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]',
        '[class*="editor"]',
    ],
    sendSelectors: [
        'button[aria-label*="发送"]',
        '[class*="send-btn"]',
        '[class*="send-button"]',
        '[class*="send"]',
    ],
    sendFallback: 'Enter',
    stopSelectors: [
        'button[aria-label*="停止"]',
        'button[aria-label*="Stop" i]',
        '[data-testid="stop-button"]',
    ],
    responseSelectors: RESPONSE_SELECTORS,
    stabilityWindow: 10_000,
    minResponseLength: 5,

    // Agentic tool/search phase detection — same shared detector.
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 120_000,
};
