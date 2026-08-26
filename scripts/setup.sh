#!/usr/bin/env bash
# AgentChat Preset Setup Script
# Run this once after activating the AgentChat preset in DSH.
# Checks and installs required dependencies.
#
# NOTE: this preset's skills live under <preset>/skills/agentchat/. The scripts
# resolve their own location at runtime (path.dirname(__filename)), so no env
# var is required for the skills themselves; AGENTCHAT_SKILL_DIR is only a
# convenience for manual invocation. CHROMIUM_PATH must point at a system
# Chrome binary for the CDP bridge to work.

set -euo pipefail

# Resolve the skill root relative to this script: <preset>/skills/agentchat
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${AGENTCHAT_SKILL_DIR:-$(cd "$SCRIPT_DIR/../skills/agentchat" && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

echo "=== AgentChat Preset Environment Check ==="
echo "  SKILL_DIR: $SKILL_DIR"

# 1. Node.js
if ! command -v "$NODE_BIN" &>/dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org/"
  exit 1
fi
NODE_VER=$("$NODE_BIN" --version)
echo "✅ Node.js: $NODE_VER"

# 2. Python
if ! command -v "$PYTHON_BIN" &>/dev/null; then
  echo "❌ Python 3 not found. Install Python 3.8+."
  exit 1
fi
PY_VER=$("$PYTHON_BIN" --version 2>&1)
echo "✅ Python: $PY_VER"

# 3. Chrome
CHROME_PATH=""
if [[ "$(uname)" == "Linux" ]]; then
  CHROME_PATH=$(which google-chrome-stable 2>/dev/null || which chrome 2>/dev/null || echo "")
elif [[ "$(uname)" == "Darwin" ]]; then
  CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  [[ -x "$CHROME_PATH" ]] || CHROME_PATH=""
elif [[ "$(uname)" == "MINGW"* ]] || [[ "$(uname)" == "MSYS"* ]] || [[ "$(uname)" == "CYGWIN"* ]]; then
  # Windows
  if [[ -f "C:/Program Files/Google/Chrome/Application/chrome.exe" ]]; then
    CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"
  elif [[ -f "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe" ]]; then
    CHROME_PATH="$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"
  fi
fi

if [[ -z "$CHROME_PATH" ]]; then
  echo "⚠️  Chrome not found in standard paths. Set CHROMIUM_PATH in .env or install Chrome."
else
  echo "✅ Chrome: $CHROME_PATH"
fi

# 4. npm dependencies (playwright-core) — only AgentChat-OneWeb needs them
ONEWEB_PKG="$SKILL_DIR/AgentChat-OneWeb/package.json"
if [[ -f "$ONEWEB_PKG" ]]; then
  if [[ ! -d "$SKILL_DIR/AgentChat-OneWeb/node_modules" ]]; then
    echo "📦 Installing npm dependencies..."
    (cd "$SKILL_DIR/AgentChat-OneWeb" && npm install --omit=dev 2>&1 | tail -3)
    echo "✅ npm dependencies installed"
  else
    echo "✅ npm dependencies present"
  fi
fi

# 5. Python dependencies (playwright + websocket-client)
if ! "$PYTHON_BIN" -c "import playwright" 2>/dev/null; then
  echo "📦 Installing Python dependencies (playwright, websocket-client)..."
  "$PYTHON_BIN" -m pip install playwright websocket-client -q
  echo "✅ Python dependencies installed"
else
  echo "✅ Python dependencies present"
fi

echo ""
echo "=== Setup complete ==="
echo "Next step: Open Chrome with debug port:"
echo "  $CHROME_PATH --remote-debugging-port=9222 --user-data-dir=\"${CHROME_PROFILE:-$HOME/.chrome-debug-profile}\""
echo ""
echo "Then login to AI services in that Chrome profile:"
echo "  Gemini:   https://gemini.google.com"
echo "  ChatGPT:  https://chatgpt.com"
echo "  Claude:   https://claude.ai"
echo "  Qwen:     https://www.qianwen.com"
echo "  Kimi:     https://kimi.moonshot.cn"
echo "  DeepSeek: https://chat.deepseek.com"
