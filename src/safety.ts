/**
 * 输出安全过滤
 *
 * 因为 Claude Code 使用 --dangerously-skip-permissions，
 * 需要自建安全层防止敏感信息泄露。
 */

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { config } from "./config.js";

const AUDIT_LOG = join(config.dataDir, "audit.log");
mkdirSync(config.dataDir, { recursive: true });

// ==================== 敏感信息过滤 ====================

/** 发送前过滤所有敏感信息 */
export function sanitizeOutput(text: string): string {
  let result = text;

  // 1. API Key 模式（各种常见格式）
  result = result.replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[API_KEY]");
  result = result.replace(/ghp_[a-zA-Z0-9]{36,}/g, "[GITHUB_TOKEN]");
  result = result.replace(/gho_[a-zA-Z0-9]{36,}/g, "[GITHUB_TOKEN]");
  result = result.replace(/sk-or-v1-[a-zA-Z0-9]{60,}/g, "[API_KEY]");
  result = result.replace(/xoxb-[a-zA-Z0-9-]+/g, "[SLACK_TOKEN]");
  result = result.replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/g, "Bearer [TOKEN]");

  // 2. Lark/飞书 内部标识符
  result = result.replace(/\bou_[a-f0-9]{20,}\b/g, "[用户]");
  result = result.replace(/\boc_[a-f0-9]{20,}\b/g, "[群聊]");
  result = result.replace(/\bom_[a-zA-Z0-9_]{10,}\b/g, "[消息]");
  result = result.replace(/\bcli_[a-f0-9]{16,}\b/g, "[应用]");

  // 3. 内网 IP 地址
  result = result.replace(/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, "[内网IP]");
  result = result.replace(/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[内网IP]");
  result = result.replace(/\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, "[内网IP]");

  // 4. 本机用户路径
  const home = homedir();
  if (home) {
    result = result.replaceAll(home + "/", "~/");
  }

  // 5. 环境变量中的敏感值（动态匹配）
  const sensitiveEnvKeys = [
    "LARK_APP_SECRET", "LARK_ENCRYPT_KEY",
    "OPENAI_API_KEY", "GITHUB_PAT",
  ];
  for (const key of sensitiveEnvKeys) {
    const val = process.env[key];
    if (val && val.length > 5) {
      result = result.replaceAll(val, `[${key}]`);
    }
  }

  return result;
}

// ==================== 路径白名单 ====================

const ALLOWED_PATHS = [process.cwd() + "/", "/tmp/"];

export function isAllowedPath(path: string): boolean {
  return ALLOWED_PATHS.some((p) => path.startsWith(p));
}

// ==================== 审计日志 ====================

export function audit(action: string, details: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${action}: ${details.slice(0, 500)}\n`;
  try {
    appendFileSync(AUDIT_LOG, line, "utf-8");
  } catch {
    console.error("[audit] Failed to write audit log");
  }
}

/** 检查输出中是否有可疑操作（只记录，不阻止） */
export function auditOutput(prompt: string, output: string): void {
  const warnings: string[] = [];

  if (/rm\s+-rf\s+[\/~]/.test(output)) warnings.push("rm -rf on root/home");
  if (/sudo\s/.test(output)) warnings.push("sudo usage");
  if (/\.ssh\//.test(output)) warnings.push("SSH directory access");
  if (/DROP\s+TABLE|DELETE\s+FROM/i.test(output)) warnings.push("destructive SQL");
  if (/curl.*\|.*sh\b/.test(output)) warnings.push("pipe to shell");

  if (warnings.length) {
    audit("WARNING", `${warnings.join(", ")} | prompt: ${prompt.slice(0, 100)}`);
  }

  // 记录每次调用摘要
  audit("CLAUDE_CALL", `prompt: ${prompt.slice(0, 80)}... | output: ${output.slice(0, 80)}...`);
}
