# AgentChat 预设 — 零成本浏览器 AI 并行编排

DSH Agent 预设，内置三套 AgentChat 技能：单 Provider 自动降级、多任务并行派发、串行深度管道。

## 快速开始

### 1. 激活预设

在 DSH Web GUI 新建会话时，从预设选择器中选择 **AgentChat**。

### 2. 首次安装依赖

运行预设目录下的安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\.agent-presets\agentchat\scripts\setup.ps1"
```

### 3. 启动 Chrome 调试模式

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:USERPROFILE\.chrome-debug-profile"
```

> Windows 用户注意：首次使用时需在 Chrome 中登录各 AI 服务（见下方登录清单）。

### 4. 配置环境变量（新进程生效，需重启 DSH）

```powershell
$skillDir = "$env:USERPROFILE\.dsh\.agent-presets\agentchat\skills\agentchat"
[Environment]::SetEnvironmentVariable("AGENTCHAT_SKILL_DIR", $skillDir, "User")

# Chrome 可执行文件路径（代码读取的是 CHROMIUM_PATH，不是 CHROME_BIN）
[Environment]::SetEnvironmentVariable("CHROMIUM_PATH", "C:\Program Files\Google\Chrome\Application\chrome.exe", "User")
```

> ⚠️ 环境变量写入后**只对新启动的进程生效**。请重启 DSH，agent 的 shell 才能看到 `AGENTCHAT_SKILL_DIR` / `CHROMIUM_PATH`。不设置环境变量也不影响技能本身——agent 通过 persona 中固定的技能根目录调用脚本。

## 三个技能

| 技能 | 用途 | 触发词 |
|------|------|--------|
| **AgentChat-OneWeb** | 单 prompt → 8 Provider 自动降级 | "用 AI 回答"、"问任意模型" |
| **AgentChat-IndependentTasks** | N 任务 → 并行派发 → PDF 合成 | "并行问多个 AI"、"汇总成 PDF" |
| **AgentChat-WebSubAgent** | 6 步串行管道（搜索→推理→审查） | "深度分析"、"复杂工程任务" |

## 优化（v27）

- **Adapter 懒加载**：10 个 Provider adapter 改为按需加载，单 Provider 调用省去 ~90% 的模块加载（之前启动即全部 require）
- **Worker 进程池**：常驻 worker 复用 playwright-core 与 CDP 连接，每次 Provider 尝试省去 ~1.5s 的模块加载 + 连接握手（8 路并发 = 8 次省）；任何池故障自动回退到逐调用 spawn，零新故障类
- **流式增量通道**：长生成（Gemini Pro Extended 3-5 分钟）不再静默——生成过程中 stderr 实时输出 `[stream] {json}` 行（provider / chars / delta / ms，约每 3s 一条，stdout 保持机器契约纯净），调用方可实时感知进度；`--no-stream` 关闭
- 可通过环境变量控制（见 `.env.example`）：`AGENTCHAT_WORKER_POOL=0` 关闭、`AGENTCHAT_WORKER_POOL_SIZE` 调池大小

## 登录清单

在 Chrome 调试 profile 中登录以下服务（一次登录，长期有效）：

| AI | 地址 |
|----|------|
| Qwen | https://www.qianwen.com |
| Kimi | https://kimi.moonshot.cn |
| DeepSeek | https://chat.deepseek.com |
| MiniMax | https://agent.minimaxi.com |
| Gemini | https://gemini.google.com |
| ChatGPT | https://chatgpt.com |
| Claude | https://claude.ai |

## 文件结构

```
~/.dsh/.agent-presets/agentchat/
├── preset.yml              # 预设元数据
├── agent.cordis.yml        # Agent 组成配置
├── .env.example            # 环境配置模板（CHROMIUM_PATH 等）
├── scripts/
│   ├── setup.ps1           # Windows 安装脚本
│   └── setup.sh            # Linux/macOS 安装脚本
├── mcp-server/             # 可选 MCP 服务器（不进技能目录）
└── skills/agentchat/       # 技能扫描根（每个子目录 = 一个技能）
    ├── AgentChat-OneWeb/         # 8 Provider 降级链
    ├── AgentChat-IndependentTasks/ # 并行派发 + PDF
    ├── AgentChat-WebSubAgent/    # 6 步串行管道
    └── lib/                      # 共享库（CDP、错误处理、遥测）
```

## 故障排查

```powershell
# 检查 Chrome CDP 是否可用
curl http://127.0.0.1:9222/json/version

# 运行环境烟雾测试
node "$env:AGENTCHAT_SKILL_DIR\AgentChat-OneWeb\index.js" --smoke

# 查看日志
type "$env:TEMP\chrome-debug.log" 2>nul
```

## 注意事项

- 网页 AI 无法访问本地文件系统：涉及本地文件时，Agent 会先读取内容再发送
- 每个 Provider 有独立会话状态，不支持多轮对话
- 中国大陆用户需在 `.env` 中配置代理（`PROXY_SERVER`）
- 禁止使用 VLESS Reality 代理（与 Chrome BoringSSL 冲突）
- Windows 平台限制：`AgentChat-IndependentTasks` 的 PDF 合成（`md2pdf.sh`）是 bash 脚本，Windows 上需 Git Bash/WSL 或改用 pwsh 直接调用 `node` 管线；技能脚本本身为跨平台 Node.js
