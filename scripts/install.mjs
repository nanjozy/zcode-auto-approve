#!/usr/bin/env node
// zcode-auto-approve 安装器：把 PermissionRequest hook 注册进 ZCode 用户级配置。
// 设计：docs/design.md §4.3/§9；ADR-0001（用户级配置 hook）、ADR-0002（node 绝对路径）。
//
// 行为：
// - 目标文件 ~/.zcode/cli/config.json（env ZAA_TARGET_CONFIG 可覆盖，供测试）；
// - 已有配置先备份为 config.json.bak-<时间戳>，原内容不可解析则中止不写入；
// - 幂等：已注册则原位更新（改路径/超时后重跑 install 即刷新），不重复注册；
// - hooks.enabled 置 true；检测到其他配置型 hook 时打印提示；
// - 注册形态：type=process + node 绝对路径 + 脚本绝对路径，规避 fnm PATH 问题。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'approve.mjs');

export function targetConfigPath() {
  return process.env.ZAA_TARGET_CONFIG
    ?? path.join(os.homedir(), '.zcode', 'cli', 'config.json');
}

function stamp(d) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 识别"我们的 hook"：args 里包含 approve.mjs 的绝对路径
function isOurHook(scriptPath) {
  return (hook) => Array.isArray(hook?.args)
    && hook.args.some((a) => typeof a === 'string' && path.resolve(a) === path.resolve(scriptPath));
}

function countForeignHooks(events, eventName, matcher) {
  let n = 0;
  for (const [name, groups] of Object.entries(events ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g?.hooks ?? []) {
        if (name === eventName && matcher(h)) continue;
        n++;
      }
    }
  }
  return n;
}

export function doInstall(options = {}) {
  const configPath = options.configPath ?? targetConfigPath();
  const nodePath = options.nodePath ?? process.execPath;
  const scriptPath = options.scriptPath ?? SCRIPT_PATH;
  const now = options.now ?? (() => new Date());

  let originalText = null;
  if (existsSync(configPath)) {
    originalText = readFileSync(configPath, 'utf8');
  }
  let cfg = {};
  if (originalText !== null && originalText.trim() !== '') {
    try {
      cfg = JSON.parse(originalText);
    } catch {
      throw new Error(`目标配置不是合法 JSON，已中止（未做任何修改）：${configPath}`);
    }
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
      throw new Error(`目标配置顶层不是 JSON 对象，已中止（未做任何修改）：${configPath}`);
    }
  }

  const ourHook = {
    type: 'process',
    command: nodePath,
    args: [scriptPath],
    timeoutMs: 30000,
    statusMessage: 'auto-approve：模型审批中',
  };

  cfg.hooks ??= {};
  const hooks = cfg.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    throw new Error('配置中的 hooks 字段不是对象，已中止（未做任何修改）');
  }
  hooks.events ??= {};
  const groups = Array.isArray(hooks.events.PermissionRequest) ? hooks.events.PermissionRequest : [];

  const matcher = isOurHook(scriptPath);
  const foreignBefore = countForeignHooks(hooks.events, 'PermissionRequest', matcher);

  let updatedInPlace = false;
  for (const g of groups) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) continue;
    const idx = g.hooks.findIndex(matcher);
    if (idx !== -1) {
      g.hooks[idx] = ourHook;
      updatedInPlace = true;
      break;
    }
  }
  if (!updatedInPlace) groups.push({ hooks: [ourHook] });
  hooks.events.PermissionRequest = groups;
  hooks.enabled = true;

  let backupPath = null;
  if (originalText !== null && originalText.trim() !== '') {
    backupPath = `${configPath}.bak-${stamp(now())}`;
    copyFileSync(configPath, backupPath);
  }

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  return { configPath, backupPath, nodePath, scriptPath, updatedInPlace, foreignHooks: foreignBefore };
}

function printSummary(r) {
  console.log('✅ zcode-auto-approve 已安装');
  console.log(`   配置文件 : ${r.configPath}${r.backupPath ? `\n   备份     : ${r.backupPath}` : '（新建）'}`);
  console.log(`   node     : ${r.nodePath}`);
  console.log(`   脚本     : ${r.scriptPath}`);
  console.log(`   注册     : PermissionRequest / type=process / timeoutMs=30000${r.updatedInPlace ? '（原位更新已有注册）' : ''}`);
  if (r.foreignHooks > 0) {
    console.log(`   ⚠️ 检测到配置中还有 ${r.foreignHooks} 个其他配置型 hook：hooks.enabled=true 会一并激活它们（安装前请确认这是你想要的）。`);
  }
  console.log('');
  console.log('   下一步：重启 ZCode 客户端后生效。');
  console.log('   验证：让模型跑一条安全命令（如 cd /tmp && ls），应无弹窗；');
  console.log('         审计日志 ~/.zcode/zcode-auto-approve/audit/audit-<日期>.jsonl 应出现 matchedRule=model。');
  console.log('   回滚：node scripts/uninstall.mjs，或用备份文件恢复。');
  console.log('   注意：升级/切换 node 版本（fnm）后需重跑本脚本刷新 node 绝对路径。');
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

if (isMainModule()) {
  try {
    printSummary(doInstall());
  } catch (e) {
    console.error(`❌ 安装失败：${e.message}`);
    process.exitCode = 1;
  }
}
