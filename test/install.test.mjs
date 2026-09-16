// 安装器/卸载器离线测试：全部指向临时目录，绝不触碰真实 ~/.zcode
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { doInstall, SCRIPT_PATH } from '../scripts/install.mjs';
import { doUninstall } from '../scripts/uninstall.mjs';

const NODE = process.execPath;
const tmpCfg = (init) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaa-install-'));
  const p = path.join(dir, 'config.json');
  if (init !== undefined) writeFileSync(p, init);
  return p;
};
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('全新安装：创建配置并注册', () => {
  const p = tmpCfg();
  const r = doInstall({ configPath: p, nodePath: NODE });
  assert.equal(r.updatedInPlace, false);
  assert.equal(r.backupPath, null);
  const cfg = read(p);
  assert.equal(cfg.hooks.enabled, true);
  const groups = cfg.hooks.events.PermissionRequest;
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].hooks[0], {
    type: 'process', command: NODE, args: [SCRIPT_PATH],
    timeoutMs: 30000, statusMessage: 'auto-approve：模型审批中',
  });
});

test('已有配置：保留无关字段并创建备份', () => {
  const original = { provider: { x: { enabled: true } }, somethingElse: [1, 2] };
  const p = tmpCfg(JSON.stringify(original));
  const r = doInstall({ configPath: p, nodePath: NODE });
  assert.ok(r.backupPath && r.backupPath.startsWith(p + '.bak-'));
  assert.equal(readFileSync(r.backupPath, 'utf8'), JSON.stringify(original));
  const cfg = read(p);
  assert.deepEqual(cfg.provider, original.provider);
  assert.deepEqual(cfg.somethingElse, original.somethingElse);
  assert.equal(cfg.hooks.enabled, true);
});

test('幂等：重复安装原位更新，不重复注册', () => {
  const p = tmpCfg();
  doInstall({ configPath: p, nodePath: NODE });
  const r2 = doInstall({ configPath: p, nodePath: 'C:\\fake\\new-node.exe' });
  assert.equal(r2.updatedInPlace, true);
  const cfg = read(p);
  const groups = cfg.hooks.events.PermissionRequest;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hooks.length, 1);
  assert.equal(groups[0].hooks[0].command, 'C:\\fake\\new-node.exe');
});

test('检测到其他配置型 hook 时报告数量（仍正常安装）', () => {
  const original = JSON.stringify({
    hooks: {
      enabled: false,
      events: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
        PermissionRequest: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'y' }] }],
      },
    },
  });
  const p = tmpCfg(original);
  const r = doInstall({ configPath: p, nodePath: NODE });
  assert.equal(r.foreignHooks, 2);
  const cfg = read(p);
  assert.equal(cfg.hooks.events.PreToolUse.length, 1);           // 他人注册原样保留
  assert.equal(cfg.hooks.events.PermissionRequest.length, 2);     // 他组 + 我组
  assert.equal(cfg.hooks.events.PermissionRequest[0].hooks[0].command, 'y');
});

test('目标配置不是合法 JSON → 中止且不修改原文件', () => {
  const bad = '{oops';
  const p = tmpCfg(bad);
  assert.throws(() => doInstall({ configPath: p, nodePath: NODE }), /合法 JSON/);
  assert.equal(readFileSync(p, 'utf8'), bad);
});

test('卸载：移除本项目注册，events 清空后 enabled 还原 false', () => {
  const p = tmpCfg();
  doInstall({ configPath: p, nodePath: NODE });
  const r = doUninstall({ configPath: p });
  assert.equal(r.removed, 1);
  assert.equal(r.restoredEnabled, true);
  const cfg = read(p);
  assert.equal(cfg.hooks.enabled, false);
  assert.equal(cfg.hooks.events, undefined);
});

test('卸载：与他人注册共存时只删自己的', () => {
  const original = JSON.stringify({
    hooks: {
      enabled: true,
      events: {
        PermissionRequest: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'y' }] },
          { hooks: [{ type: 'process', command: NODE, args: [SCRIPT_PATH], timeoutMs: 1 }] },
        ],
      },
    },
  });
  const p = tmpCfg(original);
  const r = doUninstall({ configPath: p });
  assert.equal(r.removed, 1);
  assert.equal(r.restoredEnabled, false); // 未还原（还有其他事件？不——还有 PermissionRequest 里他人的组）
  const cfg = read(p);
  assert.equal(cfg.hooks.enabled, true);  // 其他 hook 仍在，enabled 保持
  assert.equal(cfg.hooks.events.PermissionRequest.length, 1);
  assert.equal(cfg.hooks.events.PermissionRequest[0].hooks[0].command, 'y');
});

test('卸载：同组混合时只删我们的条目', () => {
  const p = tmpCfg();
  doInstall({ configPath: p, nodePath: NODE });
  // 手动往同组塞一个他人 hook
  const cfg = read(p);
  cfg.hooks.events.PermissionRequest[0].hooks.push({ type: 'command', command: 'other' });
  writeFileSync(p, JSON.stringify(cfg));
  const r = doUninstall({ configPath: p });
  assert.equal(r.removed, 1);
  const after = read(p);
  assert.equal(after.hooks.events.PermissionRequest[0].hooks.length, 1);
  assert.equal(after.hooks.events.PermissionRequest[0].hooks[0].command, 'other');
  assert.equal(after.hooks.enabled, true); // 组仍非空
});

test('卸载：未安装/配置缺失时安全无操作', () => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), 'zaa-empty-')), 'none.json');
  assert.equal(doUninstall({ configPath: p }).removed, 0);
  const q = tmpCfg(JSON.stringify({ a: 1 }));
  assert.equal(doUninstall({ configPath: q }).removed, 0);
  assert.deepEqual(read(q), { a: 1 }); // 未改动
});

test('CLI 冒烟：install.mjs 可独立执行（env 指向临时目标）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaa-cli-'));
  const p = path.join(dir, 'config.json');
  const res = spawnSync(NODE, [path.resolve('scripts/install.mjs')], {
    env: { ...process.env, ZAA_TARGET_CONFIG: p },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('已安装'));
  assert.ok(existsSync(p));
  writeFileSync(path.join(dir, 'bad.json'), '{bad');
  const bad2 = spawnSync(NODE, [path.resolve('scripts/install.mjs')], {
    env: { ...process.env, ZAA_TARGET_CONFIG: path.join(dir, 'bad.json') },
    encoding: 'utf8',
  });
  assert.equal(bad2.status, 1);
  assert.ok(bad2.stderr.includes('失败'));
});
