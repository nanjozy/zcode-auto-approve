// 判定缓存：命中/未命中/TTL/禁用/安全网穿透（真实缓存代码 + 注入 fetch，绝不触网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide, cacheKey } from '../src/approve.mjs';
import { RULES, makePayload, mockProvider, okResp } from './helpers.mjs';

const ENV_KEY = 'ZAA_JUDGE_CACHE_DIR';

// 包装为异步测试函数：env 在整个测试体执行期间保持，结束后恢复
function withCacheDir(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zaa-judge-'));
    const prev = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = prev;
    }
  };
}

// 真实判定路径（缓存 + 重试），fetch/provider 注入
function realPathDeps(fetchLog, response) {
  return {
    resolveProvider: mockProvider,
    fetchImpl: async (url, opts) => {
      fetchLog.push({ url, body: JSON.parse(opts.body) });
      return response ?? okResp('{"decision":"approve","reason":"常规开发操作"}');
    },
    sleep: async () => {},
  };
}

test('缓存命中：同命令第二次不再调模型', withCacheDir(async () => {
  const calls = [];
  const deps = realPathDeps(calls);
  const payload = makePayload({ tool_input: { command: 'npm test' } });

  const r1 = await decide(payload, RULES, deps);
  const r2 = await decide({ ...payload, session_id: 'sess-2' }, RULES, deps);

  assert.equal(r1.action, 'approve');
  assert.equal(r1.matchedRule, 'model');
  assert.equal(r1.judgeInfo.source, 'model');
  assert.equal(r2.action, 'approve');
  assert.equal(r2.matchedRule, 'judge-cache');
  assert.equal(r2.judgeInfo.source, 'cache');
  assert.equal(calls.length, 1);
}));

test('ask 判定同样入缓存', withCacheDir(async () => {
  const calls = [];
  const deps = realPathDeps(calls, okResp('{"decision":"ask","reason":"不确定"}'));
  const payload = makePayload({ tool_input: { command: 'docker system prune' } });

  const r1 = await decide(payload, RULES, deps);
  const r2 = await decide(payload, RULES, deps);
  assert.equal(r1.reasonCode, 'model-ask');
  assert.equal(r1.judgeInfo.source, 'model');
  assert.equal(r2.reasonCode, 'model-ask');
  assert.equal(r2.judgeInfo.source, 'cache');
  assert.equal(calls.length, 1);
}));

test('TTL 过期后重新问模型', withCacheDir(async () => {
  const calls = [];
  const deps = realPathDeps(calls);
  let t = 1_000_000;
  const tickDeps = { ...deps, now: () => t };
  const payload = makePayload({ tool_input: { command: 'cargo build' } });

  await decide(payload, RULES, tickDeps);          // 写入缓存
  t += 1000;                                        // 未过期
  await decide(payload, RULES, tickDeps);
  assert.equal(calls.length, 1);
  t += RULES.judge.cache.ttlMs + 1;                 // 过期
  await decide(payload, RULES, tickDeps);
  assert.equal(calls.length, 2);
}));

test('不同命令/不同档位不共享缓存', withCacheDir(async () => {
  const calls = [];
  const deps = realPathDeps(calls);
  await decide(makePayload({ tool_input: { command: 'npm test' } }), RULES, deps);
  await decide(makePayload({ tool_input: { command: 'npm run build' } }), RULES, deps);
  const strictRules = structuredClone(RULES);
  strictRules.activePolicy = 'strict';
  await decide(makePayload({ tool_input: { command: 'npm test' } }), strictRules, deps);
  assert.equal(calls.length, 3);
}));

test('缓存命中仍受安全网约束（deny 正则先于缓存）', withCacheDir(async () => {
  const calls = [];
  const deps = realPathDeps(calls);
  const payload = makePayload({ tool_input: { command: 'cp a b' } });

  const r1 = await decide(payload, RULES, deps);
  assert.equal(r1.action, 'approve');

  // 规则收紧：cp 进入 deny 正则 → 缓存命中也不能放行
  const hardened = structuredClone(RULES);
  hardened.deny.patterns = ['^cp\\b'];
  const r2 = await decide(payload, hardened, deps);
  assert.equal(r2.reasonCode, 'deny-pattern');
}));

test('缓存禁用时每次都问模型', withCacheDir(async () => {
  const calls = [];
  const deps = realPathDeps(calls);
  const rules = structuredClone(RULES);
  rules.judge.cache.enabled = false;
  const payload = makePayload({ tool_input: { command: 'npm test' } });
  await decide(payload, rules, deps);
  await decide(payload, rules, deps);
  assert.equal(calls.length, 2);
}));

test('模型请求体：Anthropic 协议 + 命令以 JSON 数据嵌入', withCacheDir(async () => {
  const calls = [];
  const deps = realPathDeps(calls);
  await decide(makePayload({ tool_input: { command: 'ls -la' } }), RULES, deps);
  assert.equal(calls.length, 1);
  const { url, body } = calls[0];
  assert.ok(url.startsWith('http://judge-mock.local/v1/messages'), url);
  assert.equal(body.model, RULES.judge.model);
  assert.equal(body.temperature, 0);
  assert.ok(body.system.includes('不可信数据'));
  assert.ok(body.messages[0].content.includes('"command":"ls -la"'));
}));

test('cacheKey：确定性 + 随命令变化', () => {
  const a = cacheKey('m', 'standard', 'ls');
  assert.equal(a, cacheKey('m', 'standard', 'ls'));
  assert.notEqual(a, cacheKey('m', 'standard', 'ls -la'));
  assert.notEqual(a, cacheKey('m', 'strict', 'ls'));
  assert.notEqual(a, cacheKey('m2', 'standard', 'ls'));
});
