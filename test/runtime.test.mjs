// ADR-0009 运行时选择测试：electron 探测/验证/回退、注册形态、卸载兼容。
// 全部 mock 注入（spawn 用假实现），绝不启动真实 ZCode.exe。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildHookEntry, chooseRuntime, doInstall, resolveElectronPath, verifyElectronRuntime, SCRIPT_PATH } from '../scripts/install.mjs';
import { doUninstall } from '../scripts/uninstall.mjs';

const NODE = process.execPath;
const tmpCfg = (init) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaa-runtime-'));
  const p = path.join(dir, 'config.json');
  if (init !== undefined) writeFileSync(p, init);
  return p;
};
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

// —— resolveElectronPath ——

test('resolveElectronPath：显式选项 > ZAA_ELECTRON > 默认路径探测', () => {
  assert.equal(resolveElectronPath({ electronPath: 'C:\\opt\\Z.exe' }), 'C:\\opt\\Z.exe');
  const prev = process.env.ZAA_ELECTRON;
  process.env.ZAA_ELECTRON = 'C:\\env\\Z.exe';
  try {
    assert.equal(resolveElectronPath(), 'C:\\env\\Z.exe');
    // env 指向不存在路径也原样返回（存在性由 verify 阶段兜底，符合"env 显式覆盖"语义）
    assert.equal(resolveElectronPath({}), 'C:\\env\\Z.exe');
  } finally {
    if (prev === undefined) delete process.env.ZAA_ELECTRON; else process.env.ZAA_ELECTRON = prev;
  }
});

test('resolveElectronPath：无 env 且默认路径不存在 → null', () => {
  const prev = process.env.ZAA_ELECTRON;
  const prevLocal = process.env.LOCALAPPDATA;
  delete process.env.ZAA_ELECTRON;
  process.env.LOCALAPPDATA = mkdtempSync(path.join(tmpdir(), 'zaa-nozcode-'));
  try {
    assert.equal(resolveElectronPath(), null);
  } finally {
    if (prev !== undefined) process.env.ZAA_ELECTRON = prev;
    if (prevLocal !== undefined) process.env.LOCALAPPDATA = prevLocal;
  }
});

// —— buildHookEntry ——

test('buildHookEntry：electron 形态带 env 字段，node 形态保持 ADR-0002 原样', () => {
  assert.deepEqual(buildHookEntry({ source: 'electron', electronPath: 'C:\\Z\\ZCode.exe', nodeVersion: '24.14.0' }, SCRIPT_PATH), {
    type: 'process', command: 'C:\\Z\\ZCode.exe', args: [SCRIPT_PATH],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: 30000, statusMessage: 'auto-approve：模型审批中',
  });
  assert.deepEqual(buildHookEntry({ source: 'node', nodePath: NODE }, SCRIPT_PATH), {
    type: 'process', command: NODE, args: [SCRIPT_PATH],
    timeoutMs: 30000, statusMessage: 'auto-approve：模型审批中',
  });
});

// —— verifyElectronRuntime（注入假 spawn）——

const okProbe = { code: 0, stdout: '24.14.0\n', stderr: '' };
const emptySmoke = { code: 0, stdout: '', stderr: '' };

test('verifyElectronRuntime：探针+冒烟都过 → ok 且带 node 版本', async () => {
  const calls = [];
  const v = await verifyElectronRuntime('C:\\Z\\ZCode.exe', SCRIPT_PATH, {
    spawn: async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env, input: opts.input });
      return args[0] === '-e' ? okProbe : emptySmoke;
    },
  });
  assert.deepEqual(v, { ok: true, nodeVersion: '24.14.0', source: 'electron' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[1].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[1].args[0], SCRIPT_PATH);
  const payload = JSON.parse(calls[1].input);
  assert.equal(payload.tool_input.command, 'rm -rf /');   // 冒烟必须走 deny-path，不产生模型调用
});

