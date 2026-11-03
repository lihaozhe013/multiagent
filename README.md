# Night-Shift Orchestrator

> **严格串行多 Agent CLI 编排系统** —— 专为闲置无头主机（Headless PC）与家庭服务器打造的夜间无人值守 "Vibe Coding" 伴侣。

---

## 🌟 核心理念与特性

1. **严格单任务串行 (Strict Serial Execution)**
   - 杜绝并发带来的内存爆仓与 CPU 占满，零 Git Worktree 分支并发冲突。
   - 充分利用夜间低峰期 6-8 小时，单进程干净执行，以时间换取极致稳定性。
2. **宏观 Vibe Coding 与零人工介入 (Zero Human-in-the-Loop)**
   - 彻底关闭交互式打扰（无 `ask_user`，`pi` 预信任 `--no-approve`，`opencode` 全自动 `--auto`）。
   - 进程树看门狗（Watchdog）：阶段物理超时强制退出并回收资源，无僵尸进程。
3. **多 Agent CLI 可插拔兼容层 (Pluggable Adapter Layer)**
   - 原生支持 **`pi` CLI** 与 **`opencode` CLI**，易于扩展更多 CLI（Claude Code, Aider, Codex CLI 等）。
   - 统一输出流解析（思考流、工具调用、文件变更、命令输出归一化）。
4. **受控循环流水线 (Looping Pipeline Engine)**
   - 单任务内嵌微闭环：`[Coder Agent]` $\rightarrow$ `[Test Gate]` $\rightarrow$ `[Review Agent]`。
   - 测试失败或代码审查不通过时，自动提取报错与评审意见组装反馈，触发打回重试（默认上限 3 次）。
   - 全部通过后自动执行标准化 Conventional Commit。
5. **Task Manager Agent 任务规划与批量分解 (Nightly Intake)**
   - 睡前粘贴一段自然语言或 Markdown 待办清单（支持 `- [ ]`、`##`、`(verify: cmd)`、`[agent: opencode]` 标记）。
   - 自动拆解并按序入库，一键启动整夜自动化流水线。
6. **现代化 WebUI 看板与实时控制台**
   - 技术栈：**React 19 + Vite + Tailwind CSS + Lucide Icons + Hono (Bun)**。
   - 具备任务状态看板、阶段状态实时追踪、Server-Sent Events (SSE) 终端日志流。

---

## 🏗️ 架构拓扑

```
[ WebUI Dashboard / React 19 ]
              │ HTTP REST / SSE (/api/stream)
[ Hono Server on Bun ]
              │
[ QueueController (bun:sqlite WAL, atomic claim lock) ]
              │
[ PipelineRunner (Loop: Coder -> Test Gate -> Review Agent) ]
              │
    ┌─────────┴─────────┐
    ▼                   ▼
[ PiAdapter ]     [ OpenCodeAdapter ]
(pi --mode json)  (opencode run --auto)
```

---

## 🚀 快速启动

### 依赖环境
* [Bun](https://bun.sh/) (v1.2+)
* `pi` CLI (可选，已安装于 `~/.bun/bin/pi`)
* `opencode` CLI (可选，已安装于 `~/.bun/bin/opencode`)

### 安装与构建
```bash
# 安装依赖
bun install

# 构建 WebUI 前端静态资源
bun run build
```

### 启动服务
```bash
# 启动夜间编排服务 (默认端口 4000)
bun start

# 或开发模式 (前端 Vite 实时热重载 + 后端热重载)
bun run dev:ui       # http://localhost:3000 (代理 API 到 4000)
bun run dev:server   # http://localhost:4000
```

打开浏览器访问 **`http://localhost:4000`**，即可使用完整的 Night-Shift 仪表盘。

---

## 🧪 自动化测试与代码规范

本项目使用 **TypeScript 7** 与 **oxlint**，遵循 **ESNext** 标准：

```bash
# 运行全部单元与集成测试 (覆盖 SQLite、队列、CLI 适配器、循环流水线、REST API)
bun test

# 运行 Oxlint 代码检查
bun run lint

# 运行 TypeScript 7 类型检查
bun run typecheck
```

---

## 📝 睡前待办清单示例 (Nightly Intake Format)

在 Web 界面点击 **Nightly Intake** 按钮，直接粘贴如下格式的待办大纲：

```markdown
# Nightly Sprint 2026-11-03
- [ ] 重构认证 Token 刷新模块 (verify: bun test; npm run lint)
- [ ] 增加暗色模式与系统自适应主题 [agent: opencode] (test: bun run build)
  确保在 tailwindcss 中正确配置 prefers-color-scheme。
## 3. 清理数据库无用索引与冗余日志
  检查 store.ts 中的 schema，优化 WAL 检查点设置。
```

点击 **Decompose & Enqueue Batch**，系统会自动将清单解析为结构化 Tasks 并存入队列，夜间逐个串行执行并闭环验证。

---

## Dify Local Bridge

An additive Dify trigger + IM delivery bridge lives under `src/bridge/`. It does
not change the existing Night-Shift queue or dashboard. See
[`docs/dify-bridge-usage.md`](docs/dify-bridge-usage.md) for configuration, the
mock end-to-end test, and Dify/Feishu setup notes.
