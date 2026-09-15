// 失败语义（design.md §7.2 v0.3）：一切未知路径收敛到直通，approve 只在显式通过时输出
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide, runHook, loadRules, JudgeError } from '../src/approve.mjs';
import { RULES, makePayload, benignJudge, mockProvider, okResp } from './helpers.mjs';

test('stdin 非法 JSON → 空输出 + bad-stdin 审计', async () => {
  const entries = [];
  const { stdout } = await runHook('{oops', { audit: (e) => entries.push(e), loadRules: () => RULES });
  assert.equal(stdout, '');
  assert.equal(entries[0].reasonCode, 'bad-stdin');
});

test('stdin 是合法 JSON 但非对象 → 直通', async () => {
  const { stdout } = await runHook('42', { audit: () => {}, loadRules: () => RULES });
  assert.equal(stdout, '');
});

test('规则文件损坏 → 空输出 + error 审计', async () => {
  const entries = [];
  const { stdout } = await runHook(JSON.stringify(makePayload()), {
    loadRules: () => { throw new Error('rules broken'); },
    audit: (e) => entries.push(e),
  });
  assert.equal(stdout, '');
  assert.equal(entries[0].reasonCode, 'error');
});

const tmpRules = (obj) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaa-rules-'));
  const p = path.join(dir, 'rules.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

test('loadRules：v1 规则（M2 版本）被拒绝', () => {
  assert.throws(() => loadRules(tmpRules({ version: 1 })), /expected 2/);
});

test('loadRules：judge.attempts 缺失/非法抛错', () => {
  const base = { version: 2, activePolicy: 'standard', policies: { standard: { maxRiskLevel: 'medium' } }, deny: { patterns: [], tools: [] }, tools: [] };
  assert.throws(() => loadRules(tmpRules({ ...base, judge: { model: 'm' } })), /judge\.attempts/);
  assert.throws(() => loadRules(tmpRules({ ...base, judge: { attempts: -1 } })), /judge\.attempts/);
});

test('loadRules：activePolicy 不存在抛错', () => {
  assert.throws(() => loadRules(tmpRules({
    version: 2, activePolicy: 'ghost', policies: { standard: { maxRiskLevel: 'medium' } },
    deny: { patterns: [], tools: [] }, tools: [], judge: { attempts: 2, perAttemptTimeoutMs: 1, overallDeadlineMs: 2, retryBackoffMs: 1 },
  })), /activePolicy/);
});

test('loadRules：tools 缺失抛错', () => {
  assert.throws(() => loadRules(tmpRules({
    version: 2, activePolicy: 'standard', policies: { standard: { maxRiskLevel: 'medium' } },
    deny: { patterns: [], tools: [] },
    judge: { attempts: 2, perAttemptTimeoutMs: 1, overallDeadlineMs: 2, retryBackoffMs: 1 },
  })), /tools/);
});

test('loadRules：目录不存在抛错', () => {
  assert.throws(() => loadRules(path.join(tmpdir(), 'zaa-no-such', 'rules.json')));
});

test('无可用 provider → no-provider（不触网）', async () => {
  const r = await decide(makePayload({ tool_input: { command: 'ls' } }), RULES, {
    resolveProvider: () => null,
    sleep: async () => {},
  });
  assert.equal(r.reasonCode, 'no-provider');
});

test('模型重试耗尽 → model-error', async () => {
  const rules = structuredClone(RULES);
  rules.judge.attempts = 2;
  rules.judge.cache.enabled = false;
  const r = await decide(makePayload({ tool_input: { command: 'ls' } }), rules, {
    resolveProvider: mockProvider,
    fetchImpl: async () => { throw new JudgeError('timeout'); },
    sleep: async () => {},
  });
  assert.equal(r.reasonCode, 'model-error');
});

test('Bash 缺 command 字段 / 类型不对 / 空串 → no-command', async () => {
  assert.equal((await decide({ ...makePayload(), tool_input: {} }, RULES, { judge: benignJudge })).reasonCode, 'no-command');
  assert.equal((await decide({ ...makePayload(), tool_input: { command: 42 } }, RULES, { judge: benignJudge })).reasonCode, 'no-command');
  assert.equal((await decide({ ...makePayload(), tool_input: { command: '   ' } }, RULES, { judge: benignJudge })).reasonCode, 'no-command');
});

test('Write 缺 file_path → no-match', async () => {
  assert.equal((await decide({ ...makePayload({ tool_name: 'Write' }), tool_input: {} }, RULES, {})).reasonCode, 'no-match');
});

test('payload 为 null / 数字 / 错误事件名 → event-mismatch', async () => {
  assert.equal((await decide(null, RULES, {})).reasonCode, 'event-mismatch');
  assert.equal((await decide(42, RULES, {})).reasonCode, 'event-mismatch');
  assert.equal((await decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, RULES, {})).reasonCode, 'event-mismatch');
});

test('缺 tool_name 的 payload → no-match', async () => {
  const { tool_name, ...rest } = makePayload();
  assert.equal((await decide(rest, RULES, {})).reasonCode, 'no-match');
});

test('审计写入失败不影响决策输出', async () => {
  const { stdout } = await runHook(JSON.stringify(makePayload({ tool_input: { command: 'git status' } })), {
    audit: () => { throw new Error('disk full'); },
    judge: benignJudge,
  });
  assert.equal(stdout, '{"decision":"approve"}');
});

test('decide 对畸形嵌套结构不抛异常', async () => {
  assert.equal((await decide({ hook_event_name: 'PermissionRequest', tool_input: 'not-an-object' }, RULES, {})).action, 'passthrough');
  assert.equal(
    (await decide({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: { deep: true } } }, RULES, {})).action,
    'passthrough',
  );
});

test('真实审计落盘（mock judge，临时目录）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaa-audit-'));
  const envKey = 'ZCODE_AUTO_APPROVE_LOG_DIR';
  const prev = process.env[envKey];
  process.env[envKey] = dir;
  try {
    const r1 = await runHook(JSON.stringify(makePayload({ tool_input: { command: 'git status' } })), { judge: benignJudge });
    const r2 = await runHook(JSON.stringify(makePayload({ tool_input: { command: 'rm -rf /' } })), { judge: benignJudge });
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
    assert.equal(e1.reasonCode, null);
    assert.equal(e1.judge.source, 'model');
    assert.equal(e2.decision, 'passthrough');
    assert.equal(e2.reasonCode, 'deny-pattern');
  } finally {
    if (prev === undefined) delete process.env[envKey]; else process.env[envKey] = prev;
  }
});
