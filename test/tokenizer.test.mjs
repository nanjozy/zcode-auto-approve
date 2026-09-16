// 分词器黄金用例：引号、转义、顶层操作符、重定向、注释（安全网分段 deny 匹配依赖，见 design.md §5.1）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, splitSegments } from '../src/approve.mjs';

const words = (tokens) => tokens.filter((t) => t.type === 'word').map((t) => t.text);
const ops = (tokens) => tokens.filter((t) => t.type === 'op').map((t) => t.text);
const redirects = (tokens) => tokens.filter((t) => t.type === 'redirect');

test('普通词与参数', () => {
  assert.deepEqual(words(tokenize('ls -la src/')), ['ls', '-la', 'src/']);
});

test('双引号内的 && 不切分', () => {
  const t = tokenize('echo "a && b"');
  assert.deepEqual(words(t), ['echo', 'a && b']);
  assert.deepEqual(ops(t), []);
});

test('单引号内的 ; 不切分', () => {
  assert.deepEqual(words(tokenize("echo 'x;y'")), ['echo', 'x;y']);
});

test('顶层操作符全部识别', () => {
  assert.deepEqual(ops(tokenize('a && b || c ; d | e')), ['&&', '||', ';', '|']);
});

test('换行是操作符', () => {
  assert.deepEqual(ops(tokenize('a\nb')), ['\n']);
});

test('输入重定向与输出重定向各带目标', () => {
  const r = redirects(tokenize('cat < in.txt > out.log'));
  assert.equal(r.length, 2);
  assert.equal(r[0].op, '<');
  assert.equal(r[0].target, 'in.txt');
  assert.equal(r[1].op, '>');
  assert.equal(r[1].target, 'out.log');
});

test('追加重定向 >>', () => {
  const r = redirects(tokenize('echo hi >> log.txt'));
  assert.equal(r[0].op, '>>');
  assert.equal(r[0].target, 'log.txt');
});

test('fd 复制 2>&1 识别为带 & 前缀目标', () => {
  const t = tokenize('cmd 2>&1');
  const r = redirects(t);
  assert.equal(r.length, 1);
  assert.equal(r[0].op, '>');
  assert.equal(r[0].target, '&1');
});

test('&> 同时重定向 stdout+stderr', () => {
  const r = redirects(tokenize('cmd &> all.log'));
  assert.equal(r[0].op, '&>');
  assert.equal(r[0].target, 'all.log');
});

test('注释被跳过', () => {
  assert.deepEqual(words(tokenize('ls # trailing comment')), ['ls']);
});

test('转义空格合并进同一个词', () => {
  assert.deepEqual(words(tokenize('a\\ b c')), ['a b', 'c']);
});

test('双引号内的转义仅对 " $ ` \\ 生效', () => {
  assert.deepEqual(words(tokenize('echo "a\\nb"')), ['echo', 'a\\nb']); // \n 字面保留
  assert.deepEqual(words(tokenize('echo "a\\"b"')), ['echo', 'a"b']);
});

test('未闭合引号标记 unterminated', () => {
  const t = tokenize("echo it's");
  const w = t.filter((x) => x.type === 'word');
  assert.equal(w[1].unterminated, true);
});

test('括号作为操作符（子壳内容仍会被逐段分析）', () => {
  const t = tokenize('(git status)');
  assert.deepEqual(ops(t), ['(', ')']);
  assert.deepEqual(words(t), ['git', 'status']);
});

test('按顶层操作符切段，引号内的不切', () => {
  const segs = splitSegments(tokenize('ls && echo "x && y" ; git status'));
  assert.equal(segs.length, 3);
  assert.deepEqual(words(segs[1]), ['echo', 'x && y']);
});

test('heredoc 标记 << 在分词层也可达（主流程由预扫描拦截）', () => {
  const r = redirects(tokenize('cat <<EOF'));
  assert.equal(r[0].op, '<<');
});
