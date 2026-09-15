// 失败语义（design.md §7.2）：一切未知路径收敛到直通，approve 只在显式通过时输出
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide, runHook, loadRules } from '../src/approve.mjs';
import { RULES, makePayload } from './helpers.mjs';

test('stdin 非法 JSON → 空输出 + bad-stdin 审计', () => {
  const entries = [];
  const { stdout } = runHook('{oops', { audit: (e) => entries.push(e), loadRules: () => RULES });
  assert.equal(stdout, '');
  assert.equal(entries[0].reasonCode, 'bad-stdin');
  assert.equal(entries[0].decision, 'passthrough');
});

test('stdin 是合法 JSON 但非对象（如数字）→ 直通', () => {
  const { stdout } = runHook('42', { audit: () => {}, loadRules: () => RULES });
  assert.equal(stdout, '');
});

test('规则文件损坏 → 空输出 + error 审计', () => {
  const entries = [];
  const { stdout } = runHook(JSON.stringify(makePayload()), {
    loadRules: () => { throw new Error('rules broken'); },
    audit: (e) => entries.push(e),
  });
  assert.equal(stdout, '');
  assert.equal(entries[0].reasonCode, 'error');
});

test('loadRules：不支持的版本号抛错', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaa-rules-'));
  const p = path.join(dir, 'rules.json');
  writeFileSync(p, JSON.stringify({ version: 2, profiles: {}, bashGroups: {}, deny: { patterns: [], tools: [] } }));
  assert.throws(() => loadRules(p), /version/);
});

test('loadRules：activeProfile 不存在抛错', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaa-rules-'));
  const p = path.join(dir, 'rules.json');
  writeFileSync(p, JSON.stringify({
    version: 1, activeProfile: 'ghost', profiles: { moderate: { maxRiskLevel: 'low' } },
    bashGroups: {}, deny: { patterns: [], tools: [] },
  }));
  assert.throws(() => loadRules(p), /activeProfile/);
});

test('loadRules：缺 bashGroups 抛错', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaa-rules-'));
  const p = path.join(dir, 'rules.json');
  writeFileSync(p, JSON.stringify({
    version: 1, activeProfile: 'moderate', profiles: { moderate: { maxRiskLevel: 'low', bashGroups: ['readonly'] } },
    deny: { patterns: [], tools: [] },
  }));
  assert.throws(() => loadRules(p), /bashGroups/);
});

test('loadRules：目录不存在抛错（缺失规则=直通）', () => {
  assert.throws(() => loadRules(path.join(tmpdir(), 'zaa-no-such', 'rules.json')));
});

test('Bash 缺 command 字段 / 类型不对 → no-command', () => {
  assert.equal(decide({ ...makePayload(), tool_input: {} }, RULES).reasonCode, 'no-command');
  assert.equal(decide({ ...makePayload(), tool_input: { command: 42 } }, RULES).reasonCode, 'no-command');
});

test('riskLevel 缺失或未知值 → 不放行（保守）', () => {
  assert.equal(decide({ ...makePayload(), riskLevel: undefined }, RULES).reasonCode, 'risk-level');
  assert.equal(decide({ ...makePayload(), riskLevel: 'extreme' }, RULES).reasonCode, 'risk-level');
});

test('Write 缺 file_path → no-match', () => {
  assert.equal(decide({ ...makePayload({ tool_name: 'Write' }), tool_input: {} }, RULES).reasonCode, 'no-match');
});

test('payload 为 null / 数字 / 错误事件名 → event-mismatch', () => {
  assert.equal(decide(null, RULES).reasonCode, 'event-mismatch');
  assert.equal(decide(42, RULES).reasonCode, 'event-mismatch');
  assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, RULES).reasonCode, 'event-mismatch');
});

test('缺 tool_name 的 payload → no-match', () => {
  const { tool_name, ...rest } = makePayload();
  assert.equal(decide(rest, RULES).reasonCode, 'no-match');
});

test('审计写入失败不影响决策输出', () => {
  const { stdout } = runHook(JSON.stringify(makePayload({ tool_input: { command: 'git status' } })), {
    audit: () => { throw new Error('disk full'); },
  });
  assert.equal(stdout, '{"decision":"approve"}');
});

test('decide 对畸形嵌套结构不抛异常', () => {
  assert.equal(decide({ hook_event_name: 'PermissionRequest', tool_input: 'not-an-object' }, RULES).action, 'passthrough');
  assert.equal(
    decide({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: { deep: true } } }, RULES).action,
    'passthrough',
  );
});

test('空命令串 → no-match', () => {
  assert.equal(decide({ ...makePayload(), tool_input: { command: '   ' } }, RULES).reasonCode, 'no-match');
});

test('真实审计落盘：写入临时目录并追加两行', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaa-audit-'));
  const envKey = 'ZCODE_AUTO_APPROVE_LOG_DIR';
  const prev = process.env[envKey];
  process.env[envKey] = dir;
  try {
    // runHook 使用默认 defaultAudit（读取 env）
    const r1 = runHook(JSON.stringify(makePayload({ tool_input: { command: 'git status' } })), { loadRules: () => RULES });
    const r2 = runHook(JSON.stringify(makePayload({ tool_input: { command: 'sudo x' } })), { loadRules: () => RULES });
    assert.equal(r1.stdout, '{"decision":"approve"}');
    assert.equal(r2.stdout, '');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith('audit-') && files[0].endsWith('.jsonl'));
    const lines = readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    assert.equal(e1.decision, 'approve');
    assert.equal(e1.command, 'git status');
    assert.equal(e1.reasonCode, null);
    assert.equal(e2.decision, 'passthrough');
    assert.equal(e2.reasonCode, 'deny-pattern');
  } finally {
    if (prev === undefined) delete process.env[envKey]; else process.env[envKey] = prev;
  }
});
