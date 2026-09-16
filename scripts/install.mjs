#!/usr/bin/env node
// zcode-auto-approve 安装器：把 PermissionRequest hook 注册进 ZCode 用户级配置。
// 设计：docs/design.md §4.3/§9；ADR-0001（用户级配置 hook）、ADR-0002（解释器绝对路径）、
// ADR-0009（运行时来源：ZCode.exe ELECTRON_RUN_AS_NODE 优先，fnm node 兜底）。
//
// 行为：
// - 目标文件 ~/.zcode/cli/config.json（env ZAA_TARGET_CONFIG 可覆盖，供测试）；
// - 运行时选择（ADR-0009）：env ZAA_NODE_SOURCE=node 强制 fnm node；否则定位 ZCode.exe
//   （env ZAA_ELECTRON > %LOCALAPPDATA%\Programs\ZCode\ZCode.exe），验证通过（版本探针 +
//   deny-path 冒烟，均带 ELECTRON_RUN_AS_NODE=1）才采用，任一步失败回退 fnm node 绝对路径；
// - 已有配置先备份为 config.json.bak-<时间戳>，原内容不可解析则中止不写入；
// - 幂等：已注册则原位更新（改路径/超时后重跑 install 即刷新），不重复注册；
// - hooks.enabled 置 true；检测到其他配置型 hook 时打印提示。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'approve.mjs');

export function targetConfigPath() {
  return process.env.ZAA_TARGET_CONFIG
    ?? path.join(os.homedir(), '.zcode', 'cli', 'config.json');
}

// ADR-0009：定位 ZCode.exe。选项 > env ZAA_ELECTRON > 默认安装路径存在性探测。
export function resolveElectronPath(options = {}) {
  if (options.electronPath) return options.electronPath;
  if (process.env.ZAA_ELECTRON) return process.env.ZAA_ELECTRON;
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const candidate = path.join(localAppData, 'Programs', 'ZCode', 'ZCode.exe');
  return existsSync(candidate) ? candidate : null;
}

function spawnOnce(cmd, args, { env, input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill(); finish({ code: -1, stdout, stderr: `${stderr}（超时 ${timeoutMs}ms）` }); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ code: -1, stdout, stderr: String(e.message ?? e) }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runAsNodeEnv() {
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
}

// ADR-0009：验证 ZCode.exe 的 run-as-node 通道。两道检查都过才采用。
// deps.spawn 可注入供测试；真实实现见 spawnOnce。
export async function verifyElectronRuntime(electronPath, scriptPath, deps = {}) {
  const doSpawn = deps.spawn ?? spawnOnce;

  const probe = await doSpawn(electronPath, ['-e', 'console.log(process.versions.node)'], {
    env: runAsNodeEnv(),
    timeoutMs: deps.timeoutMs ?? 10000,
  });
  const nodeVersion = probe.stdout.trim();
  if (probe.code !== 0 || !/^\d+\./.test(nodeVersion)) {
    return { ok: false, reason: `run-as-node 版本探针失败（exit=${probe.code}，输出=${nodeVersion || '空'}，${probe.stderr.trim()}）` };
  }

  const denyPayload = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
    riskLevel: 'low',
    cwd: os.tmpdir(),
    session_id: 'install-smoke',
  });
  const smoke = await doSpawn(electronPath, [scriptPath], {
    env: runAsNodeEnv(),
    input: denyPayload,
    timeoutMs: deps.timeoutMs ?? 15000,
  });
  if (smoke.code !== 0) {
    return { ok: false, reason: `deny-path 冒烟异常退出（exit=${smoke.code}，${smoke.stderr.trim()}）` };
  }
  if (smoke.stdout.trim() !== '') {
    return { ok: false, reason: `deny-path 冒烟产生了非预期输出（${smoke.stdout.trim().slice(0, 80)}）` };
  }
  return { ok: true, nodeVersion, source: 'electron' };
}