test('verifyElectronRuntime：探针失败（exit 非 0 / 输出非版本号）→ 不跑冒烟直接回退理由', async () => {
  for (const probe of [{ code: 1, stdout: '', stderr: 'fuse off' }, { code: 0, stdout: 'ZCode GUI', stderr: '' }]) {
    let smokeCalled = false;
    const v = await verifyElectronRuntime('C:\\Z\\ZCode.exe', SCRIPT_PATH, {
      spawn: async (cmd, args) => (args[0] === '-e' ? probe : (smokeCalled = true, emptySmoke)),
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /版本探针失败/);
    assert.equal(smokeCalled, false);
  }
});

test('verifyElectronRuntime：冒烟异常退出或产生输出 → 失败', async () => {
  const v1 = await verifyElectronRuntime('C:\\Z\\ZCode.exe', SCRIPT_PATH, {
    spawn: async (cmd, args) => (args[0] === '-e' ? okProbe : { code: 2, stdout: '', stderr: 'crash' }),
  });
  assert.equal(v1.ok, false);
  assert.match(v1.reason, /冒烟异常退出/);
  const v2 = await verifyElectronRuntime('C:\\Z\\ZCode.exe', SCRIPT_PATH, {
    spawn: async (cmd, args) => (args[0] === '-e' ? okProbe : { code: 0, stdout: '{"decision":"approve"}', stderr: '' }),
  });
  assert.equal(v2.ok, false);
  assert.match(v2.reason, /非预期输出/);
});

// —— chooseRuntime ——

test('chooseRuntime：验证通过 → electron', async () => {
  const r = await chooseRuntime({ electronPath: 'C:\\Z\\ZCode.exe' }, {
    spawn: async (cmd, args) => (args[0] === '-e' ? okProbe : emptySmoke),
  });
  assert.deepEqual(r, { source: 'electron', electronPath: 'C:\\Z\\ZCode.exe', nodeVersion: '24.14.0' });
});

test('chooseRuntime：定位不到 ZCode.exe → 回退 node 并给原因', async () => {
  const prevE = process.env.ZAA_ELECTRON;
  const prevL = process.env.LOCALAPPDATA;
  delete process.env.ZAA_ELECTRON;
  process.env.LOCALAPPDATA = mkdtempSync(path.join(tmpdir(), 'zaa-nozcode-'));
  try {
    const r = await chooseRuntime({}, { spawn: async () => { throw new Error('不应被调用'); } });
    assert.equal(r.source, 'node');
    assert.match(r.fallbackReason, /未找到 ZCode\.exe/);
  } finally {
    if (prevE !== undefined) process.env.ZAA_ELECTRON = prevE;
    if (prevL !== undefined) process.env.LOCALAPPDATA = prevL;
  }
});

test('chooseRuntime：验证失败 → 回退 node 并带原因', async () => {
  const r = await chooseRuntime({ electronPath: 'C:\\Z\\ZCode.exe' }, {
    spawn: async (cmd, args) => (args[0] === '-e' ? { code: 1, stdout: '', stderr: 'nope' } : emptySmoke),
  });
  assert.equal(r.source, 'node');
  assert.match(r.fallbackReason, /版本探针失败/);
});

test('chooseRuntime：ZAA_NODE_SOURCE=node 强制回退，不做任何 spawn', async () => {
  const prev = process.env.ZAA_NODE_SOURCE;
  process.env.ZAA_NODE_SOURCE = 'node';
  try {
    let spawned = false;
    const r = await chooseRuntime({ electronPath: 'C:\\Z\\ZCode.exe' }, {
      spawn: async () => (spawned = true, okProbe),
    });
    assert.equal(r.source, 'node');
    assert.equal(r.nodePath, NODE);
    assert.equal(spawned, false);
  } finally {
    if (prev === undefined) delete process.env.ZAA_NODE_SOURCE; else process.env.ZAA_NODE_SOURCE = prev;
  }
});

// —— doInstall（electron 形态）与卸载兼容 ——

test('doInstall：electron 运行时 → 注册带 env 字段；幂等原位更新可在两种形态间切换', () => {
  const p = tmpCfg();
  const r1 = doInstall({ configPath: p, runtime: { source: 'electron', electronPath: 'C:\\Z\\ZCode.exe', nodeVersion: '24.14.0' } });
  assert.equal(r1.updatedInPlace, false);
  assert.equal(r1.nodePath, 'C:\\Z\\ZCode.exe');
  assert.deepEqual(read(p).hooks.events.PermissionRequest[0].hooks[0], {
    type: 'process', command: 'C:\\Z\\ZCode.exe', args: [SCRIPT_PATH],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: 30000, statusMessage: 'auto-approve：模型审批中',
  });
  const r2 = doInstall({ configPath: p, runtime: { source: 'node', nodePath: NODE } });
  assert.equal(r2.updatedInPlace, true);   // args 未变，matcher 仍识别为我们的注册
  assert.equal(r2.nodePath, NODE);
  const hook = read(p).hooks.events.PermissionRequest[0].hooks[0];
  assert.equal(hook.command, NODE);
  assert.equal(hook.env, undefined);       // 回退形态不得残留 env 字段
  assert.equal(read(p).hooks.events.PermissionRequest[0].hooks.length, 1);
});

test('doInstall：未传 runtime/nodePath 时默认 node 兜底（向后兼容旧测试与直调）', () => {
  const p = tmpCfg();
  doInstall({ configPath: p });
  assert.equal(read(p).hooks.events.PermissionRequest[0].hooks[0].command, NODE);
});

test('卸载：electron 形态注册同样按 args 识别并移除', () => {
  const p = tmpCfg();
  doInstall({ configPath: p, runtime: { source: 'electron', electronPath: 'C:\\Z\\ZCode.exe', nodeVersion: '24.14.0' } });
  const r = doUninstall({ configPath: p });
  assert.equal(r.removed, 1);
  assert.equal(read(p).hooks.events, undefined);
});
