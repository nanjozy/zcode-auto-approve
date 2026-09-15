// 测试共享工具
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

// 便捷：对一条 Bash 命令跑 decide（moderate / low risk / cwd=WS）
export function decideCmd(command, patch = {}, rules = RULES, decide) {
  return decide({ ...makePayload(patch), tool_input: { command } }, rules);
}
