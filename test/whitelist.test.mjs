// 白名单匹配语义（design.md §6.3）与参数/目标守卫（M2 修订）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { decide, effectiveCommand, collectSpecs } from '../src/approve.mjs';
import { RULES, WS, makePayload } from './helpers.mjs';

const run = (command) => decide({ ...makePayload(), tool_input: { command } }, RULES);

test('裸命令规格：命令字匹配则任意参数放行', () => {
  assert.equal(run('ls -la --color=auto /usr').action, 'approve');
});

test('命令字大小写敏感', () => {
  assert.equal(run('LS').action, 'passthrough');
  assert.equal(run('LS').reasonCode, 'no-match');
});

test('路径形式不匹配（./git ≠ git）', () => {
  assert.equal(run('./git status').action, 'passthrough');
});

test('二级子命令规格：git status 匹配，git 其他子命令不匹配', () => {
  assert.equal(run('git status -s').action, 'approve');
  assert.equal(run('git stash').action, 'approve'); // git stash 在 safework 里
  const r = decide({ ...makePayload(), tool_input: { command: 'git bisect' } }, RULES);
  assert.equal(r.reasonCode, 'no-match'); // git + 未知子命令
});

test('只有命令字没有子命令时，二级规格不匹配', () => {
  // 单独 git 不在任何规格里（只有 git status 等二级规格）
  const r = decide({ ...makePayload(), tool_input: { command: 'git' } }, RULES);
  assert.equal(r.reasonCode, 'no-match');
});

test('rg:* 显式通配写法等价于 rg', () => {
  assert.equal(run('rg pattern -i').action, 'approve');
});

test('引号拼接的命令字按拼接后语义匹配', () => {
  assert.equal(run('gi"t" status').action, 'approve');
});

test('环境变量赋值前缀被剥离', () => {
  assert.equal(run('FOO=bar NODE_ENV=test npm test').action, 'approve');
});

test('env 命令解析出真实命令', () => {
  assert.equal(run('env FOO=1 ls').action, 'approve');
});

test('裸 env 视为只读命令本身', () => {
  assert.equal(run('env').action, 'approve');
});

test('env -i sh 解析出 sh，不在白名单', () => {
  const r = run('env -i sh');
  assert.equal(r.reasonCode, 'no-match');
});

test('effectiveCommand：env 跳过 flag 与赋值', () => {
  const e1 = effectiveCommand(['env', '-i', 'npm', 'test']);
  assert.equal(e1.cmd, 'npm');
  const e2 = effectiveCommand(['env', 'FOO=1']);
  assert.equal(e2.cmd, 'env'); // env 后全是赋值 → 裸 env
  const e3 = effectiveCommand(['A=1', 'B=2', 'ls']);
  assert.equal(e3.cmd, 'ls');
});

test('collectSpecs 去除 :* 后缀', () => {
  const specs = collectSpecs(
    { bashGroups: { g: ['rg', 'rg:*', 'git status', ''] } },
    { bashGroups: ['g'] },
  );
  assert.deepEqual(specs.map((s) => s.parts), [['rg'], ['rg'], ['git', 'status']]);
});

// ---- M2 参数守卫（argGuards）----

test('node -e 任意代码被参数守卫拦截', () => {
  assert.equal(run('node -e "process.exit(1)"').reasonCode, 'no-match');
});

test('node --eval=code 的等号形式被拦截', () => {
  assert.equal(run('node --eval=code').reasonCode, 'no-match');
});

test('node script.js 正常放行', () => {
  assert.equal(run('node scripts/install.mjs').action, 'approve');
});

test('python -c 被拦截，python script.py 放行', () => {
  assert.equal(run('python -c "print(1)"').reasonCode, 'no-match');
  assert.equal(run('python tools/x.py').action, 'approve');
});

test('find -exec / -execdir 被前缀守卫拦截', () => {
  assert.equal(run('find . -exec rm {} ;').reasonCode, 'no-match');
  assert.equal(run('find . -execdir cat {} ;').reasonCode, 'no-match');
});

test('find -delete 被拦截', () => {
  assert.equal(run('find / -name x -delete').reasonCode, 'no-match');
});

test('find -name 正常放行', () => {
  assert.equal(run("find . -name '*.ts'").action, 'approve');
});

test('rg --pre 与 --pre=cmd 均被拦截', () => {
  assert.equal(run('rg x --pre cat').reasonCode, 'no-match');
  assert.equal(run('rg x --pre=cat').reasonCode, 'no-match');
});

// ---- M2 目标路径守卫（cp/mv）----

test('cp 目标在 workspace 内放行', () => {
  assert.equal(run('cp a.txt b.txt').action, 'approve');
  assert.equal(run('cp a.txt sub/dir/').action, 'approve');
});

test('cp 目标为绝对路径且在 workspace 外被拦截（引号保留反斜杠）', () => {
  const outsideFile = path.resolve(path.resolve(WS, '..'), 'x.txt');
  assert.equal(run(`cp a.txt '${outsideFile}'`).reasonCode, 'path-outside-workspace');
});

test('mv 目标 .. 相对路径逃出 workspace 被拦截', () => {
  assert.equal(run('mv x ../y').reasonCode, 'path-outside-workspace');
});

test('mv 相对目标在 workspace 内放行', () => {
  assert.equal(run('mv draft.md final.md').action, 'approve');
});
