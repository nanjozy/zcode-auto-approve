// 模型判定引擎：mock judge、安全网、重试、输出解析、provider 解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide, judgeWithRetry, parseJudgeOutput, resolveProvider, JudgeError } from '../src/approve.mjs';
import { RULES, WS, makePayload, benignJudge, mockProvider, okResp } from './helpers.mjs';

const bash = async (command, deps, patch = {}) =>
  decide({ ...makePayload(patch), tool_input: { command } }, RULES, deps);

// ---------- mock judge 路径 ----------

test('模型 approve → 放行，matchedRule=model', async () => {
  const r = await bash('cd /tmp && npm test', { judge: benignJudge });
  assert.equal(r.action, 'approve');
  assert.equal(r.matchedRule, 'model');
  assert.equal(r.judgeInfo.source, 'model');
});

test('模型 ask → 直通 model-ask，理由保留', async () => {
  const r = await bash('docker system prune', { judge: async () => ({ decision: 'ask', reason: '破坏性清理' }) });
  assert.equal(r.reasonCode, 'model-ask');
  assert.equal(r.judgeInfo.reason, '破坏性清理');
});

test('模型抛错 → model-error', async () => {
  const r = await bash('ls', { judge: async () => { throw new Error('boom'); } });
  assert.equal(r.reasonCode, 'model-error');
});

test('模型输出 decision 非法 → model-error', async () => {
  const r = await bash('ls', { judge: async () => ({ decision: 'maybe', reason: '' }) });
  assert.equal(r.reasonCode, 'model-error');
});

test('v2 的模型增益：结构上白名单外的常规命令可放行', async () => {
  for (const cmd of ['cd /tmp && ls', 'timeout 30 npm test', 'tar czf out.tgz dist/', 'chmod +x run.sh']) {
    const r = await bash(cmd, { judge: benignJudge });
    assert.equal(r.action, 'approve', cmd);
  }
});

// ---------- parseJudgeOutput ----------

test('parseJudgeOutput：合法 JSON', () => {
  assert.deepEqual(parseJudgeOutput('{"decision":"approve","reason":"只读"}'), { decision: 'approve', reason: '只读' });
});

test('parseJudgeOutput：容忍前后缀文案，提取 JSON', () => {
  const text = '好的，判断如下：\n{"decision":"ask","reason":"含删除"}\n以上。';
  assert.deepEqual(parseJudgeOutput(text), { decision: 'ask', reason: '含删除' });
});

test('parseJudgeOutput：reason 缺省为空串，超长截断 500', () => {
  assert.deepEqual(parseJudgeOutput('{"decision":"approve"}'), { decision: 'approve', reason: '' });
  const long = parseJudgeOutput(`{"decision":"approve","reason":"${'x'.repeat(600)}"}`);
  assert.equal(long.reason.length, 500);
});

test('parseJudgeOutput：decision 非法 / 非 JSON / 非对象 → null', () => {
  assert.equal(parseJudgeOutput('{"decision":"yolo"}'), null);
  assert.equal(parseJudgeOutput('看起来安全'), null);
  assert.equal(parseJudgeOutput('["approve"]'), null);
  assert.equal(parseJudgeOutput(null), null);
});

// ---------- judgeWithRetry：重试与预算 ----------

const CFG = { model: 'm', maxTokens: 64, temperature: 0, attempts: 4, perAttemptTimeoutMs: 2000, overallDeadlineMs: 60000, retryBackoffMs: 1 };

test('前两次失败第三次成功 → approve，attempts=3', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) throw new JudgeError('http 500');
    return okResp('{"decision":"approve","reason":"ok"}');
  };
  const out = await judgeWithRetry(mockProvider(), CFG, 'sys', 'user', { fetchImpl, sleep: async () => {} });
  assert.equal(out.decision, 'approve');
  assert.equal(out.attempts, 3);
  assert.equal(calls, 3);
});

test('4 次全部失败 → 抛 JudgeError，恰好尝试 4 次', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new JudgeError('timeout'); };
  await assert.rejects(
    judgeWithRetry(mockProvider(), CFG, 'sys', 'user', { fetchImpl, sleep: async () => {} }),
    JudgeError,
  );
  assert.equal(calls, 4);
});

test('非法输出也触发重试，最终失败抛错', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return okResp('我认为安全'); };
  await assert.rejects(
    judgeWithRetry(mockProvider(), CFG, 'sys', 'user', { fetchImpl, sleep: async () => {} }),
    JudgeError,
  );
  assert.equal(calls, 4);
});

test('总预算耗尽则不再尝试', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new JudgeError('err'); };
  const tightCfg = { ...CFG, overallDeadlineMs: 0 };
  await assert.rejects(
    judgeWithRetry(mockProvider(), tightCfg, 'sys', 'user', { fetchImpl, sleep: async () => {} }),
    JudgeError,
  );
  assert.equal(calls, 1); // 预算为 0，第 2 次起不再尝试
});

test('HTTP 非 2xx 视为失败', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    judgeWithRetry(mockProvider(), CFG, 'sys', 'user', { fetchImpl, sleep: async () => {} }),
    JudgeError,
  );
});

// ---------- resolveProvider ----------

test('env 优先：ZAA_BASE_URL + ZAA_API_KEY', () => {
  const prevB = process.env.ZAA_BASE_URL, prevK = process.env.ZAA_API_KEY;
  process.env.ZAA_BASE_URL = 'http://env.local';
  process.env.ZAA_API_KEY = 'env-key';
  try {
    const p = resolveProvider('/nonexistent', () => { throw new Error('should not read'); });
    assert.equal(p.source, 'env');
    assert.equal(p.baseURL, 'http://env.local');
  } finally {
    if (prevB === undefined) delete process.env.ZAA_BASE_URL; else process.env.ZAA_BASE_URL = prevB;
    if (prevK === undefined) delete process.env.ZAA_API_KEY; else process.env.ZAA_API_KEY = prevK;
  }
});

test('从 ZCode provider 配置读第一个 enabled 且带密钥的 provider', () => {
  const fakeRead = (p, enc) => {
    assert.equal(enc, 'utf8');
    return JSON.stringify({
      provider: {
        'a-disabled': { enabled: false, options: { baseURL: 'http://a', apiKey: 'k' } },
        'b-nokey': { enabled: true, options: { baseURL: 'http://b' } },
        'c-ok': { enabled: true, options: { baseURL: 'http://c', apiKey: 'kc' } },
        'd-ok': { enabled: true, options: { baseURL: 'http://d', apiKey: 'kd' } },
      },
    });
  };
  const p = resolveProvider(path.join(tmpdir(), 'whatever.json'), fakeRead);
  assert.equal(p.source, 'zcode-config:c-ok');
  assert.equal(p.baseURL, 'http://c');
});

test('配置缺失 → null', () => {
  assert.equal(resolveProvider('/nonexistent/path.json'), null);
});
