/* Shared Mac sidebar: browse the session directory or read a single unified diff. */
(function () {
  'use strict';
  var active = null, ROW = 44, LINE = 22, CACHE_LIMIT = 8 * 1024 * 1024;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function button(action, label) { return '<button type="button" class="pd-link" data-change="' + action + '">' + label + '</button>'; }
  function cancel(v) {
    ++v.generation; clearTimeout(v.timer); clearTimeout(v.slow); clearTimeout(v.filterTimer); cancelAnimationFrame(v.frame); v.frame = 0;
    if (v.controller) v.controller.abort();
    if (v.worker) v.worker.terminate();
    v.worker = null; v.sendPage = null; v.busy = false; v.pending = null;
  }
  function close(focus) {
    var v = active; if (!v) return;
    cancel(v); active = null; v.resize.disconnect(); v.cache.clear(); v.pane.hidden = true; v.pane.innerHTML = ''; v.pane.onclick = null;
    v.layout.classList.remove('has-changes'); mark(false);
    var target = v.returnFocus && v.returnFocus.isConnected ? v.returnFocus : document.getElementById('input');
    if (focus !== false && target) target.focus({ preventScroll: true });
  }
  function mark(open) { var b = document.querySelector('[data-act="files-sidebar"]'); if (b) b.setAttribute('aria-expanded', String(open)); }
  function open(options) {
    var v = active;
    if (!v || v.options.sid !== options.sid || v.options.root !== options.root) {
      close(false);
      var pane = document.getElementById('change-view'), layout = document.getElementById('chat-layout');
      if (!pane || !layout) return;
      v = active = { pane: pane, layout: layout, options: options, tab: 'files', generation: 0, cache: new Map(), cacheBytes: 0, positions: new Map(),
        directory: { path: '', entries: null, top: 0, filter: '' }, diff: { files: null, selected: -1, top: 0, filter: '' }, returnFocus: document.activeElement };
      pane.innerHTML = '<header class="ch-head"><div class="ch-tabs" role="tablist" aria-label="文件侧栏"><button type="button" role="tab" id="ch-tab-files" data-change="files" aria-controls="ch-panel">文件浏览</button><button type="button" role="tab" id="ch-tab-diff" data-change="diff" aria-controls="ch-panel">Diff</button></div><button type="button" class="pd-icon-btn" data-change="close" aria-label="关闭侧栏" title="关闭侧栏 · Esc">' + options.icon('x', 18) + '</button></header><section id="ch-panel" role="tabpanel" class="ch-panel" tabindex="-1"></section>';
      v.body = pane.querySelector('.ch-panel'); pane.hidden = false; layout.classList.add('has-changes'); mark(true);
      pane.onclick = function (e) {
        var item = e.target.closest('[data-change-file]');
        if (item) {
          var index = +item.dataset.changeFile;
          if (v.tab === 'diff') showDiff(v, index);
          else { var f = v.directory.entries[index]; if (f.isDir) directory(v, f.path); else preview(v, f); }
          return;
        }
        var b = e.target.closest('[data-change]'); if (!b) return;
        var act = b.dataset.change;
        if (act === 'close') close();
        else if (act === 'files' || act === 'diff') tab(v, act);
        else if (act === 'up') directory(v, v.directory.path.split('/').slice(0, -1).join('/'));
        else if (act === 'back') { if (v.tab === 'diff') diffList(v); else directory(v, v.directory.path, true); }
        else if (act === 'retry' && v.retry) v.retry();
        else if (act === 'external' && v.file) v.options.openFile(v.file);
      };
      v.resize = new ResizeObserver(function () { if (v.list) drawList(v); else if (v.worker) codePage(v); }); v.resize.observe(pane);
    }
    if (options.diff) {
      v.cache.clear(); v.cacheBytes = 0; v.positions.clear();
      v.diff = { files: options.diff.files, source: options.diff.source, selected: options.diff.index || 0, top: 0, filter: '' };
      tab(v, 'diff');
    } else if (!v.tabStarted) tab(v, 'files');
    v.pane.querySelector('[data-change="' + v.tab + '"]').focus({ preventScroll: true });
  }
  function tab(v, name) {
    v.tab = name; v.tabStarted = true;
    v.pane.querySelectorAll('[role="tab"]').forEach(function (b) { var selected = b.dataset.change === name; b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1; });
    v.body.setAttribute('aria-labelledby', 'ch-tab-' + name);
    if (name === 'files') directory(v, v.directory.path, true);
    else if (v.diff.files && v.diff.selected >= 0) showDiff(v, v.diff.selected);
    else diffList(v);
  }
  function message(v, text, retry) { v.scroll.innerHTML = '<div class="ch-empty" role="status">' + esc(text) + (retry ? button('retry', '重试') : '') + '</div>'; }
  function frame(v, back, title, source) {
    cancel(v);
    v.list = null; v.file = null;
    v.body.innerHTML = '<div class="ch-location">' + (back ? button(back, '←') : '') + '<span title="' + esc(title) + '">' + esc(title) + '</span></div>' +
      (source ? '<div class="ch-source">' + esc(source) + '</div>' : '') + '<div class="ch-scroll" tabindex="0"></div>';
    var backButton = v.body.querySelector('[data-change="' + back + '"]'); if (backButton) backButton.setAttribute('aria-label', back === 'up' ? '上一级文件夹' : '返回文件列表');
    v.scroll = v.body.querySelector('.ch-scroll');
  }
  function load(v, task, done, retry) {
    var generation = v.generation, expired = false;
    v.controller = new AbortController(); v.retry = retry; v.scroll.setAttribute('aria-busy', 'true'); message(v, '正在加载…');
    v.slow = setTimeout(function () { if (active === v && generation === v.generation) message(v, '正在等待电脑响应，请稍候…'); }, 3000);
    v.timer = setTimeout(function () { if (active === v && generation === v.generation) { expired = true; v.controller.abort(); message(v, '等待电脑响应超时', true); v.scroll.setAttribute('aria-busy', 'false'); } }, 45000);
    Promise.resolve().then(function () { if (active === v && generation === v.generation) return task(v.controller.signal); }).then(function (result) {
      if (active !== v || generation !== v.generation || expired) return;
      clearTimeout(v.timer); clearTimeout(v.slow); v.scroll.setAttribute('aria-busy', 'false'); done(result);
    }).catch(function (error) {
      if (active !== v || generation !== v.generation || v.controller.signal.aborted) return;
      clearTimeout(v.timer); clearTimeout(v.slow); v.scroll.setAttribute('aria-busy', 'false'); message(v, error.message || '加载失败', true);
    });
  }
  function directory(v, path, reuse) {
    var d = v.directory; if (d.path !== path) { d.path = path; d.entries = null; d.top = 0; d.filter = ''; }
    frame(v, path ? 'up' : '', path || v.options.rootName, '当前会话目录');
    if (reuse && d.entries) { showList(v, d.entries, d); return; }
    load(v, function (signal) { return v.options.list(path, signal); }, function (entries) { d.entries = entries; showList(v, entries, d); }, function () { directory(v, path); });
  }
  function diffList(v) {
    v.diff.selected = -1;
    frame(v, '', '变更文件', v.diff.source || '');
    if (v.diff.files) { showList(v, v.diff.files, v.diff); return; }
    load(v, v.options.loadDiffs, function (result) { v.diff.files = result.files; v.diff.source = result.source; diffList(v); }, function () { diffList(v); });
  }
  function showList(v, entries, state) {
    if (!entries.length) { message(v, v.tab === 'diff' ? '没有文件改动' : '这个文件夹是空的'); return; }
    if (entries.length > 100) {
      var filter = document.createElement('input'); filter.className = 'pd-input ch-filter'; filter.placeholder = '筛选文件…'; filter.setAttribute('aria-label', '筛选文件'); filter.value = state.filter;
      v.body.insertBefore(filter, v.scroll);
      filter.oninput = function () { clearTimeout(v.filterTimer); v.filterTimer = setTimeout(function () { if (active !== v) return; state.filter = filter.value; state.top = 0; indexList(v, state); }, 120); };
    }
    v.list = v.scroll; v.listEntries = entries;
    v.names = entries.map(function (f) { return String(f.path).normalize('NFC').toLowerCase(); });
    v.list.onscroll = function () { state.top = v.list.scrollTop; if (!v.frame) v.frame = requestAnimationFrame(function () { v.frame = 0; drawList(v); }); };
    indexList(v, state);
  }
  function indexList(v, state) {
    var query = state.filter.trim().normalize('NFC').toLowerCase(); v.filtered = [];
    v.names.forEach(function (name, i) { if (!query || name.includes(query)) v.filtered.push(i); });
    v.list.innerHTML = '<div class="ch-list-space"></div>'; v.space = v.list.firstElementChild; v.space.style.height = v.filtered.length * ROW + 'px'; v.list.scrollTop = state.top; drawList(v);
  }
  function drawList(v) {
    if (active !== v || !v.list) return;
    if (!v.filtered.length) { v.space.innerHTML = '<div class="ch-empty">没有匹配的文件</div>'; return; }
    var start = Math.max(0, Math.floor(v.list.scrollTop / ROW) - 4), end = Math.min(v.filtered.length, start + Math.ceil(v.list.clientHeight / ROW) + 10), html = '';
    for (var n = start; n < end; n++) {
      var i = v.filtered[n], f = v.listEntries[i], path = String(f.path), parts = path.split('/'), name = parts.pop();
      html += '<button type="button" class="ch-file" data-change-file="' + i + '" title="' + esc(path) + '" style="top:' + n * ROW + 'px">' + v.options.icon(f.isDir ? 'folder' : v.tab === 'diff' ? 'git-compare' : 'file-text', 16) + '<span><strong>' + esc(name) + '</strong>' + (v.tab === 'diff' && parts.length ? '<small>' + esc(parts.join('/')) + '</small>' : '') + '</span>' +
        (v.tab === 'diff' ? '<small class="ch-stat">' + (f.binary ? '二进制' : f.added == null ? '' : '+' + f.added + ' −' + (f.removed || 0)) + '</small>' : '') + '</button>';
    }
    v.space.innerHTML = html;
  }
  function preview(v, file) {
    frame(v, 'back', file.name || file.path, '当前文件'); v.file = file;
    v.body.querySelector('.ch-location').insertAdjacentHTML('beforeend', button('external', '外部打开'));
    if (v.options.isImage(file.path)) {
      if (file.size > 8 * 1024 * 1024) { message(v, '图片较大，请在外部打开'); return; }
      v.scroll.innerHTML = '<img class="ch-image" alt="' + esc(file.name) + '" src="' + esc(v.options.fileURL(file.path)) + '">'; v.scroll.firstElementChild.onerror = function () { if (active === v && v.file === file) message(v, '无法预览图片，请在外部打开'); }; return;
    }
    load(v, function (signal) { return v.options.read(file.path, signal); }, function (result) {
      if (result.text.indexOf('\0') >= 0) { message(v, '此文件不支持文本预览，请在外部打开'); return; }
      v.scroll.innerHTML = (result.truncated ? '<p class="ch-source">文件较大，仅预览前 256 KB</p>' : '') + '<pre class="ch-file-text">' + esc(result.text) + '</pre>';
    }, function () { preview(v, file); });
  }
  function cache(v, index, text) {
    var bytes = text.length * 2; if (bytes > CACHE_LIMIT) return;
    while (v.cache.size && (v.cache.size >= 4 || v.cacheBytes + bytes > CACHE_LIMIT)) { var key = v.cache.keys().next().value; v.cacheBytes -= v.cache.get(key).length * 2; v.cache.delete(key); }
    v.cache.set(index, text); v.cacheBytes += bytes;
  }
  function showDiff(v, index) {
    var f = v.diff.files[index]; if (!f) { diffList(v); return; }
    v.diff.selected = index; frame(v, 'back', f.path, v.diff.source);
    load(v, function (signal) { return v.cache.has(index) ? v.cache.get(index) : v.options.loadDiff(f, signal); }, function (text) {
      if (text == null) { message(v, f.binary ? '二进制文件没有文本差异' : '没有可展示的差异'); return; }
      if (!v.cache.has(index)) cache(v, index, text);
      var generation = v.generation; v.worker = new Worker('/admin/change-worker.js'); v.total = 0; v.start = -1;
      function failed(text) { clearTimeout(v.timer); v.worker.terminate(); v.worker = null; v.sendPage = null; v.busy = false; message(v, text, true); }
      function deadline() { clearTimeout(v.timer); v.timer = setTimeout(function () { if (active === v && generation === v.generation) failed('差异渲染超时，请重试'); }, 10000); }
      v.worker.onerror = function () { if (active === v && generation === v.generation) failed('差异渲染失败'); };
      v.worker.onmessage = function (event) {
        if (active !== v || generation !== v.generation) return;
        var data = event.data; clearTimeout(v.timer); v.busy = false;
        if (data.type === 'error') { failed(data.message); return; }
        if (data.type === 'ready') {
          v.total = data.total;
          if (!v.total) { message(v, '没有可展示的差异'); return; }
          v.scroll.classList.add('ch-code-scroll'); v.scroll.innerHTML = '<div class="ch-code-space" style="height:' + v.total * LINE + 'px"></div>'; v.space = v.scroll.firstElementChild;
          v.scroll.scrollTop = v.positions.get(index) || 0;
          v.scroll.onscroll = function () { v.positions.delete(index); v.positions.set(index, v.scroll.scrollTop); if (v.positions.size > 100) v.positions.delete(v.positions.keys().next().value); if (!v.frame) v.frame = requestAnimationFrame(function () { v.frame = 0; codePage(v); }); };
          v.sendPage = function (start) { v.busy = true; deadline(); v.worker.postMessage({ type: 'page', start: start }); }; codePage(v); return;
        }
        if (data.type === 'page') {
          v.start = data.start;
          if (v.pending != null && v.pending !== data.start) { var pending = v.pending; v.pending = null; v.sendPage(pending); return; }
          v.pending = null;
          v.space.innerHTML = data.rows.map(function (r, i) { return '<div class="ch-code-row ' + r.kind + '" style="top:' + (data.start + i) * LINE + 'px"><span class="ch-number">' + (r.old == null ? '' : r.old) + '</span><span class="ch-number">' + (r.next == null ? '' : r.next) + '</span><span class="ch-sign">' + (r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : '') + '</span><code>' + r.html + '</code></div>'; }).join('');
        }
      };
      deadline(); v.worker.postMessage({ type: 'init', text: text });
    }, function () { showDiff(v, index); });
  }
  function codePage(v) {
    if (active !== v || !v.worker || !v.sendPage || !v.total) return;
    var start = Math.min(Math.max(0, v.total - 160), Math.floor(Math.max(0, v.scroll.scrollTop / LINE - 30) / 80) * 80);
    if (v.busy) { v.pending = start; return; }
    if (start !== v.start) v.sendPage(start);
  }
  document.addEventListener('keydown', function (e) {
    var v = active;
    if (!v || e.isComposing || e.keyCode === 229 || !v.pane.contains(e.target) || document.getElementById('modal-root').childElementCount) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.target.getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); tab(v, v.tab === 'files' ? 'diff' : 'files'); v.pane.querySelector('[aria-selected="true"]').focus(); }
  });
  window.PDChanges = { open: open, close: close, toggle: function (options) { if (active) close(); else open(options); }, isOpen: function () { return !!active; } };
}());
