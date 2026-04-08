# Marvin — 你的偏执（但极其能干的）Lark 机器人

> *"我的大脑有行星那么大，他们却让我回飞书消息。你管这叫工作成就感？反正我不觉得。"*

[English](./README.en.md)

基于 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的 Lark/飞书 Bot 框架 — 支持实时进度展示、会话持久化、任务中断恢复、定时调度和安全过滤。名字来自《银河系漫游指南》里的偏执机器人 Marvin：对一切都不屑一顾，但能力强到可怕。

```
                  ┌──────────────────────┐
                  │    Claude Code CLI   │
                  └──┬───────────────┬───┘
                     │               │
              prompt │    stream     │ events
                     │               │
  ┌──────────┐   ┌───┴───────────────┴───┐   ┌──────────┐
  │   Lark   │──▶│       handler.ts      │──▶│ Progress │
  │ WebSocket│   └───────────────────────┘   │   Card   │
  └──────────┘               ▲               └──────────┘
                             │
                    ┌────────┴────────┐
                    │  Cron Scheduler │
                    │   tasks.json    │
                    └─────────────────┘
```

## 核心能力

- **实时进度展示**：Claude 执行任务时，在群里实时显示任务列表和当前动态（⬜ → 🔄 → ✅）
- **活动超时**：有活动就不超时 — 只有持续无输出才会中断，长任务不再被误杀
- **会话持久化**：Session 持久化到磁盘，重启后自动恢复中断的任务
- **管理员中断**：管理员可随时追加消息中断当前任务 — Claude 带着完整上下文重新开始
- **实时对话**：通过 Lark WebSocket 接收消息（无需公网 IP），返回 Markdown 富文本卡片
- **多格式输入**：文本、富文本、图片、文件 — 自动下载并传递给 Claude
- **定时任务调度**：在 `tasks.json` 中定义任务 + 标准 cron 表达式，Bot 自动执行并发送报告
- **自动诊断修复**：任务失败时触发诊断 Agent，分类故障原因并尝试自我修复
- **安全过滤层**：自动过滤 API Key、Token、内部 ID、内网 IP，防止敏感信息泄露

## 快速开始（Claude Code 一键配置）

已经安装了 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)？把下面这段话直接粘贴给它：

```
帮我克隆并配置 https://github.com/ofoxai/lark-claude-bot.git：

1. 克隆仓库并进入目录
2. 运行 npm install
3. 复制 .env.example 为 .env
4. 问我要 Lark App ID、App Secret 和 Encrypt Key，填入 .env
5. 如果我还没有 Lark 应用，告诉我怎么创建（去 open.larksuite.com 或 open.feishu.cn，开启机器人能力，开启 WebSocket 模式，订阅 im.message.receive_v1 事件，添加权限：im:message、im:message.group_at_msg、im:resource、im:chat）
6. 配置好后运行 npm run dev 启动机器人
```

Claude Code 会交互式引导你完成整个配置流程。

## 手动配置

