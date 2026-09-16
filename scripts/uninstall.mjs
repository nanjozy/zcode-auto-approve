#!/usr/bin/env node
// zcode-auto-approve 卸载器：从 ZCode 用户级配置中移除本项目的 hook 注册。
// 设计：docs/design.md §9——只删自己的注册项；events 清空后把 hooks.enabled
// 还原为 false 并打印说明（若你安装前就有其他 hook 且 enabled 本为 true，
// 请自行改回或用安装备份恢复）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { SCRIPT_PATH, targetConfigPath } from './install.mjs';

function isOurHook(scriptPath) {
  return (hook) => Array.isArray(hook?.args)
    && hook.args.some((a) => typeof a === 'string' && path.resolve(a) === path.resolve(scriptPath));
}

export function doUninstall(options = {}) {
  const configPath = options.configPath ?? targetConfigPath();
  const scriptPath = options.scriptPath ?? SCRIPT_PATH;

  if (!existsSync(configPath)) {
    return { configPath, removed: 0, message: '配置文件不存在，无需卸载' };
  }
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  if (cfg === null || typeof cfg !== 'object') {
    return { configPath, removed: 0, message: '配置顶层不是对象，未做修改' };
  }
  const hooks = cfg.hooks;
  if (typeof hooks !== 'object' || hooks === null || !Array.isArray(hooks.events?.PermissionRequest)) {
    return { configPath, removed: 0, message: '未找到本项目注册（无 PermissionRequest 事件）' };
  }

  const matcher = isOurHook(scriptPath);
  let removed = 0;
  const keptGroups = [];
  for (const g of hooks.events.PermissionRequest) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) { keptGroups.push(g); continue; }
    const ours = g.hooks.filter(matcher);
    const rest = g.hooks.filter((h) => !matcher(h));
    removed += ours.length;
    if (rest.length > 0) keptGroups.push({ ...g, hooks: rest });
  }

  if (removed === 0) {
    return { configPath, removed: 0, message: '未找到本项目注册' };
  }

  let restoredEnabled = false;
  if (keptGroups.length === 0) {
    delete hooks.events.PermissionRequest;
    if (Object.keys(hooks.events).length === 0) {
      delete hooks.events;
      hooks.enabled = false; // design §9：无任何事件时还原总开关
      restoredEnabled = true;
    }
  } else {
    hooks.events.PermissionRequest = keptGroups;
  }

  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { configPath, removed, restoredEnabled };
}

function printSummary(r) {
  if (r.removed === 0) {
    console.log(`ℹ️ ${r.message ?? '未做修改'}（${r.configPath}）`);
    return;
  }
  console.log('✅ zcode-auto-approve 已卸载');
  console.log(`   配置文件 : ${r.configPath}`);
  console.log(`   移除注册 : ${r.removed} 处`);
  if (r.restoredEnabled) {
    console.log('   hooks.enabled 已还原为 false（events 已空）。');
    console.log('   若你安装前就配置过其他 hook 且需要 enabled=true，请自行改回或用安装备份恢复。');
  }
  console.log('   生效需重启 ZCode 客户端。审计日志与判定缓存未删除，可手动清理 ~/.zcode/zcode-auto-approve/。');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const a = path.resolve(process.argv[1]);
    const b = fileURLToPath(import.meta.url);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMainModule()) printSummary(doUninstall());
