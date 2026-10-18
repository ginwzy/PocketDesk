const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../web/admin');
function worker(text, name = 'sample.js') {
  const replies = [];
  const scope = { postMessage: m => replies.push(m) };
  scope.self = scope;
  const ctx = vm.createContext(scope);
  scope.importScripts = file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'change-worker.js'), 'utf8'), ctx);
  scope.onmessage({ data: { type: 'init', text, path: name } });
  assert.equal(replies.at(-1).type, 'ready');
  return data => { scope.onmessage({ data: { type: 'page', id: 1, mode: 'unified', ...data } }); return replies.at(-1); };
}
test('real hunk line numbers, inline edits, and escaped source', () => {
  const page = worker('--- a/x.js\n+++ b/x.js\n@@ -10,2 +10,2 @@\n-const value = "<old>";\n+const value = "<new>";\n tail\n');
  const rows = page({}).rows;
  assert.equal(rows[3].old, 10); assert.equal(rows[4].next, 10);
  assert.equal(rows[5].old, 11); assert.equal(rows[5].next, 11);
  assert.match(rows[4].html, /ch-word/); assert.match(rows[4].html, /tok-keyword/);
  assert(!rows[4].html.includes('<new>'));
  const paired = page({ mode: 'split' }).rows[3];
  assert.equal(paired.left.old, 10); assert.equal(paired.right.next, 10);
});
test('tool fragments do not invent file line numbers', () => {
  const rows = worker('@@ 替换片段（未提供行号） @@\n-old\n+new\n context')({}).rows;
  assert.equal(rows[1].old, null); assert.equal(rows[2].next, null);
  assert.equal(rows[3].old, null); assert.equal(rows[3].next, null);
});
test('headers inside a hunk are code, and empty files have no phantom rows', () => {
  const rows = worker('@@ -1 +1 @@\n---counter;\n+++counter;\n')({}).rows;
  assert.equal(rows[1].kind, 'del'); assert.equal(rows[2].kind, 'add');
  assert.equal(worker('')({}).total, 0);
});
test('50,000 rows stay paged; search and next page reach the tail', () => {
  const page = worker('@@ -0,0 +1,50000 @@\n' + Array.from({length: 50000}, (_, i) => '+const item' + i + ' = ' + i + ';').join('\n'));
  const first = page({}); assert.equal(first.total, 50001); assert(first.rows.length <= 160);
  const hit = page({ query: 'item49999', move: 'first-hit' });
  assert.equal(hit.target, 50000); assert.equal(hit.hits, 1); assert(hit.rows.length <= 160);
  assert.match(hit.rows.at(-1).html, /ch-match/);
  assert.equal(page({ anchor: 0, move: 'next-page' }).start, 160);
});
test('split/unified switches preserve the source position', () => {
  const page = worker('@@ -1,3 +1,3 @@\n-a\n-b\n-c\n+A\n+B\n+C\n');
  const result = page({ mode: 'split', fromMode: 'unified', anchor: 5 });
  assert.equal(result.rows.length, 4);
  assert.equal(result.target, 2);
  assert.equal(result.rows[2].right.next, 2);
});