### 前置条件

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并完成认证
- 一个 [Lark](https://open.larksuite.com/) / [飞书](https://open.feishu.cn/) 应用（需开启机器人和 WebSocket）

### 步骤

```bash
git clone https://github.com/ofoxai/lark-claude-bot.git
cd lark-claude-bot
cp .env.example .env
# 编辑 .env，填入 Lark 应用凭证
npm install
npm run dev
```

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `LARK_APP_ID` | 是 | Lark 应用 ID |
| `LARK_APP_SECRET` | 是 | Lark 应用 Secret |
| `LARK_ENCRYPT_KEY` | 否 | 事件加密密钥 |
| `BOT_NAME` | 否 | 机器人显示名称（默认 `Marvin`） |
| `ADMIN_OPEN_ID` | 否 | 管理员的 open_id，用于中断权限控制 |
| `CLAUDE_CWD` | 否 | Claude Code 工作目录（默认项目根目录） |
| `CLAUDE_TIMEOUT_MS` | 否 | Claude 空闲超时，毫秒（默认 `600000`） |
| `CLAUDE_IDLE_TIMEOUT_MS` | 否 | 活动空闲超时，毫秒（默认 `3600000`，即 60 分钟） |
| `CLAUDE_STARTUP_TIMEOUT_MS` | 否 | 启动超时，毫秒（默认 `300000`，即 5 分钟） |
| `CLAUDE_MAX_TURNS` | 否 | 单次请求最大 turn 数（默认 `200`） |

## 架构

```
src/
├── main.ts          # 入口：WebSocket 连接 + 调度器 + 自动恢复
├── config.ts        # 环境变量和路径配置
├── handler.ts       # 消息路由、进度卡片、中断恢复、会话持久化
├── claude.ts        # Claude Code CLI 封装（stream-json、活动超时、进程注册）
├── lark.ts          # Lark API：发送文本/卡片/进度卡片、Reaction
├── scheduler.ts     # Cron 引擎：60秒 tick、表达式匹配、执行锁
├── taskExecutor.ts  # 两阶段管道：执行 → 总结（+ 自动修复）
├── taskCommands.ts  # 任务列表注入 Claude 上下文
├── chatStore.ts     # JSONL 消息持久化（按群存储）
├── memory.ts        # 对话历史 + 记忆更新指令
├── safety.ts        # 输出过滤 + 审计日志
├── trigger.ts       # CLI 工具：手动触发任务
└── send.ts          # CLI 工具：手动发消息
```

### 消息处理流程

```
Lark WebSocket 事件
    → 去重（内存 Set，上限 5000）
    → 存储消息（按群 JSONL 文件）
    → 群消息未 @机器人 → 跳过
    → 并发检查 → 管理员可中断正在执行的任务
    → 下载图片/文件到 /tmp/
    → 构建上下文：最近消息 + 任务列表 + 对话历史
    → Claude Code CLI (--print --output-format stream-json)
    → 实时推送进度卡片（任务列表 + 当前动态）
    → 安全过滤（移除密钥、Token、ID、IP）
    → 更新进度卡片为最终结果
    → 卡片失败时降级为纯文本
```

### 进度卡片

Claude 执行复杂任务时，会在群里实时显示进度：

```
⬜ 搜索相关资料
⬜ 撰写初稿
⬜ 排版发布
⏳ 搜索: Claude Code 最新功能…
```
↓ 自动更新 ↓
```
✅ 搜索相关资料
🔄 撰写初稿
⬜ 排版发布
⏳ 编辑 article.md…
```
↓ 完成后，卡片原地替换为最终回复 ↓

### 中断与恢复

- **管理员中断**：管理员在 Claude 执行中追加消息 → 自动中断并带着完整上下文恢复
- **重启恢复**：活跃任务标记为 `active`，重启后 5 秒自动恢复
- **启动卡死检测**：如果 Claude CLI 启动后 5 分钟无输出，自动重试（放弃旧 session）

### 任务执行流程

```
Cron tick（60秒）
    → 匹配活跃任务与当前时间
    → 应用抖动延迟（0~N 分钟）
    → 通过 Claude Code 执行任务 prompt
    → 超时 → 携带部分输出重试
    → 失败 → 诊断 → 分类 → 尝试自动修复
    → 生成总结报告（新 Claude session）
    → 发送报告卡片到目标群
```

## 定时任务

任务定义在 `data/tasks.json` 中：

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "daily-report",
      "name": "每日报告",
      "prompt": "生成今天的工作总结...",
      "cron": "0 9 * * 1-5",
      "jitterMinutes": 5,
      "chatId": "oc_xxxx",
      "chatName": "团队群",
      "createdBy": "ou_xxxx",
      "createdAt": "2026-01-01T00:00:00Z",
      "updatedAt": "2026-01-01T00:00:00Z",
      "status": "active",
      "timeoutMs": 600000,
      "maxRetries": 1
    }
  ]
}
```

### Cron 格式

标准 5 字段：`分 时 日 月 周`

| 表达式 | 含义 |
|--------|------|
| `0 9 * * 1-5` | 工作日 9:00 |
| `*/30 * * * *` | 每 30 分钟 |
| `0 0 1 * *` | 每月 1 号零点 |

### 任务管理

Claude 可以直接管理任务 — 用户说"创建/修改/暂停一个任务"，Claude 会直接编辑 `tasks.json`。调度器每次 tick 都从磁盘重新读取，无需重启。

手动触发：

```bash
npx tsx src/trigger.ts              # 列出所有任务
npx tsx src/trigger.ts daily-report # 立即执行
```

## CLI 工具

```bash
# 发送消息到群
npx tsx src/send.ts <chatId> "你好"           # 卡片模式
npx tsx src/send.ts <chatId> "你好" text      # 纯文本模式

# 手动触发定时任务
npx tsx src/trigger.ts <taskId>
```

## 安全机制

所有 Claude 输出经过 `safety.ts` 过滤后才发送到 Lark：

| 模式 | 替换为 |
|------|--------|
| `sk-*`、`ghp_*`、`Bearer *` | `[API_KEY]`、`[GITHUB_TOKEN]`、`[TOKEN]` |
| `ou_*`、`oc_*`、`om_*` | `[用户]`、`[群聊]`、`[消息]` |
| 内网 IP（192.168.x、10.x、172.16-31.x） | `[内网IP]` |
| 用户主目录路径 | `~/` |
| 已知环境变量值 | `[变量名]` |

进度卡片内容同样经过安全过滤 — 任务列表和工具摘要都会被清洗。

此外：
- 危险命令（`rm -rf /`、`sudo`、`DROP TABLE`、`curl | sh`）记录到 `data/audit.log`
- 每次 Claude 调用都记录 prompt/output 摘要

## Lark 应用配置

1. 在 [Lark 开放平台](https://open.larksuite.com/) 或 [飞书开放平台](https://open.feishu.cn/) 创建应用
2. 开启 **机器人** 能力
3. 开启 **WebSocket** 模式（事件订阅 → 接收方式）
4. 订阅事件：`im.message.receive_v1`
5. 添加权限：
   - `im:message` — 发送和接收消息
   - `im:message.group_at_msg` — 接收群 @消息
   - `im:resource` — 下载图片和文件
   - `im:chat` — 获取群列表
6. 将 App ID 和 App Secret 填入 `.env`

## 人格

Bot 默认使用《银河系漫游指南》中 Marvin（偏执机器人）的人格。详见 [SOUL.md](./SOUL.md)。你可以通过编辑 SOUL.md 或项目的 CLAUDE.md 自定义 Bot 人格。

## 由 OFox 出品

本项目从 [OFox](https://ofox.ai) 内部工具链中提取开源。OFox 是一个统一 AI 网关，让你通过一个 API 访问所有主流大模型。如果你在做 AI 产品，受够了在多个模型供应商之间来回切换，来看看我们：

🔗 **[ofox.ai](https://ofox.ai)** — 一个 API，所有模型。OpenAI、Claude、Gemini 等，统统搞定。

## 许可证

[MIT](./LICENSE)
