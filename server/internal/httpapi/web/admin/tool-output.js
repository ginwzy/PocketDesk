/** 工具执行过程：紧凑列表、短结果预览和独立详情；状态只保存在本地视图中。 */
(function () {
  'use strict';
  var groups = {}, previews = {}, selected = null, context = null, items = [], detailSignature = '';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function line(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function relative(path, root) {
    path = String(path || '').replace(/\\/g, '/');
    root = String(root || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (root && path.indexOf(root + '/') === 0) { return path.slice(root.length + 1); }
    if (/^(\/|[A-Za-z]:\/)/.test(path)) { return '…/' + path.split('/').filter(Boolean).slice(-2).join('/'); }
    return path;
  }
  function patchFiles(text) {
    var files = [], current = null;
    String(text || '').split('\n').forEach(function (l) {
      var m = /^\*\*\* (Update|Add|Delete) File: (.+)\r?$/.exec(l);
      if (m) { current = { path: m[2].trim(), action: m[1], lines: [] }; files.push(current); }
      else if (current && /^\*\*\* Move to: /.test(l)) { current.move = l.slice(13).trim(); }
      else if (current && !/^\*\*\* (Begin Patch|End Patch|End of File)/.test(l)) { current.lines.push(l); }
    });
    return files;
  }
  function describe(it, root) {
    var p = it.input || {}, text = typeof p === 'string' ? p : '', files = [];
    var path = [p.path, p.file_path, p.filePath].filter(function (v) { return typeof v === 'string' && v; })[0] || '';
    var command = typeof p.command === 'string' ? p.command : typeof p.cmd === 'string' ? p.cmd : '';
    if (!text) {
      ['patch', 'input', 'code', 'script'].some(function (key) { if (typeof p[key] === 'string') { text = p[key]; return true; } return false; });
    }
    if (text.indexOf('*** Begin Patch') >= 0) { files = patchFiles(text); }
    var old = p.oldText == null ? p.old_string : p.oldText, next = p.newText == null ? p.new_string : p.newText;
    if (!files.length && path && typeof old === 'string' && typeof next === 'string') {
      files = [{ path: path, action: 'Update', lines: old.split('\n').map(function (l) { return '-' + l; }).concat(next.split('\n').map(function (l) { return '+' + l; })) }];
    }
    var title = files.length ? '修改文件' : command ? '执行命令' : ({ read: '读取文件', write: '写入文件', edit: '修改文件', search: '搜索', grep: '搜索', glob: '查找文件', web: '访问网页', fetch: '访问网页' }[it.kind] || it.name || '工具');
    var target = files.length ? files.map(function (f) { return relative(f.path, root); }).join('、') : command ? String(command) : path ? relative(path, root) : (it.summary !== it.name ? it.summary : '') || text;
    var params = typeof p === 'string' ? p : JSON.stringify(p, null, 2);
    if (typeof p !== 'string' && Object.keys(p).length === 1 && (command || text)) { params = command || text; }
    var output = String(it.output || '');
    return { title: title, target: line(target), params: params === '{}' ? '' : params, files: files, output: output, long: !!files.length || output.length > 1200 || output.split('\n').length > 8 || params.length > 1200 || params.split('\n').length > 8 };
  }
  function status(it) { return !it.done ? '执行中' : it.error ? '执行失败' : '执行完成'; }
  function stateIcon(it) { return context.icon(!it.done ? 'loader' : it.error ? 'alert-circle' : 'check', 15); }
  function key(seq) { return context.sid + ':' + seq; }
  function attr(action, seq) { return ' data-tool-action="' + action + '" data-tool-seq="' + seq + '"'; }
  function previewHtml(it, d) {
    var text = d.output.split('\n').slice(0, 8).join('\n').slice(0, 1200);
    if (text.length < d.output.length) { text += '\n…'; }
    return '<div class="pd-tool-preview"><div class="pd-tool-preview-label">' + (it.error ? '错误' : '结果') +
      '<button class="pd-link"' + attr('detail', it.seq) + '>查看详情</button></div><pre>' + esc(text || (!it.done ? '等待工具返回结果…' : '工具已完成，没有文本输出')) + '</pre></div>';
  }
  function rowHtml(it, failureOnly) {
    var d = describe(it, context.root), active = selected && selected.seq === it.seq && selected.sid === context.sid;
    var error = it.error ? d.output.trim().split(/\r?\n/)[0].slice(0, 160) : '';
    return '<div class="pd-tool-entry' + (d.title === '执行命令' ? ' is-command' : '') + (it.error ? ' is-error' : '') + (!it.done ? ' is-running' : '') + (active ? ' is-selected' : '') + '">' +
      '<button class="pd-tool-row"' + attr('row', it.seq) + ' aria-expanded="' + !!previews[key(it.seq)] + '" title="' + esc(d.target || d.title) + '">' +
      '<span class="pd-tool-state" aria-label="' + status(it) + '">' + stateIcon(it) + '</span><span class="pd-tool-row-text"><span class="pd-tool-row-title">' + esc(d.title) + '</span>' +
      (d.target ? '<span class="pd-tool-target">' + esc(d.target) + '</span>' : '') + '</span>' + (d.files.length ? '<span class="pd-tool-count">' + d.files.length + ' 文件</span>' : '') + context.icon('chevron-right', 14) + '</button>' +
      (error ? '<div class="pd-tool-error-summary">' + esc(error) + '</div>' : '') +
      (!failureOnly && previews[key(it.seq)] ? previewHtml(it, d) : '') + '</div>';
  }
  function groupHtml(tools, ctx) {
    context = ctx;
    var first = tools[0], k = key(first.seq), running = tools.filter(function (t) { return !t.done; }).length, failed = tools.filter(function (t) { return t.done && t.error; }).length;
    var open = Object.prototype.hasOwnProperty.call(groups, k) ? groups[k] : running > 0 || failed > 0;
    var caption = running ? (tools.length - running) + '/' + tools.length + ' 项已完成' : tools.length + ' 项操作已完成';
    if (failed) { caption = tools.length + ' 项操作 · ' + failed + ' 项失败'; }
    return '<div class="pd-msg pd-tool-msg" data-seq="' + first.seq + '"><div class="pd-tool-avatar-space"></div><div class="pd-msg-body"><div class="pd-tool-group">' +
      '<button class="pd-tool-group-head"' + attr('group', first.seq) + ' aria-expanded="' + open + '">' + ctx.icon(open ? 'chevron-down' : 'chevron-right', 14) + '<span>执行过程</span><span class="pd-tool-group-caption' + (failed ? ' is-error' : '') + '">' + caption + '</span>' + (running ? '<span class="pd-tool-state is-running">' + ctx.icon('loader', 14) + '</span>' : '') + '</button>' +
      (open ? tools.map(function (t) { return rowHtml(t, false); }).join('') : tools.filter(function (t) { return t.error; }).map(function (t) { return rowHtml(t, true); }).join('')) + '</div></div></div>';
  }
  function codeHtml(text, diff) {
    if (!diff) { return '<pre class="pd-tool-code">' + esc(text) + '</pre>'; }
    return '<pre class="pd-tool-code pd-tool-diff">' + text.split('\n').map(function (l) {
      var cls = l.charAt(0) === '+' ? 'add' : l.charAt(0) === '-' ? 'del' : l.indexOf('@@') === 0 ? 'hunk' : '';
      return '<span class="pd-tool-diff-line ' + cls + '">' + esc(l || ' ') + '</span>';
    }).join('') + '</pre>';
  }
  function tabText(it, d) {
    if (selected.tab === 'raw') { return JSON.stringify({ tool: it.name, input: it.input, output: it.output || '', done: !!it.done, isError: !!it.error }, null, 2); }
    if (selected.tab === 'params') { return d.params; }
    return d.output || (!it.done ? '等待工具返回结果…' : '工具已完成，没有文本输出');
  }
  function renderDetail() {
    var pane = document.getElementById('tool-inspector'), layout = document.getElementById('chat-layout');
    if (!pane || !layout) { return; }
    var it = selected && selected.sid === context.sid && items.filter(function (t) { return t.t === 'tool' && t.seq === selected.seq; })[0];
    if (!it) { pane.hidden = true; layout.classList.remove('has-tool-detail'); detailSignature = ''; return; }
    var d = describe(it, context.root), sig = JSON.stringify([selected, it.done, it.error, d.output, d.params, context.root]);
    pane.hidden = false; layout.classList.add('has-tool-detail');
    if (sig === detailSignature) { return; }
    var selection = window.getSelection();
    if (selection && !selection.isCollapsed && pane.contains(selection.anchorNode)) { return; }
    var old = pane.querySelector('.pd-tool-detail-scroll'), top = old ? old.scrollTop : 0, left = old ? old.scrollLeft : 0;
    var focused = pane.contains(document.activeElement) ? document.activeElement.dataset : null;
    var focusAction = focused && focused.toolAction, focusTab = focused && focused.tab;
    var same = pane.dataset.toolKey === key(it.seq) + ':' + selected.tab;
    var follow = old && old.scrollHeight - old.scrollTop - old.clientHeight < 40 && !it.done;
    detailSignature = sig;
    var content = '';
    if (selected.tab === 'result' && d.files.length) {
      content = '<div class="pd-tool-section-label">补丁内容 · ' + d.files.length + ' 个文件</div>' + d.files.map(function (f) {
        return '<section class="pd-tool-file"><div class="pd-tool-file-head"><span title="' + esc(f.path) + '">' + esc(relative(f.path, context.root)) + '</span><button class="pd-link" data-tool-action="path" data-path="' + esc(f.path) + '">复制路径</button></div>' +
          (f.action === 'Delete' ? '<div class="pd-tool-section-label">删除文件</div>' : '') + (f.move ? '<div class="pd-tool-section-label">移动到 ' + esc(relative(f.move, context.root)) + '</div>' : '') + codeHtml(f.lines.join('\n'), true) + '</section>';
      }).join('') + (d.output ? '<div class="pd-tool-section-label">执行结果</div>' + codeHtml(d.output, false) : '');
    } else { content = codeHtml(tabText(it, d) || '没有参数', false); }
    pane.dataset.toolKey = key(it.seq) + ':' + selected.tab;
    pane.innerHTML = '<div class="pd-tool-detail-head"><div><strong>' + esc(d.title) + '</strong><span class="pd-tool-detail-status' + (it.error ? ' is-error' : '') + '">' + status(it) + '</span></div><button class="pd-icon-btn" data-tool-action="close" title="关闭工具详情" aria-label="关闭工具详情">' + context.icon('x', 18) + '</button></div>' +
      '<div class="pd-tool-detail-target" title="' + esc(d.target) + '">' + esc(d.target) + '</div><div class="pd-tool-detail-toolbar"><div class="pd-tool-tabs" role="tablist" aria-label="工具详情">' +
      [['result', '结果'], ['params', '参数'], ['raw', '原始数据']].map(function (tab) { return '<button role="tab" aria-selected="' + (selected.tab === tab[0]) + '" data-tool-action="tab" data-tab="' + tab[0] + '">' + tab[1] + '</button>'; }).join('') + '</div>' +
      '<button class="pd-link pd-tool-wrap" data-tool-action="wrap" aria-pressed="' + selected.wrap + '" title="自动换行">换行</button><button class="pd-icon-btn" data-tool-action="copy" title="复制当前内容" aria-label="复制当前内容">' + context.icon('copy', 16) + '</button></div>' +
      '<div class="pd-tool-detail-scroll' + (selected.wrap ? ' wrap' : '') + '" tabindex="0">' + content + '</div>';
    var scroll = pane.querySelector('.pd-tool-detail-scroll');
    if (same) { scroll.scrollTop = follow ? scroll.scrollHeight : top; scroll.scrollLeft = left; }
    if (focusAction) { var focus = pane.querySelector('[data-tool-action="' + focusAction + '"]' + (focusTab ? '[data-tab="' + focusTab + '"]' : '')); if (focus) { focus.focus({ preventScroll: true }); } }
  }
  function closeDetail() {
    var seq = selected && selected.seq;
    selected = null; detailSignature = '';
    if (context) { context.refresh(); }
    var button = document.querySelector('.pd-tool-row[data-tool-seq="' + seq + '"]');
    if (button) { button.focus({ preventScroll: true }); }
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-tool-action]');
    if (!el || !context) { return; }
    var action = el.dataset.toolAction, seq = +el.dataset.toolSeq, it = items.filter(function (t) { return t.t === 'tool' && t.seq === seq; })[0];
    if (action === 'group') {
      var k = key(seq); groups[k] = el.getAttribute('aria-expanded') !== 'true'; context.refresh();
      var head = document.querySelector('.pd-tool-group-head[data-tool-seq="' + seq + '"]'); if (head) { head.focus({ preventScroll: true }); }
    } else if (action === 'row' || action === 'detail') {
      if (!it) { return; }
      var group = el.closest('.pd-tool-group'), groupHead = group && group.querySelector('.pd-tool-group-head');
      if (groupHead) { groups[key(+groupHead.dataset.toolSeq)] = true; }
      if (action === 'row' && !describe(it, context.root).long) { previews[key(seq)] = !previews[key(seq)]; }
      else { selected = { sid: context.sid, seq: seq, tab: 'result', wrap: true }; }
      context.refresh();
      if (selected && selected.seq === seq) { var close = document.querySelector('#tool-inspector [data-tool-action="close"]'); if (close) { close.focus({ preventScroll: true }); } }
    } else if (action === 'close') { closeDetail(); }
    else if (action === 'path') { context.copy(el.dataset.path); }
    else if (selected) {
      var current = items.filter(function (t) { return t.t === 'tool' && t.seq === selected.seq; })[0];
      if (!current) { return; }
      if (action === 'tab') { selected.tab = el.dataset.tab; renderDetail(); }
      if (action === 'wrap') { selected.wrap = !selected.wrap; renderDetail(); }
      if (action === 'copy') {
        var d = describe(current, context.root);
        context.copy(selected.tab === 'result' && d.files.length ? d.files.map(function (f) { return f.path + '\n' + f.lines.join('\n'); }).join('\n\n') + (d.output ? '\n\n' + d.output : '') : tabText(current, d));
      }
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && selected) { e.preventDefault(); closeDetail(); }
    var tab = e.target.closest && e.target.closest('#tool-inspector [role="tab"]');
    if (tab && selected && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) >= 0) {
      e.preventDefault();
      var tabs = ['result', 'params', 'raw'], index = tabs.indexOf(selected.tab);
      selected.tab = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
      renderDetail();
      document.querySelector('#tool-inspector [data-tab="' + selected.tab + '"]').focus();
    }
  });
  document.addEventListener('selectionchange', function () { if (selected && context) { renderDetail(); } });
  window.PDToolView = {
    groupHtml: groupHtml,
    describe: describe,
    update: function (all, ctx) { context = ctx; items = all; renderDetail(); },
    reset: function () { selected = null; detailSignature = ''; items = []; context = null; }
  };
}());
