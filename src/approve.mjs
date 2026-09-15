#!/usr/bin/env node
// zcode-auto-approve — ZCode PermissionRequest hook（M2 实现）
// 协议与设计见 docs/design.md。失败语义（design.md §7.2）：
// 任何异常、超时、规则损坏都退回人工审批（空 stdout + exit 0），永不 deny。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const APPROVE_OUTPUT = '{"decision":"approve"}';
const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'ApplyPatch']);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PIPED_INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'python', 'python2', 'python3', 'node', 'deno', 'bun',
  'perl', 'ruby', 'php', 'lua', 'pwsh', 'powershell', 'cmd',
]);
const DECODE_CMDS = new Set(['base64', 'xxd', 'openssl']);
const DECODE_FLAGS = new Set(['-d', '-D', '--decode', '-r']);
const SHELL_META_CMDS = new Set(['eval', 'source', '.', 'exec']);
const DEST_GUARD_CMDS = new Set(['cp', 'mv']); // 白名单内可写文件外部的命令，目标路径须留在 workspace 内
const MAX_LOGGED_COMMAND = 1000;
const IS_WIN = process.platform === 'win32';

// ---------- 正则缓存 ----------

const reCache = new Map();
function reMatches(text, pattern, flags = 'i') {
  if (typeof text !== 'string') return false;
  const key = flags + ':' + pattern;
  let re = reCache.get(key);
  if (re === undefined) {
    try { re = new RegExp(pattern, flags); } catch { re = null; }
    reCache.set(key, re);
  }
  return re !== null && re.test(text);
}

export function denyMatch(text, patterns) {
  return patterns.some((p) => reMatches(text, p, 'i'));
}

// ---------- 分词器（引号感知，不调用任何 shell） ----------

export function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\n') { tokens.push({ type: 'op', text: '\n' }); i++; continue; }
    if (c === '#') { while (i < n && input[i] !== '\n') i++; continue; }
    if (c === '&' && input[i + 1] === '&') { tokens.push({ type: 'op', text: '&&' }); i += 2; continue; }
    if (c === '|' && input[i + 1] === '|') { tokens.push({ type: 'op', text: '||' }); i += 2; continue; }
    if (c === ';') { tokens.push({ type: 'op', text: ';' }); i++; continue; }
    if (c === '|') { tokens.push({ type: 'op', text: '|' }); i++; continue; }
    if (c === '(' || c === ')') { tokens.push({ type: 'op', text: c }); i++; continue; }
    if (c === '<' || c === '>' || (c === '&' && input[i + 1] === '>')) { i = readRedirect(input, i, tokens); continue; }
    if (c === '&') { tokens.push({ type: 'op', text: '&' }); i++; continue; }
    const w = scanWord(input, i);
    tokens.push({ type: 'word', text: w.text, unterminated: !w.closed });
    i = w.next;
  }
  return tokens;
}

function scanWord(input, start) {
  const n = input.length;
  let i = start;
  let text = '';
  let closed = true;
  while (i < n) {
    const ch = input[i];
    if (ch === "'") {
      i++;
      let q = false;
      while (i < n) {
        if (input[i] === "'") { q = true; i++; break; }
        text += input[i++];
      }
      if (!q) closed = false;
    } else if (ch === '"') {
      i++;
      let q = false;
      while (i < n) {
        const d = input[i];
        if (d === '"') { q = true; i++; break; }
        if (d === '\\' && i + 1 < n && '"$`\\'.includes(input[i + 1])) { text += input[i + 1]; i += 2; }
        else { text += d; i++; }
      }
      if (!q) closed = false;
    } else if (ch === '\\') {
      if (i + 1 < n) { text += input[i + 1]; i += 2; } else { text += ch; i++; }
    } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ';|&<>()'.includes(ch)) {
      break;
    } else {
      text += ch; i++;
    }
  }
  return { text, next: i, closed };
}

function readRedirect(input, i, tokens) {
  const n = input.length;
  let j = i;
  let op;
  if (input[j] === '<') {
    j++;
    if (j < n && input[j] === '<') { op = '<<'; j++; } else { op = '<'; }
  } else if (input[j] === '&') { // &> / &>>
    j += 2; op = '&>';
    if (j < n && input[j] === '>') { op = '&>>'; j++; }
  } else { // > / >>
    j++;
    if (j < n && input[j] === '>') { op = '>>'; j++; } else { op = '>'; }
  }
  let target = null;
  while (j < n && (input[j] === ' ' || input[j] === '\t')) j++;
  if (j < n && input[j] === '&') { // fd 复制：2>&1
    j++;
    const w = scanWord(input, j);
    target = '&' + w.text;
    j = w.next;
  } else if (j < n && input[j] !== '>' && input[j] !== '<') {
    const w = scanWord(input, j);
    target = w.text || null;
    j = w.next;
  }
  tokens.push({ type: 'redirect', op, target });
  return j;
}

