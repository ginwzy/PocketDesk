const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function worker(text) {
  const replies = [], scope = { postMessage: m => replies.push(m) };
  scope.self = scope;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/admin/change-worker.js'), 'utf8'), scope);
  scope.onmessage({ data: { type: 'init', text } });
  return { ready: replies.at(-1), page: start => { scope.onmessage({ data: { type: 'page', start } }); return replies.at(-1); } };
}
test('unified hunks preserve line numbers and escape source, without file headers', () => {
  const result = worker('--- a/x.js\n+++ b/x.js\n@@ -10,2 +10,2 @@\n-const value = "<old>";\n+const value = "<new>";\n tail\n').page(0);
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[1].old, 10); assert.equal(result.rows[2].next, 10);
  assert.equal(result.rows[3].old, 11); assert.equal(result.rows[3].next, 11);
  assert.match(result.rows[2].html, /&lt;new&gt;/);
});
test('tool fragments do not invent line numbers; headers inside hunks remain code', () => {
  const rows = worker('@@ 替换片段（未提供行号） @@\n---counter;\n+++counter;\n context').page(0).rows;
  assert.equal(rows[1].kind, 'del'); assert.equal(rows[2].kind, 'add');
  assert.equal(rows[1].old, null); assert.equal(rows[2].next, null);
  assert.equal(worker('').ready.total, 0);
  assert.equal(worker('+written content').page(0).rows[0].kind, 'add');
});
test('50,000 lines are windowed and can scroll directly to the tail', () => {
  const result = worker('@@ -0,0 +1,50000 @@\n' + Array.from({ length: 50000 }, (_, i) => '+const item' + i + ' = ' + i + ';').join('\n'));
  assert.equal(result.ready.total, 50001); assert.equal(result.page(0).rows.length, 160);
  const tail = result.page(49841); assert.equal(tail.rows.length, 160);
  assert.equal(tail.rows.at(-1).next, 50000); assert.match(tail.rows.at(-1).html, /item49999/);
});
test('oversized diffs are explicit; long rows are bounded', () => {
  assert.equal(worker('+x\n'.repeat(150001)).ready.type, 'error');
  assert.equal(worker('x'.repeat(8 * 1024 * 1024 + 1)).ready.type, 'error');
  const row = worker('+' + 'x'.repeat(15000)).page(0).rows[0];
  assert(row.html.length < 12100); assert.match(row.html, /预览已截断/);
});