// ADR-0009：运行时选择。返回 {source:'electron', electronPath, nodeVersion} 或 {source:'node', nodePath, fallbackReason?}。
export async function chooseRuntime(options = {}, deps = {}) {
  if ((options.nodeSource ?? process.env.ZAA_NODE_SOURCE) === 'node') {
    return { source: 'node', nodePath: options.nodePath ?? process.execPath };
  }
  const scriptPath = options.scriptPath ?? SCRIPT_PATH;
  const electronPath = options.electronPath ?? resolveElectronPath(options);
  if (!electronPath) {
    return { source: 'node', nodePath: options.nodePath ?? process.execPath, fallbackReason: '未找到 ZCode.exe（可用 env ZAA_ELECTRON 指定）' };
  }
  const v = await verifyElectronRuntime(electronPath, scriptPath, deps);
  if (!v.ok) {
    return { source: 'node', nodePath: options.nodePath ?? process.execPath, fallbackReason: v.reason };
  }
  return { source: 'electron', electronPath, nodeVersion: v.nodeVersion };
}

function stamp(d) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 识别"我们的 hook"：args 里包含 approve.mjs 的绝对路径（两种注册形态通吃）
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

// 注册条目由运行时形态决定（ADR-0009）：
// electron → command=ZCode.exe + env.ELECTRON_RUN_AS_NODE；node → command=node 绝对路径（ADR-0002）。
export function buildHookEntry(runtime, scriptPath) {
  const entry = {
    type: 'process',
    args: [scriptPath],
    timeoutMs: 30000,
    statusMessage: 'auto-approve：模型审批中',
  };
  if (runtime.source === 'electron') {
    return { ...entry, command: runtime.electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { ...entry, command: runtime.nodePath };
}

export function doInstall(options = {}) {
  const configPath = options.configPath ?? targetConfigPath();
  const runtime = options.runtime
    ?? (options.nodePath ? { source: 'node', nodePath: options.nodePath } : { source: 'node', nodePath: process.execPath });
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

  const ourHook = buildHookEntry(runtime, scriptPath);

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

  return { configPath, backupPath, runtime, nodePath: runtime.source === 'electron' ? runtime.electronPath : runtime.nodePath, scriptPath, updatedInPlace, foreignHooks: foreignBefore };
}

function printSummary(r) {
  console.log('✅ zcode-auto-approve 已安装');
  console.log(`   配置文件 : ${r.configPath}${r.backupPath ? `\n   备份     : ${r.backupPath}` : '（新建）'}`);
  if (r.runtime.source === 'electron') {
    console.log(`   运行时   : ZCode.exe（ELECTRON_RUN_AS_NODE，内嵌 node ${r.runtime.nodeVersion}）`);
    console.log(`            : ${r.runtime.electronPath}`);
  } else {
    console.log(`   运行时   : node（ADR-0002 绝对路径）`);
    console.log(`            : ${r.runtime.nodePath}`);
    if (r.runtime.fallbackReason) console.log(`   ⚠️ 未采用 ZCode.exe 路线：${r.runtime.fallbackReason}`);
  }
  console.log(`   脚本     : ${r.scriptPath}`);
  console.log(`   注册     : PermissionRequest / type=process / timeoutMs=30000${r.runtime.source === 'electron' ? ' / env=ELECTRON_RUN_AS_NODE' : ''}${r.updatedInPlace ? '（原位更新已有注册）' : ''}`);
  if (r.foreignHooks > 0) {
    console.log(`   ⚠️ 检测到配置中还有 ${r.foreignHooks} 个其他配置型 hook：hooks.enabled=true 会一并激活它们（安装前请确认这是你想要的）。`);
  }
  console.log('');
  console.log('   下一步：重启 ZCode 客户端后生效。');
  console.log('   验证：让模型跑一条安全命令（如 cd /tmp && ls），应无弹窗；');
  console.log('         审计日志 ~/.zcode/zcode-auto-approve/audit/audit-<日期>.jsonl 应出现 matchedRule=model。');
  if (r.runtime.source === 'electron') {
    console.log('   回退（ADR-0009）：若 ZCode 更新后审批全部变回人工弹窗、或审批时出现异常窗口，');
    console.log('         先重跑本脚本（会自动重新验证）；仍不行则强制回退 fnm node：');
    console.log('         ZAA_NODE_SOURCE=node node scripts/install.mjs');
  } else {
    console.log('   回滚：node scripts/uninstall.mjs，或用备份文件恢复。');
    console.log('   注意：升级/切换 node 版本（fnm）后需重跑本脚本刷新 node 绝对路径。');
  }
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
    const runtime = await chooseRuntime();
    printSummary(doInstall({ runtime }));
  } catch (e) {
    console.error(`❌ 安装失败：${e.message}`);
    process.exitCode = 1;
  }
}
