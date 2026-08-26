# AgentChat Preset — Setup Script (Windows)
# Run this once after selecting the AgentChat preset in DSH.
# Installs Node dependencies and checks the environment.

$ErrorActionPreference = "Stop"
$PresetDir = Join-Path $env:USERPROFILE ".dsh\.agent-presets\agentchat"
$SkillDir  = Join-Path $PresetDir "skills\agentchat"
$OneWebPkg = Join-Path $SkillDir "AgentChat-OneWeb"

Write-Host "=== AgentChat Preset Setup ===" -ForegroundColor Cyan
Write-Host ""

# --- Node.js check ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org/" -ForegroundColor Red
    exit 1
}
$nodeVer = & node --version
Write-Host "OK  Node.js: $nodeVer" -ForegroundColor Green

# --- npm install for AgentChat-OneWeb (the only skill with a package.json;
#     IndependentTasks/WebSubAgent spawn OneWeb as a subprocess instead) ---
if (Test-Path (Join-Path $OneWebPkg "package.json")) {
    if (-not (Test-Path (Join-Path $OneWebPkg "node_modules"))) {
        Write-Host ""
        Write-Host "Installing npm dependencies in AgentChat-OneWeb..." -ForegroundColor Yellow
        Push-Location $OneWebPkg
        npm install --omit=dev
        Pop-Location
        Write-Host "OK  npm dependencies installed" -ForegroundColor Green
    } else {
        Write-Host "OK  npm dependencies present (AgentChat-OneWeb)" -ForegroundColor Green
    }
}

# --- Python check ---
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pyCmd) {
    $pyVer = & python --version 2>&1
    Write-Host "OK  Python: $pyVer" -ForegroundColor Green
} else {
    Write-Host "WARN  Python not found. Some features (OCR, PDF) need Python 3.8+" -ForegroundColor Yellow
}

# --- Chrome check ---
$chromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)
$chromeExe = $null
foreach ($p in $chromePaths) {
    if (Test-Path $p) { $chromeExe = $p; break }
}
if ($chromeExe) {
    Write-Host "OK  Chrome: $chromeExe" -ForegroundColor Green
} else {
    Write-Host "WARN  Chrome not found in standard paths. Install Chrome." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Set AGENTCHAT_SKILL_DIR env var:" -ForegroundColor White
Write-Host "     [Environment]::SetEnvironmentVariable('AGENTCHAT_SKILL_DIR', '$SkillDir', 'User')" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. Configure Chrome path (the code reads CHROMIUM_PATH, not CHROME_BIN):" -ForegroundColor White
if ($chromeExe) {
    Write-Host "     [Environment]::SetEnvironmentVariable('CHROMIUM_PATH', '$chromeExe', 'User')" -ForegroundColor Gray
} else {
    Write-Host "     [Environment]::SetEnvironmentVariable('CHROMIUM_PATH', 'C:\path\to\chrome.exe', 'User')" -ForegroundColor Gray
}
Write-Host ""
Write-Host "  3. Start Chrome with debug port (run once; keep the window open):" -ForegroundColor White
if ($chromeExe) {
    $chromeProfile = "$env:USERPROFILE\.chrome-debug-profile"
    Write-Host "     Start-Process `"$chromeExe`" -ArgumentList '--remote-debugging-port=9222','--user-data-dir=`"$chromeProfile`"'" -ForegroundColor Gray
}
Write-Host ""
Write-Host "  4. Login to AI services in the Chrome profile above:" -ForegroundColor White
Write-Host "     - Gemini:    https://gemini.google.com" -ForegroundColor Gray
Write-Host "     - ChatGPT:   https://chatgpt.com"         -ForegroundColor Gray
Write-Host "     - Claude:    https://claude.ai"           -ForegroundColor Gray
Write-Host "     - Qwen:      https://www.qianwen.com"     -ForegroundColor Gray
Write-Host "     - Kimi:      https://kimi.moonshot.cn"    -ForegroundColor Gray
Write-Host "     - DeepSeek:  https://chat.deepseek.com"   -ForegroundColor Gray
Write-Host ""
Write-Host "  5. Verify with smoke test:" -ForegroundColor White
Write-Host "     node `"$SkillDir\AgentChat-OneWeb\index.js`" --smoke" -ForegroundColor Gray
Write-Host ""
Write-Host "  NOTE: env vars set here apply to NEW processes. Restart DSH so the" -ForegroundColor Yellow
Write-Host "  agent's shell sees AGENTCHAT_SKILL_DIR / CHROMIUM_PATH." -ForegroundColor Yellow
