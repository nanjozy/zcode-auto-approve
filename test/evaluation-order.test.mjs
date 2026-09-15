// 求值顺序对抗用例：黑名单优先于白名单、护栏优先于白名单（design.md §5.1 顺序固定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { decide } from '../src/approve.mjs';
import { RULES, WS, makePayload } from './helpers.mjs';

const bash = (command, patch = {}, rules = RULES) =>
  decide({ ...makePayload(patch), tool_input: { command } }, rules);

test('顺序 1：workspace 禁用优先于一切', () => {
  const rules = structuredClone(RULES);
  rules.guards.disabledWorkspaces = [WS];
  assert.equal(bash('ls', {}, rules).reasonCode, 'workspace-disabled');
  // 即便工具在黑名单里，禁用判定仍在先
  const r = decide({ ...makePayload({ cwd: WS, tool_name: 'WebFetch' }), tool_input: {} }, rules);
  assert.equal(r.reasonCode, 'workspace-disabled');
});

test('顺序 2：工具黑名单优先于 riskLevel 护栏', () => {
  const r = decide({ ...makePayload({ tool_name: 'mcp__x__y', riskLevel: 'critical' }), tool_input: {} }, RULES);
  assert.equal(r.reasonCode, 'deny-tool');
});

test('顺序 3：Bash 黑名单优先于 riskLevel 护栏', () => {
  assert.equal(bash('ls && rm -rf /tmp/x', { riskLevel: 'critical' }).reasonCode, 'deny-pattern');
});

test('顺序 3.5：不可分析结构优先于 riskLevel 护栏', () => {
  assert.equal(bash('echo $(x)', { riskLevel: 'critical' }).reasonCode, 'unanalyzable');
});

test('顺序 4：riskLevel 护栏优先于白名单', () => {
  for (const rl of ['high', 'critical']) {
    assert.equal(bash('ls', { riskLevel: rl }).reasonCode, 'risk-level');
  }
  // 护栏同样挡在文件写放行之前
  const w = decide(
    { ...makePayload({ tool_name: 'Write', riskLevel: 'high' }), tool_input: { file_path: path.join(WS, 'a.txt') } },
    RULES,
  );
  assert.equal(w.reasonCode, 'risk-level');
});

test('顺序 5：非 Bash 工具白名单放行', () => {
  for (const tool of ['Read', 'Glob', 'Grep', 'TodoRead', 'TodoWrite', 'Task']) {
    const r = decide({ ...makePayload({ tool_name: tool }), tool_input: {} }, RULES);
    assert.equal(r.action, 'approve', tool);
    assert.equal(r.matchedRule, `profile.tools:${tool}`);
  }
});

test('防御：即使误把 Bash 写进 tools 白名单，仍必须通过命令分析', () => {
  const rules = structuredClone(RULES);
  rules.profiles.moderate.tools = [...rules.profiles.moderate.tools, 'Bash'];
  assert.equal(bash('docker build .', {}, rules).reasonCode, 'no-match'); // 未分析通过 → 不放行
  assert.equal(bash('ls', {}, rules).action, 'approve');                  // 分析通过 → 放行
});

test('顺序 6：复合命令一段不安全整条直通', () => {
  assert.equal(bash('ls && docker build .').reasonCode, 'no-match');
  assert.equal(bash('git status && npm test').action, 'approve');
});

test('顺序 7：Write/Edit 路径护栏', () => {
  const inside = decide(
    { ...makePayload({ tool_name: 'Write' }), tool_input: { file_path: path.join(WS, 'src', 'a.js') } },
    RULES,
  );
  assert.equal(inside.action, 'approve');
  assert.equal(inside.matchedRule, 'fileEdits:workspace-only');

  const outside = decide(
    { ...makePayload({ tool_name: 'Write' }), tool_input: { file_path: path.join(path.resolve(WS, '..'), 'x.js') } },
    RULES,
  );
  assert.equal(outside.reasonCode, 'path-outside-workspace');

  const home = decide(
    { ...makePayload({ tool_name: 'Edit' }), tool_input: { file_path: '~/.ssh/authorized_keys' } },
    RULES,
  );
  assert.equal(home.reasonCode, 'path-outside-workspace');

  // 相对路径以 cwd 解析
  const rel = decide({ ...makePayload({ tool_name: 'Edit' }), tool_input: { file_path: 'src/../b.js' } }, RULES);
  assert.equal(rel.action, 'approve');
});

test('顺序 7：conservative 档不放行文件写（无 fileEdits 配置）', () => {
  const rules = structuredClone(RULES);
  rules.activeProfile = 'conservative';
  const r = decide(
    { ...makePayload({ tool_name: 'Write' }), tool_input: { file_path: path.join(WS, 'a.txt') } },
    rules,
  );
  assert.equal(r.reasonCode, 'no-match');
});

test('profile 档位差异：conservative 只认 readonly，且 riskLevel 上限 low', () => {
  const rules = structuredClone(RULES);
  rules.activeProfile = 'conservative';
  assert.equal(bash('ls', {}, rules).action, 'approve');
  assert.equal(bash('npm test', {}, rules).reasonCode, 'no-match');
  assert.equal(bash('ls', { riskLevel: 'medium' }, rules).reasonCode, 'risk-level');
  // moderate 档 medium 可过
  assert.equal(bash('ls', { riskLevel: 'medium' }).action, 'approve');
});