export function splitSegments(tokens) {
  const segs = [];
  let cur = [];
  for (const t of tokens) {
    if (t.type === 'op') {
      if (cur.length) { segs.push(cur); cur = []; }
    } else {
      cur.push(t);
    }
  }
  if (cur.length) segs.push(cur);
  return segs;
}

function segText(seg) {
  return seg
    .map((t) => (t.type === 'word' ? t.text : t.type === 'redirect' ? `${t.op} ${t.target ?? ''}` : ''))
    .filter(Boolean)
    .join(' ');
}

// ---------- 不可静态分析结构（design.md §6.2） ----------

export function findUnanalyzable(command) {
  if (command.includes('$(')) return 'command-substitution';
  if (command.includes('`')) return 'backtick';
  if (command.includes('<<')) return 'heredoc';
  if (command.includes('<(') || command.includes('>(')) return 'process-substitution';
  return null;
}

function pipedInterpreter(tokens) {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'op' && t.text === '|') {
      const nx = tokens[k + 1];
      if (nx && nx.type === 'word' && PIPED_INTERPRETERS.has(nx.text)) return nx.text;
    }
  }
  return null;
}

function segmentUnanalyzable(seg) {
  if (seg.some((t) => t.type === 'redirect' && t.op === '<<')) return 'heredoc';
  const words = seg.filter((t) => t.type === 'word').map((t) => t.text);
  const { cmd, args } = effectiveCommand(words);
  if (SHELL_META_CMDS.has(cmd)) return 'eval-source-exec';
  if (DECODE_CMDS.has(cmd) && args.some((a) => DECODE_FLAGS.has(a))) return 'decode-pipe';
  return null;
}

// ---------- 白名单匹配（design.md §6.3） ----------

export function effectiveCommand(words) {
  let i = 0;
  while (i < words.length && ASSIGN_RE.test(words[i])) i++; // 环境变量前缀
  let cmdIdx = i;
  if (words[i] === 'env') {
    let j = i + 1;
    while (j < words.length && (words[j].startsWith('-') || ASSIGN_RE.test(words[j]))) j++;
    if (j < words.length) cmdIdx = j; // env 后面的真实命令
  }
  return {
    cmd: words[cmdIdx] ?? '',
    sub: words[cmdIdx + 1] ?? null,
    args: words.slice(cmdIdx + 1),
    cmdIdx,
  };
}

export function collectSpecs(rules, profile) {
  const out = [];
  for (const g of profile.bashGroups ?? []) {
    for (const spec of rules.bashGroups?.[g] ?? []) {
      const parts = spec.split(/\s+/).map((p) => (p.endsWith(':*') ? p.slice(0, -2) : p)).filter(Boolean);
      if (parts.length >= 1) out.push({ group: g, spec, parts });
    }
  }
  return out;
}

function argFlagBlocked(args, guards) {
  if (!Array.isArray(guards)) return false;
  return guards.some((g) => {
    if (g.endsWith('*')) {
      const pre = g.slice(0, -1);
      return args.some((a) => a.startsWith(pre));
    }
    return args.some((a) => a === g || a.startsWith(g + '='));
  });
}

function destOutside(args, cwd) {
  return args.some((a) => {
    if (a.startsWith('~')) return true;
    if (/^[a-zA-Z]:[\\/]/.test(a) || a.startsWith('/') || a.startsWith('\\') || a.startsWith('..')) {
      if (a === '/dev/null') return false;
      return !isWithin(path.resolve(cwd, a), cwd);
    }
    return false;
  });
}

function isWithin(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  const [a, b] = IS_WIN ? [c.toLowerCase(), p.toLowerCase()] : [c, p];
  return a === b || a.startsWith(b + path.sep);
}

