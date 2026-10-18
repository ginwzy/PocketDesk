/* Desktop-only, read-only change browser. Lists are windowed; code is paged in a worker. */
(function () {
  'use strict';
  var active = null, ROW = 48, CACHE_LIMIT = 8 * 1024 * 1024;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pref(key, fallback) { try { return localStorage.getItem('pd.changes.' + key) || fallback; } catch (_) { return fallback; } }
  function save(key, value) { try { localStorage.setItem('pd.changes.' + key, String(value)); } catch (_) {} }
  function button(action, label, title) { return '<button type="button" class="pd-btn" data-change="' + action + '"' + (title ? ' title="' + esc(title) + '" aria-label="' + esc(title) + '"' : '') + '>' + label + '</button>'; }
  function close(focus) {
    var v = active; if (!v) return;
    active = null; clearTimeout(v.filterTimer); clearTimeout(v.searchTimer); clearTimeout(v.slowTimer); clearTimeout(v.workerTimer);
    cancelAnimationFrame(v.listFrame); v.resize.disconnect();
    if (v.controller) v.controller.abort();
    if (v.worker) v.worker.terminate();
    v.cache.clear(); v.pane.onclick = null; v.pane.hidden = true; v.pane.innerHTML = ''; v.layout.classList.remove('has-changes');
    var target = v.returnFocus && v.returnFocus.isConnected && v.returnFocus.getClientRects().length ? v.returnFocus : document.getElementById('input');
    if (focus !== false && target) target.focus({ preventScroll: true });
  }
  function open(options) {
    close(false);
    var pane = document.getElementById('change-view'), layout = document.getElementById('chat-layout');
    if (!pane || !layout) return;
    var v = active = { pane: pane, layout: layout, options: options, files: options.files, filtered: [], selected: -1, generation: 0, pageId: 0, ready: false,
      cache: new Map(), cacheBytes: 0, positions: new Map(), returnFocus: document.activeElement, start: 0, total: 0, current: 0, mode: 'unified',
      desiredMode: pref('mode', 'unified'), wrap: pref('wrap', 'false') === 'true', font: Math.max(11, Math.min(18, +pref('font', '13') || 13)), listOpen: true };
    v.names = v.files.map(function (f) { return String(f.path || '').normalize('NFC').toLowerCase(); });
    v.filtered = v.files.map(function (_, i) { return i; });
    pane.hidden = false; layout.classList.add('has-changes');
    pane.style.setProperty('--ch-width', Math.max(560, Math.min(1400, +pref('width', '820') || 820)) + 'px');
    pane.innerHTML = '<div class="ch-resize" role="separator" aria-label="调整变更查看区宽度" aria-orientation="vertical" tabindex="0"></div>' +
      '<header class="ch-head"><div><strong>文件变更</strong><span class="ch-count">' + v.files.length + ' 个文件</span><div class="ch-source">' + esc(options.source) + '</div></div>' + button('close', '返回聊天', 'Esc') + '</header>' +
      '<div class="ch-body"><div class="ch-file-backdrop" data-change="hide-files" aria-hidden="true" hidden></div><nav class="ch-files" aria-label="变更文件"><div class="ch-filter-label"><div class="ch-filter-top"><label for="ch-filter">按路径筛选</label>' + button('hide-files', '收起', '收起文件列表') + '</div><input class="pd-input" id="ch-filter" placeholder="筛选文件…" autocomplete="off"></div><div class="ch-file-count"></div><div class="ch-file-scroll" tabindex="0" role="listbox" aria-label="文件列表"><div class="ch-file-space"></div></div></nav>' +
      '<section class="ch-detail" aria-label="差异内容"><div class="ch-file-head"><div class="ch-file-top"><strong class="ch-path"></strong><span class="ch-file-position"></span></div><div class="ch-file-actions">' + button('files', '文件列表') + button('previous', '←', '上一个文件 · Option ←') + button('next', '→', '下一个文件 · Option →') + button('path', '复制路径') + button('copy', '复制差异') + button('open', '打开当前文件', '查看磁盘当前内容，可能包含后续修改') + button('reveal', 'Finder') + '</div></div>' +
      '<div class="ch-toolbar"><div class="ch-modes" role="group" aria-label="差异布局">' + button('unified', '统一') + button('split', '左右') + '</div>' + button('wrap', '换行') + button('smaller', 'A−', '缩小代码字号') + button('larger', 'A+', '放大代码字号') + button('find', '查找', '⌘F') + '<span class="ch-toolbar-spacer"></span>' + button('prev-hunk', '↑ 修改', '上一处修改 · Option ↑') + button('next-hunk', '↓ 修改', '下一处修改 · Option ↓') + '</div>' +
      '<div class="ch-find"><input class="pd-input" id="ch-search" placeholder="在此差异中查找 · ⌘F" aria-label="在此差异中查找" autocomplete="off"><span class="ch-hits" role="status"></span>' + button('prev-hit', '↑', '上一个匹配') + button('next-hit', '↓', '下一个匹配') + '</div>' +
      '<div class="ch-code-scroll" tabindex="0" aria-label="代码差异"></div><div class="ch-horizontal" hidden><div class="ch-hbar" tabindex="0" aria-label="修改前横向滚动"><div></div></div><div class="ch-hbar" tabindex="0" aria-label="修改后横向滚动"><div></div></div></div><footer class="ch-footer">' + button('prev-page', '上一段') + '<span class="ch-page-status" role="status"></span>' + button('next-page', '下一段') + '</footer></section></div>';
    v.list = pane.querySelector('.ch-file-scroll'); v.space = pane.querySelector('.ch-file-space'); v.code = pane.querySelector('.ch-code-scroll');
    pane.style.setProperty('--ch-font', v.font + 'px'); v.code.classList.toggle('wrap', v.wrap);
    v.bars = Array.from(pane.querySelectorAll('.ch-hbar'));
    v.bars.forEach(function (bar, i) { bar.addEventListener('scroll', function () { v[i ? 'xRight' : 'xLeft'] = bar.scrollLeft; v.code.style.setProperty(i ? '--ch-right-x' : '--ch-left-x', -bar.scrollLeft + 'px'); }); });
    v.code.addEventListener('copy', function (e) {
      var selection = window.getSelection();
      if (!selection || selection.isCollapsed || !e.clipboardData) return;
      var range = selection.getRangeAt(0);
      function codeAt(node) { var el = node.nodeType === 1 ? node : node.parentElement; return el && el.closest('code'); }
      var first = codeAt(range.startContainer), last = codeAt(range.endContainer);
      if (!first || !last || !v.code.contains(first) || !v.code.contains(last)) return;
      var a = first.closest('.ch-cell'), b = last.closest('.ch-cell'), side = a && a.previousElementSibling ? 1 : 0;
      if (v.mode === 'split' && (!a || !b || side !== (b.previousElementSibling ? 1 : 0))) return;
      var codes = Array.from(v.code.querySelectorAll(v.mode === 'split' ? '.ch-cell:nth-child(' + (side + 1) + ') code' : '.ch-code-row > code'));
      var begin = codes.indexOf(first), end = codes.indexOf(last);
      if (begin < 0 || end < begin) return;
      function offset(code, node, position) { var r = document.createRange(); r.selectNodeContents(code); r.setEnd(node, position); return r.toString().length; }
      var start = offset(first, range.startContainer, range.startOffset), finish = offset(last, range.endContainer, range.endOffset);
      var text = codes.slice(begin, end + 1).map(function (code, i) { var t = code.textContent; return t.slice(i === 0 ? start : 0, i === end - begin ? finish : t.length); }).join('\n');
      e.clipboardData.setData('text/plain', text); e.preventDefault();
    });
    v.code.addEventListener('wheel', function (e) {
      if (v.mode !== 'split' || v.wrap || !(e.deltaX || e.shiftKey)) return;
      var cell = e.target.closest('.ch-cell'); if (!cell) return;
      var bar = v.bars[cell.previousElementSibling ? 1 : 0]; bar.scrollLeft += e.deltaX || e.deltaY; e.preventDefault();
    }, { passive: false });
    v.list.addEventListener('scroll', function () { if (!v.listFrame) v.listFrame = requestAnimationFrame(function () { v.listFrame = 0; drawFiles(v); }); });
    pane.querySelector('#ch-filter').addEventListener('input', function (e) {
      clearTimeout(v.filterTimer); var query = e.target.value.trim().normalize('NFC').toLowerCase();
      v.filterTimer = setTimeout(function () {
        if (active !== v) return;
        v.filtered = []; v.names.forEach(function (name, i) { if (!query || name.includes(query)) v.filtered.push(i); });
        v.list.scrollTop = 0; drawFiles(v); updateFileNav(v);
      }, 120);
    });
    pane.querySelector('#ch-search').addEventListener('input', function () { clearTimeout(v.searchTimer); v.searchTimer = setTimeout(function () { page(v, 'first-hit'); }, 140); });
    pane.querySelector('#ch-search').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); page(v, e.shiftKey ? 'prev-hit' : 'next-hit'); } });
    pane.onclick = function (e) {
      var f = e.target.closest('[data-change-file]');
      if (f) { select(v, +f.dataset.changeFile); if (pane.clientWidth < 700) { v.listOpen = false; layoutList(v); } v.code.focus({ preventScroll: true }); return; }
      var el = e.target.closest('[data-change]'); if (el) action(v, el.dataset.change);
    };
    var drag = pane.querySelector('.ch-resize');
    drag.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault(); drag.setPointerCapture(e.pointerId); v.drag = { x: e.clientX, width: pane.getBoundingClientRect().width };
    });
    drag.addEventListener('pointermove', function (e) { if (v.drag) pane.style.setProperty('--ch-width', Math.max(560, Math.min(v.layout.clientWidth - 320, v.drag.width + v.drag.x - e.clientX)) + 'px'); });
    function finishDrag() { if (v.drag) save('width', pane.getBoundingClientRect().width); v.drag = null; }
    drag.addEventListener('pointerup', finishDrag); drag.addEventListener('pointercancel', finishDrag);
    drag.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); var width = Math.max(560, Math.min(layout.clientWidth - 320, pane.clientWidth + (e.key === 'ArrowLeft' ? 32 : -32)));
      pane.style.setProperty('--ch-width', width + 'px'); save('width', width);
    });
    v.resize = new ResizeObserver(function () {
      if (active !== v) return;
      var narrow = pane.clientWidth < 700;
      if (v.narrow !== narrow) { v.narrow = narrow; if (narrow) v.listOpen = false; layoutList(v); }
      var mode = v.code.clientWidth < 680 ? 'unified' : v.desiredMode;
      pane.querySelector('[data-change="split"]').disabled = pane.clientWidth < 680;
      pane.querySelector('[data-change="split"]').title = pane.clientWidth < 680 ? '加宽窗口后可使用左右对比' : '左右对比；必要时收起文件列表';
      if (mode !== v.mode) { var previous = v.mode; v.mode = mode; page(v, '', previous); }
      updateModes(v); drawFiles(v); horizontal(v);
    });
    v.resize.observe(pane); v.resize.observe(v.code);
    drawFiles(v); select(v, Math.max(0, Math.min(options.index || 0, v.files.length - 1))); v.code.focus({ preventScroll: true });
  }
  function layoutList(v) {
    v.pane.classList.toggle('ch-list-open', v.listOpen); v.pane.querySelector('[data-change="files"]').setAttribute('aria-expanded', String(v.listOpen));
    var overlay = v.listOpen && v.pane.clientWidth < 700;
    v.pane.querySelector('.ch-detail').inert = overlay; v.pane.querySelector('.ch-file-backdrop').hidden = !overlay;
  }
  function updateModes(v) {
    ['unified', 'split'].forEach(function (m) { v.pane.querySelector('[data-change="' + m + '"]').setAttribute('aria-pressed', String(v.mode === m)); });
    v.pane.querySelector('[data-change="smaller"]').disabled = v.font <= 11;
    v.pane.querySelector('[data-change="larger"]').disabled = v.font >= 18;
    v.pane.querySelector('[data-change="wrap"]').setAttribute('aria-pressed', String(v.wrap));
  }
  function drawFiles(v) {
    if (active !== v) return;
    v.pane.querySelector('.ch-file-count').textContent = v.filtered.length + ' / ' + v.files.length + ' 个文件';
    v.space.style.height = v.filtered.length * ROW + 'px';
    var start = Math.max(0, Math.floor(v.list.scrollTop / ROW) - 4), end = Math.min(v.filtered.length, start + Math.ceil(v.list.clientHeight / ROW) + 10);
    var html = '';
    for (var n = start; n < end; n++) {
      var i = v.filtered[n], f = v.files[i], parts = String(f.path).split('/'), name = parts.pop(), path = parts.join('/') || '项目根目录';
      var stats = f.binary ? '二进制' : f.added == null ? (({ Update: '修改', Add: '新增', Delete: '删除', Write: '写入' })[f.status] || f.status || '修改') : '+' + f.added + ' −' + (f.removed || 0);
      html += '<button class="ch-file' + (i === v.selected ? ' selected' : '') + '" role="option" aria-selected="' + (i === v.selected) + '" data-change-file="' + i + '" title="' + esc(f.path) + '" style="top:' + n * ROW + 'px"><span><strong>' + esc(name) + '</strong><small>' + esc(path) + '</small></span><span class="ch-file-stat">' + esc(stats) + '</span></button>';
    }
    v.space.innerHTML = html;
  }
  function updateFileNav(v) {
    var index = v.filtered.indexOf(v.selected);
    v.pane.querySelector('.ch-file-position').textContent = index < 0 ? '当前文件不在筛选结果中' : (index + 1) + ' / ' + v.filtered.length;
    v.pane.querySelector('[data-change="previous"]').disabled = index <= 0;
    v.pane.querySelector('[data-change="next"]').disabled = index < 0 || index >= v.filtered.length - 1;
  }
  function message(v, text, retry) {
    v.pane.querySelector('.ch-horizontal').hidden = true;
    v.code.innerHTML = '<div class="ch-empty" role="status"><p>' + esc(text) + '</p>' + (retry ? button('retry', '重试') : '') + '</div>';
  }
  function remember(v) {
    if (v.selected < 0) return;
    v.positions.delete(v.selected);
    v.positions.set(v.selected, { start: v.start, top: v.code.scrollTop, left: v.code.scrollLeft, xLeft: v.xLeft, xRight: v.xRight, mode: v.mode });
    if (v.positions.size > 100) v.positions.delete(v.positions.keys().next().value);
  }
  function cache(v, index, text) {
    var bytes = text.length * 2;
    if (bytes > CACHE_LIMIT) return;
    while (v.cache.size && (v.cache.size >= 4 || v.cacheBytes + bytes > CACHE_LIMIT)) { var key = v.cache.keys().next().value; v.cacheBytes -= v.cache.get(key).length * 2; v.cache.delete(key); }
    v.cache.set(index, text); v.cacheBytes += bytes;
  }
  async function select(v, index) {
    if (active !== v || !v.files[index] || index === v.selected && (v.ready || v.loading)) return;
    remember(v); v.selected = index; v.ready = false; v.loading = true; v.rendering = false; v.pendingPage = null; v.renderedMode = null; v.xLeft = 0; v.xRight = 0; v.raw = null; v.total = 0; v.start = 0; v.current = 0;
    var generation = ++v.generation, f = v.files[index];
    if (v.controller) v.controller.abort(); if (v.worker) v.worker.terminate(); clearTimeout(v.slowTimer); clearTimeout(v.workerTimer);
    v.controller = new AbortController();
    v.pane.querySelector('.ch-path').textContent = f.path; v.pane.querySelector('.ch-path').title = f.path;
    v.pane.querySelector('#ch-search').value = ''; v.pane.querySelector('.ch-hits').textContent = '';
    v.pane.querySelector('.ch-page-status').textContent = '';
    v.pane.querySelector('[data-change="open"]').disabled = !f.abs || /^(D|deleted|Delete)$/.test(f.status);
    v.pane.querySelector('[data-change="reveal"]').disabled = !f.abs;
    v.pane.querySelector('[data-change="copy"]').disabled = true;
    v.pane.querySelectorAll('[data-change$="-page"],[data-change$="-hunk"],[data-change$="-hit"]').forEach(function (b) { b.disabled = true; });
    updateFileNav(v); drawFiles(v); message(v, '正在读取差异…'); v.code.setAttribute('aria-busy', 'true');
    v.slowTimer = setTimeout(function () { if (active === v && generation === v.generation) message(v, '正在读取并解析此文件的差异，请稍候…'); }, 3000);
    try {
      var text;
      if (v.cache.has(index)) { text = v.cache.get(index); v.cache.delete(index); v.cache.set(index, text); }
      else { text = await v.options.load(f, v.controller.signal); if (active !== v || generation !== v.generation) return; if (text != null) cache(v, index, String(text)); }
      if (active !== v || generation !== v.generation) return;
      if (text == null) { clearTimeout(v.slowTimer); v.loading = false; v.code.setAttribute('aria-busy', 'false'); message(v, f.binary ? '二进制文件没有文本差异。可打开当前文件查看；当前文件可能与这轮记录不同。' : '这份记录没有可展示的文本差异。打开当前文件不会还原当时的版本。'); return; }
      v.raw = String(text); v.pane.querySelector('[data-change="copy"]').disabled = false;
      v.worker = new Worker('/admin/change-worker.js');
      v.worker.onerror = function () { if (active === v && generation === v.generation) failed(v, '无法启动差异渲染，请重试'); };
      v.worker.onmessage = function (e) {
        if (active !== v || generation !== v.generation) return;
        clearTimeout(v.workerTimer);
        var data = e.data;
        if (data.type === 'error') { failed(v, data.message); return; }
        if (data.type === 'ready') {
          clearTimeout(v.slowTimer); v.loading = false; v.ready = true;
          var position = v.positions.get(index); v.restore = position;
          if (position) { v.xLeft = position.xLeft || 0; v.xRight = position.xRight || 0; }
          v.start = position ? position.start : 0; v.current = v.start;
          page(v, '', position && position.mode); return;
        }
        if (data.type === 'page' && data.id === v.pageId) {
          v.rendering = false;
          if (v.pendingPage) { var request = v.pendingPage; v.pendingPage = null; dispatch(v, request); }
          else renderPage(v, data);
        }
      };
      armWorker(v);
      v.worker.postMessage({ type: 'init', text: v.raw, path: f.path });
    } catch (error) { if (active === v && generation === v.generation && !v.controller.signal.aborted) failed(v, error.message || '读取差异失败'); }
  }
  function armWorker(v) {
    clearTimeout(v.workerTimer);
    v.workerTimer = setTimeout(function () { if (active === v) { v.worker.terminate(); failed(v, '差异渲染耗时过长。可以复制完整差异到外部工具查看，或重试。'); } }, 10000);
  }
  function failed(v, text) { clearTimeout(v.slowTimer); clearTimeout(v.workerTimer); v.ready = false; v.loading = false; v.rendering = false; v.code.setAttribute('aria-busy', 'false'); v.pane.querySelector('.ch-page-status').textContent = '未能显示差异'; message(v, text, true); }
  function visibleRow(v) {
    var top = v.code.getBoundingClientRect().top + (v.renderedMode === 'split' ? 24 : 0);
    var row = Array.from(v.code.querySelectorAll('[data-code-row]')).find(function (r) { return r.getBoundingClientRect().bottom > top; });
    return row ? +row.dataset.codeRow : v.current;
  }
  function page(v, move, fromMode) {
    if (active !== v || !v.ready) return;
    v.code.setAttribute('aria-busy', 'true');
    var request = { type: 'page', mode: v.mode, fromMode: v.renderedMode || fromMode, anchor: (fromMode || /-hunk$/.test(move)) && !v.restore ? visibleRow(v) : v.current, move: move, query: v.pane.querySelector('#ch-search').value };
    if (v.rendering) { v.pendingPage = request; return; }
    dispatch(v, request);
  }
  function dispatch(v, request) {
    v.rendering = true; request.id = ++v.pageId;
    v.pane.querySelector('.ch-page-status').textContent = '正在渲染…';
    v.pane.querySelectorAll('[data-change$="-page"],[data-change$="-hunk"],[data-change$="-hit"]').forEach(function (b) { b.disabled = true; });
    armWorker(v);
    v.worker.postMessage(request);
  }
  function codeCell(r, side) {
    if (!r) return '<div class="ch-cell ch-blank"><span></span><code></code></div>';
    var number = side === 'left' ? r.old : r.next;
    return '<div class="ch-cell ' + r.kind + '"><span class="ch-number">' + (number == null ? '' : number) + '</span><code><span class="ch-line-text">' + r.html + '</span></code></div>';
  }
  function renderPage(v, data) {
    v.renderedMode = data.mode;
    v.start = data.start; v.total = data.total; v.current = data.target == null ? data.start : data.target;
    var html = '<div class="ch-code-table ' + data.mode + '">';
    if (data.mode === 'split') html += '<div class="ch-column-labels"><span>修改前</span><span>修改后</span></div>';
    data.rows.forEach(function (r, i) {
      var n = data.start + i;
      html += '<div class="ch-code-row ' + r.kind + '" data-code-row="' + n + '">';
      if (data.mode === 'split') {
        if (r.kind === 'hunk' || r.kind === 'meta') html += '<div class="ch-meta">' + r.left.html + '</div>';
        else html += codeCell(r.left, 'left') + codeCell(r.right, 'right');
      } else {
        html += '<span class="ch-number">' + (r.old == null ? '' : r.old) + '</span><span class="ch-number">' + (r.next == null ? '' : r.next) + '</span><span class="ch-sign">' + (r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : '') + '</span><code>' + r.html + '</code>';
      }
      html += '</div>';
    });
    v.code.innerHTML = html + '</div>';
    if (!data.total) message(v, '没有可展示的差异内容');
    v.code.setAttribute('aria-busy', 'false');
    horizontal(v);
    if (v.restore) { v.code.scrollTop = v.restore.top; v.code.scrollLeft = v.restore.left; v.restore = null; }
    else { v.code.scrollTop = 0; if (data.target != null) { var row = v.code.querySelector('[data-code-row="' + data.target + '"]'); if (row) v.code.scrollTop += row.getBoundingClientRect().top - v.code.getBoundingClientRect().top - (data.mode === 'split' ? 24 : 0); } }
    v.pane.querySelector('.ch-page-status').textContent = data.total ? (data.start + 1) + '–' + (data.start + data.rows.length) + ' / ' + data.total + ' 行' : '0 行';
    v.pane.querySelector('[data-change="prev-page"]').disabled = data.start === 0;
    v.pane.querySelector('[data-change="next-page"]').disabled = data.start + data.rows.length >= data.total;
    v.pane.querySelectorAll('[data-change$="-hunk"]').forEach(function (b) { b.disabled = !data.total; });
    v.pane.querySelectorAll('[data-change$="-hit"]').forEach(function (b) { b.disabled = !data.hits; });
    v.pane.querySelector('.ch-hits').textContent = v.pane.querySelector('#ch-search').value ? (data.hit ? data.hit + ' / ' : '') + data.hits + ' 匹配行' : '';
  }
  function horizontal(v) {
    var strip = v.pane.querySelector('.ch-horizontal');
    strip.hidden = v.mode !== 'split' || v.wrap;
    if (strip.hidden) return;
    var widths = [0, 0];
    v.code.querySelectorAll('.ch-cell').forEach(function (cell) { var text = cell.querySelector('.ch-line-text'); if (text) { var side = cell.previousElementSibling ? 1 : 0; widths[side] = Math.max(widths[side], text.scrollWidth + v.font * 4.4 + 16); } });
    v.bars.forEach(function (bar, i) { bar.firstElementChild.style.width = widths[i] + 'px'; bar.scrollLeft = v[i ? 'xRight' : 'xLeft'] || 0; v.code.style.setProperty(i ? '--ch-right-x' : '--ch-left-x', -bar.scrollLeft + 'px'); });
    strip.hidden = widths.every(function (width, i) { return width <= v.bars[i].clientWidth; });
  }
  function action(v, act) {
    if (active !== v) return;
    var f = v.files[v.selected], index = v.filtered.indexOf(v.selected);
    if (act === 'close') { close(); return; }
    if (act === 'files' || act === 'hide-files') { v.listOpen = act === 'files' && !v.listOpen; layoutList(v); drawFiles(v); (v.listOpen ? v.pane.querySelector('#ch-filter') : v.code).focus(); return; }
    if (act === 'previous' || act === 'next') {
      var i = v.filtered[index + (act === 'next' ? 1 : -1)];
      if (i != null) { select(v, i); v.list.scrollTop = Math.max(0, (index + (act === 'next' ? 1 : -1)) * ROW - v.list.clientHeight / 2); } return;
    }
    if (act === 'retry') { select(v, v.selected); return; }
    if (act === 'copy') { if (v.raw != null) v.options.copy(v.raw); return; }
    if (act === 'path') { v.options.copy(f.path); return; }
    if (act === 'open' || act === 'reveal') { v.options.openFile(f, act === 'reveal'); return; }
    if (act === 'find') { if (v.narrow && v.listOpen) { v.listOpen = false; layoutList(v); } v.pane.classList.add('ch-search-open'); var input = v.pane.querySelector('#ch-search'); input.focus(); input.select(); return; }
    if (act === 'unified' || act === 'split') { if (act === 'split' && v.code.clientWidth < 680) { v.listOpen = false; layoutList(v); } var old = v.mode; v.desiredMode = act; v.mode = act; save('mode', act); updateModes(v); page(v, '', old); return; }
    if (act === 'wrap') { v.wrap = !v.wrap; save('wrap', v.wrap); v.code.classList.toggle('wrap', v.wrap); updateModes(v); horizontal(v); return; }
    if (act === 'smaller' || act === 'larger') { v.font = Math.max(11, Math.min(18, v.font + (act === 'larger' ? 1 : -1))); save('font', v.font); v.pane.style.setProperty('--ch-font', v.font + 'px'); updateModes(v); horizontal(v); return; }
    page(v, act);
  }
  document.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    var v = active;
    if (!v || document.getElementById('modal-root') && document.getElementById('modal-root').childElementCount) return;
    if (!v.pane.contains(document.activeElement) && document.activeElement !== document.body) return;
    if (e.key === 'Escape') { e.preventDefault();
      if (v.narrow && v.listOpen) { action(v, 'hide-files'); return; }
      if (e.target.id === 'ch-search') { e.target.value = ''; v.pane.classList.remove('ch-search-open'); page(v, ''); v.code.focus(); } else close();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); action(v, 'find'); }
    if (e.altKey && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
      var act = { ArrowLeft: 'previous', ArrowRight: 'next', ArrowUp: 'prev-hunk', ArrowDown: 'next-hunk' }[e.key];
      if (act) { e.preventDefault(); action(v, act); }
    }
    if (v.list.contains(e.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); var current = v.filtered.indexOf(v.selected), pos = e.key === 'Home' ? 0 : e.key === 'End' ? v.filtered.length - 1 : Math.max(0, Math.min(v.filtered.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
      if (v.filtered[pos] != null) { select(v, v.filtered[pos]); v.list.scrollTop = Math.max(0, pos * ROW - v.list.clientHeight / 2); drawFiles(v); v.list.focus(); }
    }
  });
  window.PDChanges = { open: open, close: close };
}());
