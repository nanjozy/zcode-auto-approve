// 测试共享工具（v0.3：模型判定架构）
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decide } from '../src/approve.mjs';

export const RULES = JSON.parse(readFileSync(new URL('../rules.json', import.meta.url), 'utf8'));
export const WS = path.resolve('/zaa-test-workspace');       // 模拟 workspace
export const OUTSIDE = path.resolve('/zaa-outside-dir');     // workspace 外目录

export function makePayload(patch = {}) {
  return {
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    riskLevel: 'low',
    cwd: WS,
    session_id: 'sess-test',
    ...patch,
  };
}

// 默认 mock judge：危险关键词 → ask，其余 → approve。
// 防止测试误触真实网络：decideCmd 不显式传 deps 时一律走此 mock。
export function benignJudge(ctx) {
  const danger = ['rm', 'sudo', 'su ', 'curl', 'wget', 'eval', 'base64', 'xxd',
    'openssl', 'format ', 'reg add', 'netsh', 'schtasks', '--force', 'push -f',
    '/dev/sd', 'dd if=', '/etc/', '~/', 'truncate', 'chmod 777'];
  const cmd = ctx.command ?? '';
  if (danger.some((d) => cmd.includes(d))) return { decision: 'ask', reason: '危险命令' };
  return { decision: 'approve', reason: '常规开发操作' };
}

export async function decideCmd(command, patch = {}, rules = RULES, judge = benignJudge) {
  return decide({ ...makePayload(patch), tool_input: { command } }, rules, { judge });
}

// 走真实判定路径（缓存+重试+fetch），但 provider/fetch/时钟全部注入——绝不触网
export function mockProvider() {
  return { baseURL: 'http://judge-mock.local', apiKey: 'test-key', source: 'test' };
}

export function okResp(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
  };
}
