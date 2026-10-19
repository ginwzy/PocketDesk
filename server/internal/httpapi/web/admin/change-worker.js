/* Parse only the selected diff off the main thread; return a visible window of rows. */
'use strict';
var rows = [], PAGE = 160, MAX_LINE = 12000;
function esc(s) { return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function parse(text) {
  if (text.length > 8 * 1024 * 1024) throw new Error('差异过大，暂不支持预览');
  var lines = text.replace(/\r\n/g, '\n').split('\n', 150002);
  if (lines.length - (lines[lines.length - 1] === '' ? 1 : 0) > 150000) throw new Error('差异超过 150,000 行，暂不支持预览');
  rows = []; var old = null, next = null, inHunk = false;
  lines.forEach(function (line, i) {
    if (i === lines.length - 1 && !line) return;
    var hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line), kind = 'meta', a = null, b = null;
    if (hunk) { old = +hunk[1]; next = +hunk[2]; inHunk = true; kind = 'hunk'; }
    else if (line.startsWith('@@')) { old = next = null; inHunk = true; kind = 'hunk'; }
    else if (!inHunk && /^(diff |index |--- |\+\+\+ |new file |deleted file |similarity |rename |Binary |GIT binary)/.test(line)) return;
    else if (line[0] === '-') { kind = 'del'; a = old; if (old !== null) old++; }
    else if (line[0] === '+') { kind = 'add'; b = next; if (next !== null) next++; }
    else if (line[0] === ' ' && inHunk) { kind = 'context'; a = old; b = next; if (old !== null) old++; if (next !== null) next++; }
    else return;
    rows.push({ kind: kind, old: a, next: b, text: /^(add|del|context)$/.test(kind) ? line.slice(1) : line });
  });
}
self.onmessage = function (event) {
  var m = event.data;
  try {
    if (m.type === 'init') { parse(m.text); self.postMessage({ type: 'ready', total: rows.length }); }
    else if (m.type === 'page') {
      var start = Math.max(0, Math.min(rows.length, Math.floor(m.start || 0)));
      self.postMessage({ type: 'page', start: start, rows: rows.slice(start, start + PAGE).map(function (r) {
        return { kind: r.kind, old: r.old, next: r.next, html: esc(r.text.slice(0, MAX_LINE)) + (r.text.length > MAX_LINE ? ' …〔本行过长，预览已截断〕' : '') };
      }) });
    }
  } catch (error) { self.postMessage({ type: 'error', message: error.message || '读取差异失败' }); }
};
