/**
 * 任务执行器 — 两阶段管道 + 故障诊断
 *
 * 阶段 1: 执行任务（Claude Code session，可能很长）
 * 阶段 2: 新 session 总结执行日志 → 结构化卡片报告
 * 阶段 2.5: 如果失败 → 诊断 session 分析原因，尝试自我修复
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import { runClaude, type ClaudeResult } from "./claude.js";
import { sendCard, sendText } from "./lark.js";
import { sanitizeOutput, auditOutput, audit } from "./safety.js";
import {
  type ScheduledTask,
  acquireLock,
  releaseLock,
  updateTaskLastRun,
} from "./scheduler.js";

mkdirSync(config.taskLogsDir, { recursive: true });

// ==================== 日志保存 ====================

function saveTaskLog(taskId: string, output: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${taskId}_${ts}.log`;
  const filepath = join(config.taskLogsDir, filename);
  writeFileSync(filepath, output, "utf-8");
  return filepath;
}

// ==================== 失败检测 ====================

function isTaskFailed(result: ClaudeResult): boolean {
  const { output } = result;

  // 空输出 = 失败（无论原因）
  if (!output.trim()) return true;

  // 明确的失败标记
  const failPatterns = [
    /(?:error|failed|exception|traceback)/i,
    /❌/,
    /command not found/i,
    /permission denied/i,
    /ENOENT|EACCES/,
  ];
  const hasFailure = failPatterns.some((p) => p.test(output));
  const hasSuccess = /✅|successfully|completed|done/i.test(output);
  return hasFailure && !hasSuccess;
}

// ==================== 总结 prompt ====================

function buildSummarizePrompt(
  task: ScheduledTask,
  execResult: ClaudeResult,
  durationMs: number,
  diagnosis?: string
): string {
  const truncatedLog =
    execResult.output.length > 100_000
      ? execResult.output.slice(0, 50_000) +
        "\n\n[... 日志过长，已截断 ...]\n\n" +
        execResult.output.slice(-50_000)
      : execResult.output;

  const diagSection = diagnosis
    ? `\n\n## 诊断信息\n${diagnosis}`
    : "";

  return `你是报告生成器。阅读执行日志，按固定格式输出中文报告。

## 严格规则
1. 只输出报告正文，无前缀后缀解释
2. 不要执行任何工具或命令
3. **重点报告业务内容和结果**，不要报告 git 操作细节（PR 号、commit hash、merge 过程等技术流程）
4. 忽略英文调试信息、工具调用细节、文件路径等技术噪音
5. 全部用中文

## 固定格式

**${task.name}**
执行时间：约 ${Math.round(durationMs / 60000)} 分钟 | 状态：{✅ 成功 / ❌ 失败 / ⚠️ 部分完成}

### 内容概要
{如果是发文任务：文章标题、选题思路、核心观点、目标关键词}
{如果是监控任务：关键数据指标和变化}
{如果是养号任务：互动数量、推介情况}

### 成果
- {发布链接 / 数据结果 / 完成的操作}

### 需关注（如无则省略此节）
- {异常或需要人工处理的事项}
${diagSection}
---
以下是执行日志（仅供你分析，禁止直接复制到报告中）：

${truncatedLog}`;
}

// ==================== 故障诊断 ====================

interface DiagnosisResult {
  fixed: boolean;
  result: ClaudeResult;
  diagnosis: string;
}

async function diagnoseAndFix(
  task: ScheduledTask,
  failedResult: ClaudeResult
): Promise<DiagnosisResult> {
  audit("DIAGNOSIS_START", `task=${task.id} name=${task.name}`);

  const diagnosisPrompt = `你是一个任务诊断专家。一个定时任务执行失败了，请分析原因并判断能否自我修复。

## 任务信息
名称：${task.name}
指令：${task.prompt}
超时：${failedResult.timedOut ? "是" : "否"}

## 执行日志（最后 8000 字符）
${failedResult.output.slice(-8000)}

## 请回答（只输出 JSON，不要有其他内容）
{
  "category": "SELF_FIXABLE 或 EXTERNAL 或 TIMEOUT_SPLIT",
  "reason": "一句话描述失败原因",
  "fix_prompt": "如果 SELF_FIXABLE，给出具体的修复指令（将作为 Claude Code 的 prompt）",
  "user_suggestion": "如果 EXTERNAL 或 TIMEOUT_SPLIT，告诉用户需要做什么"
}

分类标准：
- SELF_FIXABLE: 代码bug、路径错误、参数问题、网络临时故障、依赖缺失等
- EXTERNAL: API key 过期、外部服务宕机、权限不足、需要人工登录等
- TIMEOUT_SPLIT: 任务太大需要拆分`;

  try {
    const diagResult = await runClaude(diagnosisPrompt, {
      timeoutMs: 120_000,
      maxTurns: 5,
    });

    const jsonMatch = diagResult.output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { fixed: false, result: failedResult, diagnosis: "诊断输出解析失败" };
    }

    const diagnosis = JSON.parse(jsonMatch[0]) as {
      category: string;
      reason: string;
      fix_prompt?: string;
      user_suggestion?: string;
    };

    audit("DIAGNOSIS_RESULT", `task=${task.id} category=${diagnosis.category} reason=${diagnosis.reason}`);

    // 尝试自我修复
    if (diagnosis.category === "SELF_FIXABLE" && diagnosis.fix_prompt) {
      console.log(`[task] ${task.id} attempting self-fix: ${diagnosis.reason}`);

      const fixResult = await runClaude(diagnosis.fix_prompt, {
        timeoutMs: task.timeoutMs,
        maxTurns: 200,
      });

      if (!fixResult.timedOut && !isTaskFailed(fixResult)) {
        audit("DIAGNOSIS_FIXED", `task=${task.id}`);
        return { fixed: true, result: fixResult, diagnosis: diagnosis.reason };
      }
      audit("DIAGNOSIS_FIX_FAILED", `task=${task.id}`);
    }

    return {
      fixed: false,
      result: failedResult,
      diagnosis: diagnosis.user_suggestion || diagnosis.reason,
    };
  } catch (err) {
    audit("DIAGNOSIS_ERROR", `task=${task.id} err=${(err as Error).message}`);
    return {
      fixed: false,
      result: failedResult,
      diagnosis: `诊断过程出错: ${(err as Error).message}`,
    };
  }
}

// ==================== 主执行流程 ====================

export async function executeTask(task: ScheduledTask): Promise<void> {
  acquireLock(task.id);
  const startedAt = new Date();
  console.log(`[task] ${task.id} (${task.name}) starting`);
  audit("TASK_START", `task=${task.id} name=${task.name}`);

  try {
    // 阶段 1: 执行任务
    let execResult = await runClaude(task.prompt, {
      timeoutMs: task.timeoutMs || 3_600_000,
      maxTurns: 200,
    });

    auditOutput(task.prompt, execResult.output);

    // 超时重试
    let retries = 0;
    while (execResult.timedOut && retries < (task.maxRetries ?? 1)) {
      retries++;
      console.log(`[task] ${task.id} timed out, retry ${retries}`);

      const partialLog = execResult.output.slice(-3000);
      const retryPrompt = [
        `继续执行任务：${task.prompt}`,
        "",
        "---",
        "上一轮执行超时了。以下是上一轮的部分输出：",
        partialLog,
        "---",
        "请检查哪些步骤已完成，跳过已完成的，继续完成剩余工作。",
        "如果上一轮没有有效输出，就从头开始。",
      ].join("\n");

      const retryResult = await runClaude(retryPrompt, {
        timeoutMs: task.timeoutMs || 3_600_000,
        maxTurns: 200,
      });
      // 合并输出用于总结
      execResult = {
        output: execResult.output + "\n\n--- RETRY ---\n\n" + retryResult.output,
        timedOut: retryResult.timedOut,
      };
    }

    // 保存执行日志
    const logFile = saveTaskLog(task.id, execResult.output);
    console.log(`[task] ${task.id} log saved: ${logFile}`);

    // 故障诊断（如果失败、超时或空输出）
    let diagnosis: string | undefined;
    if (execResult.timedOut || isTaskFailed(execResult)) {
      const fixResult = await diagnoseAndFix(task, execResult);
      if (fixResult.fixed) {
        execResult = fixResult.result;
        saveTaskLog(task.id, execResult.output);
        diagnosis = `(自动修复成功: ${fixResult.diagnosis})`;
      } else {
        diagnosis = fixResult.diagnosis;
      }
    }

    // 阶段 2: 新 session 总结
    const durationMs = Date.now() - startedAt.getTime();
    const summarizePrompt = buildSummarizePrompt(task, execResult, durationMs, diagnosis);

    const summaryResult = await runClaude(summarizePrompt, {
      timeoutMs: 120_000,
      maxTurns: 5,
    });

    let report = summaryResult.output;
    if (!report || summaryResult.timedOut) {
      report = `**${task.name}**\n执行时间：约 ${Math.round(durationMs / 60000)} 分钟\n\n报告生成失败，日志已保存。`;
    }

    report = sanitizeOutput(report);
    await sendCard(task.chatId, report, task.name);

    const taskSuccess = !execResult.timedOut && !isTaskFailed(execResult);
    updateTaskLastRun(task.id, {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      success: taskSuccess,
      durationMs,
    });

    audit("TASK_DONE", `task=${task.id} duration=${Math.round(durationMs/1000)}s success=${taskSuccess}`);

  } catch (err) {
    console.error(`[task] ${task.id} error:`, err);
    audit("TASK_ERROR", `task=${task.id} err=${(err as Error).message}`);

    // 异常也走诊断，不直接甩错误给用户
    try {
      const errResult: ClaudeResult = {
        output: `Task threw an exception: ${(err as Error).message}\n${(err as Error).stack || ""}`,
        timedOut: false,
      };
      const { diagnosis } = await diagnoseAndFix(task, errResult);
      await sendCard(
        task.chatId,
        `**${task.name}**\n\n遇到问题，诊断结果：\n\n${diagnosis}`,
        task.name
      );
    } catch {
      await sendText(task.chatId, `${task.name} 执行遇到异常，正在排查`);
    }
  } finally {
    releaseLock(task.id);
  }
}
