# lark-claude-bot

Turn [Claude Code](https://docs.anthropic.com/en/docs/claude-code) into a Lark/Feishu team assistant — with cron scheduling, multi-turn sessions, and built-in safety filters.

```
Lark message → WebSocket → Claude Code CLI → Lark card reply
                              ↕
                        Cron scheduler
                     (autonomous tasks)
```

## What it does

- **Real-time chat**: Receives messages via Lark WebSocket (no public IP required), processes them with Claude Code, responds with rich Markdown cards
- **Multi-format input**: Text, rich text (post), images, and files — all automatically downloaded and passed to Claude
- **Session continuity**: Maintains Claude Code sessions per chat (30-min TTL) for multi-turn conversations
- **Cron task scheduler**: Define tasks in `tasks.json` with standard cron expressions — the bot executes them autonomously and posts structured reports
- **Auto-diagnosis**: Failed tasks trigger a diagnostic agent that classifies failures and attempts self-repair
- **Safety layer**: Filters API keys, tokens, internal IDs, and private IPs from all output before sending

## Quick Start

### Prerequisites

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A [Lark](https://open.larksuite.com/) / [Feishu](https://open.feishu.cn/) app with Bot and WebSocket capabilities

### Setup

```bash
git clone https://github.com/ofoxai/lark-claude-bot.git
cd lark-claude-bot
cp .env.example .env
# Edit .env with your Lark app credentials
npm install
npm run dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LARK_APP_ID` | Yes | Lark app ID |
| `LARK_APP_SECRET` | Yes | Lark app secret |
| `LARK_ENCRYPT_KEY` | No | Event encryption key |
| `BOT_NAME` | No | Bot display name (default: `Marvin`) |
| `CLAUDE_CWD` | No | Working directory for Claude Code (default: project root) |
| `CLAUDE_TIMEOUT_MS` | No | Claude execution timeout in ms (default: `600000`) |
| `CLAUDE_MAX_TURNS` | No | Max Claude turns per request (default: `200`) |

## Architecture

```
src/
├── main.ts          # Entry: WebSocket + scheduler startup
├── config.ts        # Environment and path configuration
├── handler.ts       # Message routing and context assembly
├── claude.ts        # Claude Code CLI wrapper (spawn, parse, retry)
├── lark.ts          # Lark API: send text/card/image/file, reactions
├── scheduler.ts     # Cron engine: 60s tick, expression matching, locks
├── taskExecutor.ts  # Two-phase pipeline: execute → summarize (+ auto-fix)
├── taskCommands.ts  # Injects task list into Claude's context
├── chatStore.ts     # JSONL message persistence per chat
├── memory.ts        # Dialog history + memory update prompts
├── safety.ts        # Output sanitization + audit logging
├── trigger.ts       # CLI: manually trigger a task
└── send.ts          # CLI: manually send a message
```

### Message Flow

```
Lark WebSocket event
    → Deduplication (in-memory Set, max 5000)
    → Store message (JSONL per chat)
    → Skip if group message without @bot mention
    → Download images/files to /tmp/
    → Build context: recent messages + task list + dialog history
    → Claude Code CLI (--print --output-format json)
    → Safety filter (remove keys, tokens, IDs, IPs)
    → Send Lark card (auto-segmented, max 3500 chars/card)
    → Fallback to plain text on card failure
```

### Task Execution Flow

```
Cron tick (60s)
    → Match active tasks against current time
    → Apply jitter delay (0~N minutes)
    → Execute task prompt via Claude Code
    → On timeout: retry with partial output context
    → On failure: diagnose → classify → attempt auto-fix
    → Generate summary report (new Claude session)
    → Send report card to configured chat
```

## Scheduled Tasks

Tasks are defined in `data/tasks.json`:

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "daily-report",
      "name": "Daily Report",
      "prompt": "Generate a summary of today's activities...",
      "cron": "0 9 * * 1-5",
      "jitterMinutes": 5,
      "chatId": "oc_xxxx",
      "chatName": "Team Chat",
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

### Cron Format

Standard 5-field: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|-----------|---------|
| `0 9 * * 1-5` | 9:00 AM, weekdays |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 1 * *` | Midnight, 1st of month |

### Task Management

Tasks can be managed by Claude itself — when a user asks to create, modify, or pause a task, Claude edits `tasks.json` directly. The scheduler hot-reloads from disk every tick.

You can also trigger tasks manually:

```bash
npx tsx src/trigger.ts              # List all tasks
npx tsx src/trigger.ts daily-report # Run immediately
```

## CLI Tools

```bash
# Send a message to a chat
npx tsx src/send.ts <chatId> "Hello world"           # Card mode
npx tsx src/send.ts <chatId> "Hello world" text      # Plain text

# Trigger a scheduled task
npx tsx src/trigger.ts <taskId>
```

## Safety

All Claude output passes through `safety.ts` before reaching Lark:

| Pattern | Replacement |
|---------|-------------|
| `sk-*`, `ghp_*`, `Bearer *` | `[API_KEY]`, `[GITHUB_TOKEN]`, `[TOKEN]` |
| `ou_*`, `oc_*`, `om_*` | `[用户]`, `[群聊]`, `[消息]` |
| Private IPs (192.168.x, 10.x, 172.16-31.x) | `[内网IP]` |
| Home directory paths | `~/` |
| Known env var values | `[VAR_NAME]` |

Additionally:
- Dangerous commands (`rm -rf /`, `sudo`, `DROP TABLE`, `curl | sh`) are flagged in `data/audit.log`
- All Claude calls are logged with prompt/output summaries

## Lark App Configuration

1. Create an app at [Lark Open Platform](https://open.larksuite.com/) or [Feishu Open Platform](https://open.feishu.cn/)
2. Enable **Bot** capability
3. Enable **WebSocket** mode (under Event Subscriptions)
4. Subscribe to event: `im.message.receive_v1`
5. Add required scopes:
   - `im:message` — Send and receive messages
   - `im:message.group_at_msg` — Receive group @mentions
   - `im:resource` — Download images and files
   - `im:chat` — List chats
6. Copy App ID and App Secret to `.env`

## Personality

The bot ships with a default personality inspired by Marvin from *The Hitchhiker's Guide to the Galaxy*. See [SOUL.md](./SOUL.md) for details. You can customize the persona by editing SOUL.md or your project's CLAUDE.md.

## License

[MIT](./LICENSE)