export function analyzeSegment(seg, specs, argGuards, cwd) {
  // 1) 重定向护栏（§6.4）——独立于白名单，先判
  for (const t of seg) {
    if (t.type !== 'redirect') continue;
    if (!['>', '>>', '&>', '&>>'].includes(t.op)) continue; // '<' 只读；'<<' 已按 unanalyzable 处理
    const target = t.target;
    if (target === null) return { ok: false, reason: 'unanalyzable' }; // "xxx >" 语法不完整
    if (/^&\d+$/.test(target)) continue; // fd 复制（2>&1）
    if (['/dev/null', 'nul'].includes(target.toLowerCase())) continue;
    if (target.startsWith('~')) return { ok: false, reason: 'redirect-outside' };
    if (!isWithin(path.resolve(cwd, target), cwd)) return { ok: false, reason: 'redirect-outside' };
  }

  // 2) 白名单（§6.3）
  const words = seg.filter((t) => t.type === 'word').map((t) => t.text);
  const { cmd, cmdIdx } = effectiveCommand(words);
  if (!cmd) return { ok: false, reason: 'no-match' };
  for (const { group, spec, parts } of specs) {
    if (parts[0] !== cmd) continue;
    let prefixOk = true;
    for (let k = 1; k < parts.length; k++) {
      if (words[cmdIdx + k] !== parts[k]) { prefixOk = false; break; }
    }
    if (!prefixOk) continue;
    const guardArgs = words.slice(cmdIdx + parts.length);
    if (argFlagBlocked(guardArgs, argGuards[cmd])) continue; // 如 node -e：此规格失效，落回直通
    if (DEST_GUARD_CMDS.has(cmd) && destOutside(guardArgs, cwd)) {
      return { ok: false, reason: 'path-outside-workspace' };
    }
    return { ok: true, matched: `${group}:${spec}` };
  }
  return { ok: false, reason: 'no-match' };
}

// ---------- 决策主流程（design.md §5.1，顺序固定） ----------

const pass = (reasonCode) => ({ action: 'passthrough', reasonCode });
const approve = (matchedRule) => ({ action: 'approve', matchedRule });

export function decide(payload, rules) {
  try {
    if (payload === null || typeof payload !== 'object' || payload.hook_event_name !== 'PermissionRequest') {
      return pass('event-mismatch');
    }
    const profile = rules?.profiles?.[rules.activeProfile];
    if (!profile) return pass('error');
    const toolName = payload.tool_name ?? payload.toolName;
    const toolInput = payload.tool_input ?? payload.toolInput;
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const guards = rules.guards ?? {};

    // 1. workspace 禁用
    for (const ws of guards.disabledWorkspaces ?? []) {
      if (isWithin(cwd, ws)) return pass('workspace-disabled');
    }

    // 2. 工具黑名单
    const denyTools = rules.deny?.tools ?? [];
    if (denyTools.some((re) => reMatches(toolName, re, 'i'))) return pass('deny-tool');

    // 3. Bash：不可分析结构 → 黑名单
    let bashSegments = null;
    if (toolName === 'Bash') {
      const command = toolInput && typeof toolInput.command === 'string' ? toolInput.command : null;
      if (command === null) return pass('no-command');
      const una = findUnanalyzable(command);
      if (una) return pass('unanalyzable');
      const tokens = tokenize(command);
      if (tokens.some((t) => t.type === 'word' && t.unterminated)) return pass('unanalyzable');
      if (pipedInterpreter(tokens)) return pass('unanalyzable');
      bashSegments = splitSegments(tokens);
      if (bashSegments.length === 0) return pass('no-match');
      for (const seg of bashSegments) {
        const u = segmentUnanalyzable(seg);
        if (u) return pass('unanalyzable');
      }
      const denyPatterns = rules.deny?.patterns ?? [];
      if (denyMatch(command, denyPatterns) || bashSegments.some((s) => denyMatch(segText(s), denyPatterns))) {
        return pass('deny-pattern');
      }
    }

    // 4. riskLevel 护栏（未知/缺失一律不放行）
    const maxRisk = profile.maxRiskLevel ?? guards.maxRiskLevel ?? 'low';
    const riskVal = RISK_ORDER[payload.riskLevel];
    if (riskVal === undefined || riskVal > (RISK_ORDER[maxRisk] ?? 0)) return pass('risk-level');

    // 5/6. Bash：逐段白名单
    if (toolName === 'Bash') {
      const specs = collectSpecs(rules, profile);
      const argGuards = rules.argGuards ?? {};
      const matched = [];
      for (const seg of bashSegments) {
        const r = analyzeSegment(seg, specs, argGuards, cwd);
        if (!r.ok) return pass(r.reason);
        matched.push(r.matched);
      }
      return approve(matched.join(' + '));
    }

    // 7. 文件写：workspace 路径护栏（§5.4）
    if (FILE_EDIT_TOOLS.has(toolName)) {
      if (profile.fileEdits?.pathPolicy === 'workspace-only') {
        const fp = toolInput && typeof toolInput === 'object'
          ? (toolInput.file_path ?? toolInput.path ?? toolInput.filePath) : null;
        if (typeof fp !== 'string' || !fp.trim()) return pass('no-match');
        if (fp.startsWith('~')) return pass('path-outside-workspace');
        if (!isWithin(path.resolve(cwd, fp), cwd)) return pass('path-outside-workspace');
        return approve('fileEdits:workspace-only');
      }
      return pass('no-match');
    }

    // 5. 其余工具白名单
    if ((profile.tools ?? []).includes(toolName)) return approve(`profile.tools:${toolName}`);
    return pass('no-match');
  } catch {
    return pass('error');
  }
}

