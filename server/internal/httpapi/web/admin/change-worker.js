/* Only the selected file is parsed. Highlighting/search run off the UI thread. */
'use strict';
self.Prism = { manual: true, disableWorkerMessageHandler: true };
importScripts('vendor/prism.min.js');
var unified = [], split = [], uToS = [], language = '', searchKey = '', hits = [];
var PAGE = 160, MAX_LINE = 12000;
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function parse(text) {
  unified = []; split = []; uToS = []; searchKey = ''; hits = [];
  var old = null, next = null, inHunk = false;
  var lines = text.replace(/\r\n/g, '\n').split('\n', 150002);
  if (lines.length - (lines[lines.length - 1] === '' ? 1 : 0) > 150000) throw new Error('差异超过 150,000 行，请复制差异后在外部工具中查看');
  lines.forEach(function (line, i, all) {
    if (i === all.length - 1 && line === '') return;
    var h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line), kind = 'meta', a = null, b = null;
    if (h) { old = +h[1]; next = +h[2]; inHunk = true; kind = 'hunk'; }
    else if (line.startsWith('@@')) { old = null; next = null; inHunk = true; kind = 'hunk'; }
    else if (!inHunk && /^(diff |index |--- |\+\+\+ |new file |deleted file |similarity |rename |Binary |GIT binary)/.test(line)) { kind = 'meta'; }
    else if (line[0] === '-') { kind = 'del'; a = old; if (old !== null) old++; }
    else if (line[0] === '+') { kind = 'add'; b = next; if (next !== null) next++; }
    else if (line[0] === ' ' && inHunk) { kind = 'context'; a = old; b = next; if (old !== null) old++; if (next !== null) next++; }
    var content = /^(add|del|context)$/.test(kind) ? line.slice(1) : line;
    unified.push({ kind: kind, old: a, next: b, text: content });
  });
  for (var i = 0; i < unified.length;) {
    var r = unified[i];
    if (r.kind === 'del' || r.kind === 'add') {
      var start = i, dels = [], adds = [];
      while (i < unified.length && unified[i].kind === 'del') dels.push(i++);
      while (i < unified.length && unified[i].kind === 'add') adds.push(i++);
      for (var k = 0; k < Math.max(dels.length, adds.length); k++) {
        var di = dels[k], ai = adds[k], d = unified[di], a = unified[ai];
        if (d && a) {
          var n = 0, end = 0, min = Math.min(d.text.length, a.text.length);
          while (n < min && d.text[n] === a.text[n]) n++;
          if (n && /[\uD800-\uDBFF]/.test(d.text[n - 1])) n--;
          while (end < min - n && d.text[d.text.length - 1 - end] === a.text[a.text.length - 1 - end]) end++;
          if (end && /[\uDC00-\uDFFF]/.test(d.text[d.text.length - end])) end--;
          d.changed = [n, d.text.length - end]; a.changed = [n, a.text.length - end];
        }
        var idx = split.length;
        if (d) uToS[di] = idx;
        if (a) uToS[ai] = idx;
        split.push({ kind: 'pair', left: d, right: a, original: d ? di : ai });
      }
      if (start === i) throw new Error('无法读取差异区块');
    } else {
      uToS[i] = split.length;
      split.push({ kind: r.kind, left: r, right: r, original: i }); i++;
    }
  }
}
function grammar(path) {
  var ext = (path.split('.').pop() || '').toLowerCase();
  return ({ js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', dart: 'dart', swift: 'swift', rs: 'rust', yaml: 'yaml', yml: 'yaml', sql: 'sql', py: 'python', go: 'go', json: 'json', sh: 'bash', bash: 'bash', css: 'css', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', c: 'clike', h: 'clike', cpp: 'clike', java: 'clike' })[ext] || '';
}
function paint(row, query) {
  if (!row) return null;
  var full = row.text, text = full.slice(0, MAX_LINE), spans = [], offset = 0;
  function flatten(tokens, classes) {
    if (typeof tokens === 'string') { spans.push({ start: offset, end: offset + tokens.length, classes: classes }); offset += tokens.length; }
    else if (Array.isArray(tokens)) tokens.forEach(function (t) { flatten(t, classes); });
    else flatten(tokens.content, classes + ' tok-' + tokens.type.replace(/[^\w-]/g, ''));
  }
  // Pathological grammar inputs and very long lines use plain text.
  if (language && text.length <= 2000 && row.kind !== 'hunk' && row.kind !== 'meta') { try { flatten(Prism.tokenize(text, Prism.languages[language]), ''); } catch (_) { spans = []; offset = 0; flatten(text, ''); } }
  else flatten(text, '');
  var matches = [], lower = text.toLowerCase(), pos = 0;
  if (query) while ((pos = lower.indexOf(query, pos)) >= 0) { matches.push([pos, pos + query.length]); pos += Math.max(query.length, 1); }
  var edges = new Set([0, text.length]);
  spans.forEach(function (s) { edges.add(s.start); edges.add(s.end); });
  if (row.changed) row.changed.forEach(function (n) { if (n >= 0 && n <= text.length) edges.add(n); });
  matches.forEach(function (m) { edges.add(m[0]); edges.add(m[1]); });
  var points = Array.from(edges).sort(function (a, b) { return a - b; }), html = '', si = 0, mi = 0;
  for (var i = 0; i < points.length - 1; i++) {
    var begin = points[i], end = points[i + 1];
    while (si + 1 < spans.length && spans[si].end <= begin) si++;
    while (mi < matches.length && matches[mi][1] <= begin) mi++;
    var cls = spans[si] ? spans[si].classes : '';
    if (row.changed && begin >= row.changed[0] && begin < row.changed[1]) cls += ' ch-word';
    if (matches[mi] && begin >= matches[mi][0] && begin < matches[mi][1]) cls += ' ch-match';
    html += cls ? '<span class="' + cls.trim() + '">' + esc(text.slice(begin, end)) + '</span>' : esc(text.slice(begin, end));
  }
  if (full.length > text.length) html += '<span class="ch-long"> … 本行过长，完整内容可通过“复制差异”获取</span>';
  return { html: html, old: row.old, next: row.next, kind: row.kind };
}
self.onmessage = function (event) {
  var m = event.data;
  try {
    if (m.type === 'init') {
      var text = m.text;
      if (text.length > 8 * 1024 * 1024) throw new Error('差异超过 8 MB，请复制差异后在外部工具中查看');
      language = grammar(m.path); parse(text);
      self.postMessage({ type: 'ready', total: unified.length, splitTotal: split.length }); return;
    }
    if (m.type !== 'page') return;
    var rows = m.mode === 'split' ? split : unified, query = String(m.query || '').toLowerCase(), key = m.mode + ':' + query;
    if (searchKey !== key) {
      hits = []; searchKey = key;
      if (query) rows.forEach(function (r, i) {
        var a = m.mode === 'split' ? r.left : r, b = m.mode === 'split' ? r.right : null;
        if (a && a.text.toLowerCase().includes(query) || b && b.text.toLowerCase().includes(query)) hits.push(i);
      });
    }
    var anchor = Math.max(0, m.anchor || 0), target = null;
    if (m.fromMode && m.fromMode !== m.mode) { anchor = m.mode === 'split' ? (uToS[anchor] || 0) : (split[anchor] ? split[anchor].original : 0); target = anchor; }
    if (m.move === 'first-hit') target = hits.length ? hits[0] : null;
    if (m.move === 'next-hit') target = hits.find(function (i) { return i > anchor; });
    if (m.move === 'prev-hit') target = hits.slice().reverse().find(function (i) { return i < anchor; });
    if (m.move === 'next-hit' && target == null && hits.length) target = hits[0];
    if (m.move === 'prev-hit' && target == null && hits.length) target = hits[hits.length - 1];
    var hunks = [];
    rows.forEach(function (r, i) { if (r.kind === 'hunk' || i === 0) hunks.push(i); });
    if (m.move === 'next-hunk') target = hunks.find(function (i) { return i > anchor; });
    if (m.move === 'prev-hunk') target = hunks.slice().reverse().find(function (i) { return i < anchor; });
    if (m.move === 'next-hunk' && target == null) target = hunks[0];
    if (m.move === 'prev-hunk' && target == null) target = hunks[hunks.length - 1];
    if (target != null) anchor = target;
    var start = Math.min(Math.max(0, rows.length - 1), anchor); start = Math.floor(start / PAGE) * PAGE;
    if (m.move === 'next-page') start += PAGE;
    if (m.move === 'prev-page') start -= PAGE;
    start = Math.max(0, Math.min(Math.floor(Math.max(0, rows.length - 1) / PAGE) * PAGE, start));
    var chunk = rows.slice(start, start + PAGE).map(function (r) {
      if (m.mode === 'split') return { kind: r.kind, left: paint(r.left, query), right: paint(r.right, query) };
      return paint(r, query);
    });
    self.postMessage({ type: 'page', id: m.id, rows: chunk, start: start, total: rows.length, target: target, hits: hits.length, hit: target == null ? 0 : hits.indexOf(target) + 1, mode: m.mode });
  } catch (error) { self.postMessage({ type: 'error', message: error.message || '读取差异失败' }); }
};
