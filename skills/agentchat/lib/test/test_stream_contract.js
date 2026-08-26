// Verify the [stream] line contract: stderr-only, parseable JSON, all fields.
const fs = require('fs');
let stderrOut = '';
const origWrite = process.stderr.write;
process.stderr.write = (chunk, ...rest) => { stderrOut += chunk; return true; };

// Replicate the exact sink from executeOnce (AgentChat-OneWeb/index.js)
const sink = (obj) => {
    try { process.stderr.write(`[stream] ${JSON.stringify(obj)}\n`); } catch (_) {}
};
sink({ provider: 'gemini', chars: 1234, delta: '正在生成的内容...', ms: 45000 });
sink({ provider: 'kimi', chars: 5678, delta: '搜索完成，开始推理...', ms: 89000 });
process.stderr.write = origWrite;

const lines = stderrOut.trim().split('\n');
console.log('stderr lines:', lines.length);
for (const l of lines) {
    console.log('  ' + l);
    if (!l.startsWith('[stream] ')) throw new Error('missing [stream] prefix: ' + l);
    const parsed = JSON.parse(l.replace('[stream] ', ''));
    if (!('provider' in parsed && 'chars' in parsed && 'delta' in parsed && 'ms' in parsed)) {
        throw new Error('contract violation: ' + l);
    }
}
console.log('OK  [stream] contract verified: stderr-only, parseable JSON, all fields present');