// ---------- 规则加载（损坏即抛错，由 runHook 退回直通） ----------

export function loadRules(explicitPath) {
  const p = explicitPath
    ?? process.env.ZCODE_AUTO_APPROVE_RULES
    ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rules.json');
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  if (raw?.version !== 1) throw new Error(`unsupported rules version: ${raw?.version}`);
  const profile = raw.profiles?.[raw.activeProfile];
  if (!profile) throw new Error(`unknown activeProfile: ${raw.activeProfile}`);
  if (RISK_ORDER[profile.maxRiskLevel] === undefined) throw new Error(`profile ${raw.activeProfile}: bad maxRiskLevel`);
  if (typeof raw.bashGroups !== 'object' || raw.bashGroups === null) throw new Error('bashGroups missing');
  for (const g of profile.bashGroups ?? []) {
    if (!Array.isArray(raw.bashGroups[g])) throw new Error(`bashGroups.${g} missing`);
  }
  if (!Array.isArray(raw.deny?.patterns) || !Array.isArray(raw.deny?.tools)) throw new Error('deny missing');
  return raw;
}

// ---------- 审计日志（design.md §8） ----------

export function buildEntry(payload, result) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const tool = p.tool_name ?? p.toolName ?? null;
  const ti = p.tool_input ?? p.toolInput;
  const entry = {
    ts: new Date().toISOString(),
    decision: result.action === 'approve' ? 'approve' : 'passthrough',
    tool,
    riskLevel: typeof p.riskLevel === 'string' ? p.riskLevel : null,
    command: null,
    target: null,
    matchedRule: result.action === 'approve' ? (result.matchedRule ?? null) : null,
    reasonCode: result.action === 'approve' ? null : (result.reasonCode ?? 'unknown'),
    cwd: typeof p.cwd === 'string' ? p.cwd : null,
    sessionId: p.session_id ?? p.sessionId ?? null,
  };
  if (tool === 'Bash') {
    if (ti && typeof ti.command === 'string') {
      entry.command = ti.command.length > MAX_LOGGED_COMMAND
        ? ti.command.slice(0, MAX_LOGGED_COMMAND) + '…[truncated]'
        : ti.command;
    }
  } else if (ti && typeof ti === 'object') {
    const fp = ti.file_path ?? ti.path ?? ti.filePath;
    if (typeof fp === 'string') entry.target = fp;
  }
  return entry;
}

function auditLogPath(now = new Date()) {
  const dir = process.env.ZCODE_AUTO_APPROVE_LOG_DIR
    ?? path.join(os.homedir(), '.zcode', 'zcode-auto-approve', 'audit');
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(dir, `audit-${stamp}.jsonl`);
}

function defaultAudit(entry) {
  try {
    const file = auditLogPath();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    try { process.stderr.write('zcode-auto-approve: audit write failed\n'); } catch { /* 忽略 */ }
  }
}

function safeAudit(fn, entry) {
  try { fn(entry); } catch { /* 审计失败不影响决策 */ }
}

// ---------- hook 入口（可注入依赖，便于测试） ----------

export function runHook(rawStdin, deps = {}) {
  const loadRulesFn = deps.loadRules ?? loadRules;
  const auditFn = deps.audit ?? defaultAudit;

  let payload = null;
  try { payload = JSON.parse(rawStdin); } catch { payload = null; }
  if (payload === null || typeof payload !== 'object') {
    safeAudit(auditFn, buildEntry(null, pass('bad-stdin')));
    return { stdout: '' };
  }

  let rules = null;
  try { rules = loadRulesFn(); } catch { rules = null; }
  if (rules === null) {
    safeAudit(auditFn, buildEntry(payload, pass('error')));
    return { stdout: '' };
  }

  const result = decide(payload, rules);
  safeAudit(auditFn, buildEntry(payload, result));
  return { stdout: result.action === 'approve' ? APPROVE_OUTPUT : '' };
}

// ---------- CLI ----------

function readAllStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const a = path.resolve(process.argv[1]);
    const b = fileURLToPath(import.meta.url);
    return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

async function main() {
  try {
    const raw = await readAllStdin();
    const { stdout } = runHook(raw);
    if (stdout) process.stdout.write(stdout + '\n');
  } catch {
    /* 任何异常都静默直通（fail-safe） */
  }
  process.exitCode = 0;
}

if (isMainModule()) main();
