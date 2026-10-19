/**
 * 桌面端：布局对齐微信桌面版——左侧图标栏、中间列表、右侧内容。
 * 会话、聊天、审批、文件传输助手与手机端共用同一组接口（以「电脑」身份），两端记录与状态保持一致；
 * 桌面端特有：生成配对二维码、管理手机工作空间、电脑端设置。
 */
(function () {
  'use strict';

  var P = '/admin/p';
  var app = document.getElementById('app');
  var modalRoot = document.getElementById('modal-root');
  var AGENT = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', dsh: 'DSH' };
  var SETTINGS = [
    ['overview', '概览', 'layout-grid'],
    ['workspaces', '权限', 'key-round'],
    ['devices', '配对', 'smartphone'],
    ['transfer', '传输', 'arrow-up-down'],
    ['security', '安全', 'shield'],
    ['appearance', '外观', 'palette'],
    ['about', '关于', 'info']
  ];

  /* ---------- 基础工具 ---------- */

  /** esc：转义 HTML */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** api：调用接口，失败时抛出带提示文字的错误 */
  function api(method, path, body, wait, signal) {
    var controller = new AbortController(), expired = false;
    function cancel() { controller.abort(); }
    if (signal) { if (signal.aborted) { cancel(); } else { signal.addEventListener('abort', cancel, { once: true }); } }
    var timer = setTimeout(function () { expired = true; controller.abort(); }, wait === undefined ? 60000 : wait);
    return fetch(path, {
      signal: controller.signal,
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (res) {
      return res.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!res.ok) { var err = new Error((data && data.message) || '操作失败'); err.code = data && data.code; err.status = res.status; throw err; }
        return data;
      });
    }).catch(function (error) {
      if (expired) { var timeout = new Error('等待电脑响应超时，请重试或确认操作结果'); timeout.code = 'timeout'; throw timeout; }
      throw error;
    }).finally(function () { clearTimeout(timer); if (signal) { signal.removeEventListener('abort', cancel); } });
  }

  /** uploadForm：以表单上传文件 */
  function uploadForm(url, files) {
    var fd = new FormData();
    files.forEach(function (f) { fd.append('file', f, f.name); });
    return fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) { throw new Error((data && data.message) || '上传失败'); }
        return data;
      });
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  /** store：本机偏好（未读数、已删除的消息、外观），读写失败时忽略 */
  function load(key, def) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  }
  function save(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 无痕模式等情况不保存 */ }
  }

  /** copyText：复制到剪贴板 */
  function copyText(text) {
    var done = function () { toast('已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { copyFallback(text); done(); });
    } else {
      copyFallback(text);
      done();
    }
  }
  function copyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    ta.remove();
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  /** fmtTime：固定为中文 24 小时制 */
  function fmtTime(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  /** listTime：会话列表时间（今天显示时分，昨天显示「昨天」，其余显示月/日） */
  function listTime(ms) {
    if (!ms) { return ''; }
    var d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) { return '昨天'; }
    return d.getFullYear() === now.getFullYear() ? (d.getMonth() + 1) + '/' + d.getDate() : d.getFullYear() % 100 + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  /** chatTime：聊天中的时间分隔 */
  function chatTime(ms) {
    var d = new Date(ms), now = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) { return hm; }
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) { return '昨天 ' + hm; }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }
  function fmtSize(n) {
    if (!n && n !== 0) { return ''; }
    if (n < 1024) { return n + ' B'; }
    if (n < 1048576) { return (n / 1024).toFixed(1) + ' K'; }
    if (n < 1073741824) { return (n / 1048576).toFixed(1) + ' M'; }
    return (n / 1073741824).toFixed(2) + ' G';
  }
  function isImage(name) { return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || ''); }
  function oneLine(s, n) {
    var t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* ---------- 外观 ---------- */
  function applyTheme() {
    var t = load('pd.theme', 'system');
    if (window.PDX && PDX.applyStyle) { PDX.applyStyle(); }
    if (t === 'system') { document.documentElement.removeAttribute('data-theme'); } else { document.documentElement.setAttribute('data-theme', t); }
  }
  applyTheme();

  /* ---------- Markdown ---------- */

  /** inline：行内格式（先转义再替换） */
  function inline(s) {
    var codes = [];
    s = esc(s).replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[+i] + '</code>'; });
  }

  var mermaidCache = {}, mermaidLoad = null, mermaidTimer = 0, mermaidZoom = {};

  /** mermaidStyle：图表的缩放样式，1 倍时按窗口宽度自适应，其他倍数按图表原始宽度缩放 */
  function mermaidStyle(code, svg) {
    var z = mermaidZoom[code] || 1, w = /viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+)/.exec(svg || '');
    return z === 1 || !w ? '' : ' data-z="1" style="--w:' + w[1] + 'px;--z:' + z + '"';
  }

  /** mermaidStep：放大、缩小或还原，倍数保存在图表代码上，聊天刷新后仍保持 */
  function mermaidStep(box, how) {
    var el = box.querySelector('.pd-mermaid'), code = el.dataset.code, svg = el.innerHTML;
    var z = how === 'reset' ? 1 : Math.min(6, Math.max(0.25, (mermaidZoom[code] || 1) * (how === 'in' ? 1.25 : 0.8)));
    mermaidZoom[code] = Math.round(z * 100) / 100;
    var w = /viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+)/.exec(svg);
    if (mermaidZoom[code] === 1 || !w) { el.removeAttribute('data-z'); el.style.removeProperty('--w'); el.style.removeProperty('--z'); }
    else { el.dataset.z = '1'; el.style.setProperty('--w', w[1] + 'px'); el.style.setProperty('--z', mermaidZoom[code]); }
    var pct = box.querySelector('[data-act="mm-zoom"][data-d="reset"]');
    if (pct) { pct.textContent = Math.round(mermaidZoom[code] * 100) + '%'; }
  }

  /** mermaidDark：当前是否深色主题 */
  function mermaidDark() {
    var t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /** mermaidBlock：图表块；画好的直接给出，没画好的先显示代码，稍后统一绘制 */
  function mermaidBlock(code) {
    var svg = mermaidCache[(mermaidDark() ? 'd' : 'l') + code];
    var z = mermaidZoom[code] || 1;
    var bar = '<div class="pd-code-bar"><span>图表</span><span><button class="pd-icon-btn" data-act="mm-zoom" data-d="out" title="缩小" aria-label="缩小">' + icon('zoom-out', 14) + '</button>' +
      '<button class="pd-link" data-act="mm-zoom" data-d="reset" title="还原" aria-label="还原缩放">' + Math.round(z * 100) + '%</button>' +
      '<button class="pd-icon-btn" data-act="mm-zoom" data-d="in" title="放大" aria-label="放大">' + icon('zoom-in', 14) + '</button>' +
      '<button class="pd-icon-btn" data-act="save-img" data-kind="mermaid" title="下载图片" aria-label="下载图片">' + icon('download', 14) + '</button></span></div>';
    if (svg) { return '<div class="pd-code pd-mermaid-box">' + bar + '<div class="pd-mermaid" data-code="' + esc(code) + '"' + mermaidStyle(code, svg) + '>' + svg + '</div></div>'; }
    clearTimeout(mermaidTimer);
    mermaidTimer = setTimeout(mermaidScan, 400);
    return '<div class="pd-code pd-mermaid-box">' + bar + '<div class="pd-mermaid pd-mermaid-todo" data-code="' + esc(code) + '"><pre>' + esc(code) + '</pre></div></div>';
  }

  /** mermaidPng：把图表画成 PNG（导出时改用不含网页元素的文字标签，避免画布被浏览器锁定） */
  function mermaidPng(code) {
    var dark = mermaidDark();
    mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } });
    return mermaid.render('mx' + Date.now(), code).then(function (r) {
      var el = new DOMParser().parseFromString(r.svg, 'image/svg+xml').documentElement;
      var vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      var w = vb[2] || parseFloat(el.getAttribute('width')) || 800, h = vb[3] || parseFloat(el.getAttribute('height')) || 600;
      el.setAttribute('width', w);
      el.setAttribute('height', h);
      el.removeAttribute('style');
      return new Promise(function (ok, no) {
        var img = new Image();
        img.onload = function () {
          var k = Math.min(3, 4096 / Math.max(w, h)), c = document.createElement('canvas');
          c.width = Math.ceil(w * k);
          c.height = Math.ceil(h * k);
          var g = c.getContext('2d');
          g.fillStyle = dark ? '#1c1c1e' : '#ffffff';
          g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(function (b) { b ? ok(b) : no(new Error('生成图片失败')); }, 'image/png');
        };
        img.onerror = function () { no(new Error('生成图片失败')); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(el));
      });
    }).then(function (b) {
      document.querySelectorAll('[id^="dmx"]').forEach(function (x) { x.remove(); });
      return b;
    });
  }

  /** codePng：把代码画成 PNG */
  function codePng(text) {
    var dark = mermaidDark(), k = 2, font = '13px ui-monospace, Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace';
    var lines = text.replace(/\t/g, '    ').split('\n');
    if (lines.length > 800) { lines = lines.slice(0, 800).concat(['…']); }
    var m = document.createElement('canvas').getContext('2d');
    m.font = font;
    var w = Math.min(2400, Math.ceil(Math.max.apply(null, lines.map(function (l) { return m.measureText(l).width; }))) + 32), h = lines.length * 20 + 32;
    var c = document.createElement('canvas');
    c.width = w * k;
    c.height = h * k;
    var g = c.getContext('2d');
    g.scale(k, k);
    g.fillStyle = dark ? '#1f1f1f' : '#f2f2f2';
    g.fillRect(0, 0, w, h);
    g.fillStyle = dark ? '#d4d4d4' : '#24292f';
    g.font = font;
    g.textBaseline = 'top';
    lines.forEach(function (l, i) { g.fillText(l, 16, 16 + i * 20 + 3); });
    return new Promise(function (ok, no) { c.toBlob(function (b) { b ? ok(b) : no(new Error('生成图片失败')); }, 'image/png'); });
  }

  /** saveImage：生成图片并存到电脑的「下载」文件夹 */
  function saveImage(btn) {
    var box = btn.closest('.pd-code');
    var make;
    if (btn.dataset.kind === 'mermaid') {
      var code = box.querySelector('.pd-mermaid').dataset.code;
      make = function () {
        return (mermaidLoad || (mermaidLoad = new Promise(function (ok, no) {
          var sc = document.createElement('script');
          sc.src = '/admin/mermaid.min.js';
          sc.onload = ok;
          sc.onerror = function () { mermaidLoad = null; no(new Error('图表组件加载失败')); };
          document.head.appendChild(sc);
        }))).then(function () { return mermaidPng(code); });
      };
    } else {
      make = function () { return codePng(box.querySelector('code').textContent); };
    }
    toast('正在生成图片…');
    make().then(function (blob) {
      var name = (btn.dataset.kind === 'mermaid' ? '图表' : '代码') + '-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      return fetch('/admin/api/save-image?name=' + encodeURIComponent(name), { method: 'POST', body: blob, credentials: 'same-origin' }).then(function (res) {
        if (res.ok) { toast('已保存到「下载」文件夹'); return; }
        return res.json().catch(function () { return null; }).then(function (d) { throw new Error((d && d.message) || '保存失败'); });
      });
    }).catch(function (er) { toast(er.message); });
  }

  /** mermaidScan：按需加载绘图库，把待画的图表画出来；语法有误的保留原代码 */
  function mermaidScan() {
    var todo = document.querySelectorAll('.pd-mermaid-todo');
    if (!todo.length) { return; }
    mermaidLoad = mermaidLoad || new Promise(function (ok, no) {
      var sc = document.createElement('script');
      sc.src = '/admin/mermaid.min.js';
      sc.onload = ok;
      sc.onerror = function () { mermaidLoad = null; no(new Error('图表组件加载失败')); };
      document.head.appendChild(sc);
    });
    mermaidLoad.then(function () {
      var dark = mermaidDark();
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
      return Array.prototype.reduce.call(todo, function (chain, el, i) {
        return chain.then(function () {
          var code = el.dataset.code;
          return mermaid.render('mm' + Date.now() + '_' + i, code).then(function (r) {
            mermaidCache[(dark ? 'd' : 'l') + code] = r.svg;
            if (el.isConnected) {
              el.classList.remove('pd-mermaid-todo');
              el.innerHTML = r.svg;
              var st = mermaidStyle(code, r.svg), zw = /--w:([^;]+);--z:([^"]+)"/.exec(st);
              if (zw) { el.dataset.z = '1'; el.style.setProperty('--w', zw[1]); el.style.setProperty('--z', zw[2]); }
            }
          }, function () {
            document.querySelectorAll('[id^="dmm"]').forEach(function (x) { x.remove(); });
            el.classList.remove('pd-mermaid-todo');
          });
        });
      }, Promise.resolve());
    }).catch(function () {});
  }

  /** md：把 Agent 回复的 Markdown 转为 HTML（标题、列表、引用、表格、代码块） */
  function md(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [], i = 0, para = [];
    function flush() { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } }
    while (i < lines.length) {
      var l = lines[i];
      var fence = /^\s*```\s*([\w+-]*)/.exec(l);
      if (fence) {
        flush();
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        if (/^mermaid$/i.test(fence[1])) { out.push(mermaidBlock(code.join('\n'))); continue; }
        out.push('<div class="pd-code"><div class="pd-code-bar"><span>' + esc(fence[1] || '代码') + '</span><span><button class="pd-icon-btn" data-act="save-img" data-kind="code" title="保存为图片" aria-label="保存为图片">' + icon('image', 14) + '</button><button class="pd-icon-btn" data-act="copy-code" title="复制代码" aria-label="复制代码">' + icon('copy', 14) + '</button></span></div><pre><code>' + esc(code.join('\n')) + '</code></pre></div>');
        continue;
      }
      var h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) { flush(); var lv = Math.min(h[1].length, 4); out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'); i++; continue; }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(l)) {
        flush();
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + md(q.join('\n')) + '</blockquote>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        var cells = function (row) { return row.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }); };
        var head = cells(l);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push('<table><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr>' +
          rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>');
        continue;
      }
      var li = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(l);
      if (li) {
        flush();
        var ordered = /\d/.test(li[2]);
        var items = [];
        while (i < lines.length) {
          var m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
          if (!m) {
            if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += '\n' + lines[i].trim(); i++; continue; }
            break;
          }
          items.push(m[3]);
          i++;
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.map(function (t) {
          var task = /^\[( |x|X)\]\s+(.*)$/.exec(t);
          return '<li>' + (task ? (task[1] === ' ' ? '☐ ' : '☑ ') + inline(task[2]) : inline(t).replace(/\n/g, '<br>')) + '</li>';
        }).join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (!l.trim()) { flush(); i++; continue; }
      para.push(l);
      i++;
    }
    flush();
    return out.join('');
  }

  /* ---------- 头像 ---------- */
  function avatarHtml(kind, small) {
    var cls = 'pd-avatar' + (small ? ' pd-avatar-s' : '');
    // 头像设置（含「我」）优先；没有时再画默认图标
    var custom = (AGENT[kind] || kind === 'host') ? PDX.avatarHtml(kind, small) : '';
    if (custom) { return custom; }
    if (AGENT[kind]) { return '<div class="' + cls + '"><img alt="" src="/admin/avatars/' + kind + '.svg"></div>'; }
    if (kind === 'assistant') { return '<div class="' + cls + '" style="background:var(--pd-tile-green)">' + icon('send', small ? 18 : 20) + '</div>'; }
    if (kind === 'terminal') { return '<div class="' + cls + '" style="background:var(--pd-tile-ink)">' + icon('terminal', small ? 18 : 20) + '</div>'; }
    if (kind === 'phone') { return '<div class="' + cls + '" style="background:var(--pd-tile-teal)">' + icon('smartphone', small ? 18 : 20) + '</div>'; }
    if (kind === 'host') { return '<div class="' + cls + '" style="background:var(--pd-accent)">' + icon('monitor', small ? 18 : 20) + '</div>'; }
    return '<div class="' + cls + '" style="background:var(--pd-tile-indigo)">' + icon('bot', 20) + '</div>';
  }
  function tileHtml(name, color) { return '<span class="pd-tile" style="background:' + color + '">' + icon(name, 16) + '</span>'; }

  /* ---------- 状态 ---------- */
  var host = null;               // 电脑端状态（设置页用）
  var sessions = [];             // 会话列表，与手机端相同
  var logs = {};                 // 会话 ID → { events, last, loaded }
  var unread = load('pd.unread', {});
  var hidden = load('pd.hidden', {});
  var hiddenSess = load('pd.hiddenSessions', {});   // 只在电脑端删除的会话，手机端不受影响
  var query = '';
  var selMode = false, selected = {};   // 批量清理：是否在多选、已勾选的会话
  var pending = [];              // 当前会话待发送的附件 { name, path }
  var providerNames = {};        // 供应商 ID → 名称（标题栏显示）
  var shownRequests = {};
  var pairInfo = null, pairTimer = null, wsSig = '';

  /** route：#chat/会话、#files、#settings/分区、#pair */
  function route() {
    var h = location.hash.replace(/^#/, '');
    if (h === 'pair') { return { page: 'pair' }; }
    var m = /^settings\/?(\w*)/.exec(h);
    if (m) { return { page: 'settings', section: m[1] || 'overview' }; }
    if (h === 'phone' || h === 'files') { return { page: 'phone' }; }
    m = /^tools\/?(\w*)/.exec(h);
    if (m) { return { page: 'tools', sub: m[1] || 'clip' }; }
    m = /^contacts\/?(.*)$/.exec(h);
    if (m) { return { page: 'contacts', id: decodeURIComponent(m[1] || '') }; }
    m = /^chat\/(.+)$/.exec(h);
    return { page: 'chat', sid: m ? decodeURIComponent(m[1]) : '' };
  }

  function session(id) { return sessions.filter(function (s) { return s.id === id; })[0]; }
  function isAgent(s) { return !!AGENT[s.kind]; }

  /** title：列表与标题栏的会话名（与手机端规则一致） */
  function title(s) {
    if (!s) { return ''; }
    if (s.kind === 'assistant') { return '文件传输助手'; }
    // 通讯录模板会话的标题新建时就写好了（如「翻译 · Claude Code」）
    if (s.preset && (s.title || '').trim()) { return s.title.trim(); }
    var label = AGENT[s.kind] || (s.kind === 'terminal' ? '终端' : s.kind);
    var t = (s.title || '').trim();
    if (!t || t === label) { return s.kind === 'terminal' ? '终端' : label + ' · 新会话'; }
    return t.indexOf(label + ' · ') === 0 ? t : label + ' · ' + t;
  }

  function totalUnread() { return sessions.reduce(function (n, s) { return hiddenSess[s.id] ? n : n + (unread[s.id] || 0); }, 0); }
  /** hideSession：只在电脑端删除会话，同时清掉未读 */
  function hideSession(id) { hiddenSess[id] = true; save('pd.hiddenSessions', hiddenSess); setUnread(id, 0); }
  /** unhideSession：删除过的会话有新消息或被再次打开时重新显示 */
  function unhideSession(id) { if (hiddenSess[id]) { delete hiddenSess[id]; save('pd.hiddenSessions', hiddenSess); } }
  function setUnread(id, n) {
    if (n) { unread[id] = n; } else { delete unread[id]; }
    save('pd.unread', unread);
    var t = totalUnread();
    document.title = (t ? '(' + t + ') ' : '') + 'PocketDesk';
  }

  /** countsUnread：桌面端视角算作新消息的事件（手机发来的也算） */
  function countsUnread(e) {
    var d = e.data || {};
    switch (e.type) {
      case 'msg.done': case 'approval.request': case 'error': return true;
      case 'msg.user': return e.session === 'assistant';
      case 'file': return d.direction === 'up';
      default: return false;
    }
  }

  /** summarize：按事件更新列表中的状态与摘要（与手机端规则一致） */
  function summarize(s, e) {
    var d = e.data || {};
    var at = e.createdAt || Date.now();
    s.lastSeq = Math.max(s.lastSeq || 0, e.seq || 0);
    switch (e.type) {
      case 'state': s.state = d.state; s.updatedAt = at; break;
      case 'msg.user': s.preview = (e.session === 'assistant' ? '手机：' : '你：') + oneLine(d.text, 60); s.updatedAt = at; break;
      case 'msg.host': s.preview = '电脑：' + oneLine(d.text, 60); s.updatedAt = at; break;
      case 'msg.done': s.preview = oneLine(d.text, 60); s.updatedAt = at; break;
      case 'approval.request': s.preview = '待确认：' + oneLine(d.summary, 50); s.updatedAt = at; break;
      case 'error': s.preview = '出错：' + oneLine(d.message, 50); s.updatedAt = at; break;
      case 'diff.summary': s.preview = '已完成：改动了 ' + (d.files || []).length + ' 个文件'; s.updatedAt = at; break;
      case 'file': s.preview = (isImage(d.name) ? '[图片] ' : '[文件] ') + d.name; s.updatedAt = at; break;
      case 'session.model': s.model = d.model; break;
    }
  }

  function loadSessions() {
    return api('GET', P + '/api/sessions').then(function (list) {
      sessions = list || [];
      renderList();
      if (route().page === 'chat') { renderHead(); }
    });
  }

  /** loadLog：会话最近的记录 */
  function appendLog(lg, e) {
    if (e.seq <= lg.last) { return; }
    if (e.type === 'history.reset') { lg.events = []; }
    lg.events.push(e); lg.last = e.seq;
  }
  function loadLog(id) {
    var lg = logs[id] || (logs[id] = { events: [], last: 0, loaded: false });
    if (lg.loaded) { return Promise.resolve(lg); }
    if (lg.loading) { return lg.loading; }
    lg.pending = lg.pending || [];
    function more() {
      return api('GET', P + '/api/sessions/' + encodeURIComponent(id) + '/events?after=' + lg.last + '&limit=500').then(function (evs) {
        (evs || []).forEach(function (e) { appendLog(lg, e); });
        if (evs && evs.length >= 500) { return more(); }
      });
    }
    lg.loading = api('GET', P + '/api/sessions/' + encodeURIComponent(id) + '/events?before=' + Number.MAX_SAFE_INTEGER + '&limit=2000').then(function (evs) {
      (evs || []).sort(function (a, b) { return a.seq - b.seq; }).forEach(function (e) { appendLog(lg, e); });
      return more();
    }).then(function () {
      lg.pending.sort(function (a, b) { return a.seq - b.seq; }).forEach(function (e) { appendLog(lg, e); });
      lg.pending = []; lg.loaded = true;
      return lg;
    }).finally(function () { lg.loading = null; });
    return lg.loading;
  }

  /**
   * buildItems：事件合成聊天条目（与手机端 ChatLog 规则一致）
   *
   * 流式片段合并为一条回复，工具开始与结束合并为一张卡片，审批请求与结果合并。
   */
  function buildItems(events, includeHidden) {
    var resetAt = -1;
    events.forEach(function (e, i) { if (e.type === 'history.reset') { resetAt = i; } });
    if (resetAt >= 0) { events = (events[resetAt].data.events || []).concat(events.slice(resetAt + 1)); }
    var items = [], by = {};
    function add(key, it) { it.at = it.at || 0; items.push(it); if (key) { by[key] = it; } }
    events.forEach(function (e) {
      var d = e.data || {}, cur;
      var base = { seq: e.seq, at: e.createdAt, entryId: d.entryId || '' };
      switch (e.type) {
        case 'history.bind':
          (d.bindings || []).forEach(function (binding) {
            var it = binding.messageId ? by['m:' + binding.messageId] : items.filter(function (it) { return it.seq === binding.seq; })[0];
            if (it) { it.entryId = binding.entryId; }
          });
          break;
        case 'msg.user':
          // 新一轮开始：之前的回复与思考不再续写（有的 Agent 重启后编号从头开始，避免新回复并进旧气泡）
          if (!d.queued) { Object.keys(by).forEach(function (k) { if (k.indexOf('m:') === 0 || k.indexOf('t:') === 0) { delete by[k]; } }); }
          add(null, Object.assign(base, { t: 'user', text: d.text || '', attachments: d.attachments || [], skills: d.skills || [], queued: !!d.queued, phone: e.session === 'assistant' }));
          break;
        case 'msg.host':
          add(null, Object.assign(base, { t: 'host', text: d.text || '' }));
          break;
        case 'msg.delta':
          cur = by['m:' + d.id];
          if (cur) { cur.text += d.text || ''; } else { add('m:' + d.id, Object.assign(base, { t: 'agent', text: d.text || '', streaming: true })); }
          break;
        case 'msg.done':
          cur = by['m:' + d.id];
          if (cur) { cur.text = d.text || cur.text; cur.streaming = false; } else { add('m:' + d.id, Object.assign(base, { t: 'agent', text: d.text || '', streaming: false })); }
          break;
        case 'thinking':
          cur = by['t:' + d.id];
          if (!cur) {
            if (d.done && !d.text) { break; }
            cur = Object.assign(base, { t: 'think', text: '', done: false });
            add('t:' + d.id, cur);
          }
          if (d.delta) { cur.text += d.text || ''; } else if (d.text) { cur.text = d.text; }
          if (d.done) { cur.done = true; }
          break;
        case 'tool.start':
          add('tool:' + d.id, Object.assign(base, { t: 'tool', name: d.name, kind: d.kind, summary: d.summary || d.name, input: d.input || {}, output: '', done: false, error: false }));
          break;
        case 'tool.end':
          cur = by['tool:' + d.id];
          if (cur) { cur.output = d.output || ''; cur.error = !!d.isError; cur.done = true; }
          break;
        case 'approval.request':
          add('ap:' + d.id, Object.assign(base, { t: 'approval', id: d.id, tool: d.tool, kind: d.kind, summary: d.summary, input: d.input || {}, status: '' }));
          break;
        case 'approval.done':
          cur = by['ap:' + d.id];
          if (cur) { cur.status = d.status; }
          break;
        case 'diff.summary':
          add(null, Object.assign(base, { t: 'diff', files: d.files || [] }));
          break;
        case 'error':
          add(null, Object.assign(base, { t: 'sys', text: d.message, error: true, retryable: !!d.retryable }));
          break;
        case 'system':
          if (d.text === '已打断' || d.text === '电脑端服务已重启，会话已恢复') {
            items.forEach(function (it) { if (it.t === 'user' && it.queued) { it.queued = false; it.cancelled = true; } });
          } else if (d.text === '开始处理排队消息') {
            Object.keys(by).forEach(function (k) { if (k.indexOf('m:') === 0 || k.indexOf('t:') === 0) { delete by[k]; } });
            for (var qi = 0; qi < items.length; qi++) {
              if (items[qi].t === 'user' && items[qi].queued) { items[qi].queued = false; break; }
            }
          }
          if (d.text) { add(null, Object.assign(base, { t: 'sys', text: d.text })); }
          break;
        case 'file':
          add(null, Object.assign(base, { t: 'file', up: d.direction === 'up', name: d.name, size: d.size, path: d.path }));
          break;
      }
    });
    var hid = hidden[events.length && events[0].session] || [];
    return includeHidden ? items : items.filter(function (it) { return hid.indexOf(it.seq) < 0; });
  }

  /* ---------- 实时通道 ---------- */
  var sock = null, sockRetry = 1, refreshTimer = null;

  function connect() {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + P + '/ws';
    var ws;
    try { ws = new WebSocket(url); } catch (e) { return; }
    sock = ws;
    ws.onopen = function () {
      var cursors = {};
      Object.keys(logs).forEach(function (id) { if (logs[id].loaded) { cursors[id] = logs[id].last; } });
      ws.send(JSON.stringify({ type: 'hello', cursors: cursors }));
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (m.type === 'ready') { sockRetry = 1; return; }
      onEvent(m);
    };
    ws.onclose = function () {
      if (sock !== ws) { return; }
      sock = null;
      setTimeout(connect, Math.min(sockRetry, 15) * 1000);
      sockRetry *= 2;
    };
  }

  /** onEvent：实时事件更新列表、未读与打开中的聊天 */
  function onEvent(e) {
    if (!e.session) {
      if (e.type === 'session.created' || e.type === 'session.updated') {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(loadSessions, 300);
      } else if (e.type === 'library.changed') {
        PDX.onLibraryChanged(e.data);
      } else if (e.type === 'session.preview' && e.data) {
        var s0 = session(e.data.session);
        if (s0) { s0.preview = e.data.preview; renderList(); }
      }
      return;
    }
    var lg = logs[e.session];
    if (lg && lg.loaded) {
      if (e.seq <= lg.last) { return; }
      if (e.seq > lg.last + 1 && e.type !== 'history.reset' && session(e.session) && session(e.session).kind === 'pi') {
        lg.loaded = false; lg.pending = [e]; loadLog(e.session).then(scheduleChat).catch(function (error) { toast(error.message); });
      } else { appendLog(lg, e); }
    } else if (lg) { (lg.pending || (lg.pending = [])).push(e); }
    var s = session(e.session);
    if (!s) { clearTimeout(refreshTimer); refreshTimer = setTimeout(loadSessions, 300); return; }
    summarize(s, e);
    var r = route();
    var viewing = r.page === 'chat' && r.sid === e.session && document.visibilityState === 'visible';
    if (countsUnread(e)) { unhideSession(e.session); }
    if (countsUnread(e) && !viewing) { setUnread(e.session, (unread[e.session] || 0) + 1); }
    scheduleList();
    if (r.page === 'chat' && r.sid === e.session) { scheduleChat(); if (e.type === 'state' || e.type === 'session.model' || e.type === 'history.reset') { renderHead(); } }
  }

  // 流式片段频繁，合并到下一帧再重绘
  var listFrame = 0, chatFrame = 0;
  function scheduleList() { if (!listFrame) { listFrame = requestAnimationFrame(function () { listFrame = 0; renderList(); renderRail(); }); } }
  function scheduleChat() { if (!chatFrame) { chatFrame = requestAnimationFrame(function () { chatFrame = 0; renderMsgs(false); }); } }

  /** lastUserText：会话里最近一条我发出的文字（换 Agent 处理时带过去） */
  function lastUserText(sid) {
    var lg = logs[sid];
    if (!lg || !lg.loaded) { return ''; }
    var items = buildItems(lg.events.length ? lg.events : [{ session: sid }]);
    for (var i = items.length - 1; i >= 0; i--) { if (items[i].t === 'user' && !items[i].phone && items[i].text) { return items[i].text; } }
    return '';
  }

  /** redrawMain：重绘当前内容区；搜索框里正在输入时保住焦点与光标 */
  function redrawMain(keepFocus) {
    var id = keepFocus && document.activeElement ? document.activeElement.id : '', pos = id ? document.activeElement.selectionStart : 0;
    renderMain();
    if (id) { var el = document.getElementById(id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (er) { /* 不是文字框 */ } } }
  }

  PDX.init({
    api: api, toast: toast, esc: esc, icon: icon, modal: modal, closeModal: closeModal, confirmBox: confirmBox, copyText: copyText, load: load, save: save,
    popMenu: popMenu, fmtSize: fmtSize, listTime: listTime, oneLine: oneLine, tile: tileHtml, title: title, modalRoot: modalRoot,
    host: function () { return host; }, sessions: function () { return sessions; }, session: session, route: route, lastUserText: lastUserText,
    go: function (h) { location.hash = h; },
    redrawMain: redrawMain, redrawList: function () { renderList(); },
    redrawAll: function () { renderRail(); renderList(); renderMain(); },
    onCreated: function (s) { sessions.push(s); unhideSession(s.id); location.hash = 'chat/' + encodeURIComponent(s.id); },
    removeSession: function (id) { sessions = sessions.filter(function (x) { return x.id !== id; }); location.hash = 'chat'; }
  });

  /* ---------- 整体布局 ---------- */

  /**
   * render：按路由绘制三栏
   *
   * 处理流程：
   * 1、配对页单独占满窗口（独立的配对窗口使用）
   * 2、其余为图标栏 + 列表 + 内容，各部分可单独刷新
   */
  function render() {
    var r = route();
    // 1、配对
    if (r.page === 'pair') {
      app.innerHTML = '<div class="pd-pair">' + pairBody() + '</div>';
      return;
    }
    // 2、三栏
    app.innerHTML = '<div class="pd-shell"><nav class="pd-rail" id="rail"></nav><aside class="pd-list" id="list"></aside><div class="pd-resizer" id="resizer" title="拖动调整宽度"></div><main class="pd-main" id="main"></main></div>';
    renderRail();
    renderList();
    renderMain();
  }

  function renderRail() {
    var el = document.getElementById('rail');
    if (!el) { return; }
    var r = route(), n = totalUnread();
    var btn = function (go, ic, label, active, badge) {
      return '<button class="pd-rail-btn' + (active ? ' active' : '') + '" data-go="' + go + '" title="' + label + '" aria-label="' + label + '">' + icon(ic, 24) +
        (badge ? '<span class="pd-badge">' + (badge > 99 ? '99+' : badge) + '</span>' : '') + '</button>';
    };
    el.innerHTML = '<button class="pd-me" data-act="av-open" data-key="me" data-title="设置我的头像" title="点击更换我的头像" aria-label="我的头像">' + (PDX.avatarHtml('host') || icon('monitor', 20)) + '</button>' +
      btn('chat', 'message-circle', '消息', r.page === 'chat', n) +
      btn('contacts', 'users-round', '通讯录', r.page === 'contacts', 0) +
      btn('tools', 'toolbox', '工具箱', r.page === 'tools' || r.page === 'phone', 0) +
      '<div class="pd-rail-gap"></div>' +
      '<button class="pd-rail-btn" data-act="pair" title="配对新手机" aria-label="配对新手机">' + icon('smartphone', 22) + '</button>' +
      btn('settings', 'menu', '设置', r.page === 'settings', 0);
  }

  /** listWidthKey：左侧列表宽度的保存位置（设置页与其他页各记一份） */
  function listWidthKey() { return route().page === 'settings' ? 'pd.listw.narrow' : 'pd.listw'; }

  // 拖动中间的分隔条调整左右宽度
  document.addEventListener('mousedown', function (e) {
    if (!e.target.closest || !e.target.closest('#resizer')) { return; }
    var list = document.getElementById('list');
    if (!list) { return; }
    e.preventDefault();
    var startX = e.clientX, startW = list.offsetWidth, key = listWidthKey(), w = startW;
    document.body.classList.add('pd-resizing');
    function move(ev) {
      w = Math.max(120, Math.min(startW + ev.clientX - startX, Math.floor(window.innerWidth * 0.6)));
      list.style.width = w + 'px';
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('pd-resizing');
      save(key, w);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  document.addEventListener('dblclick', function (e) {
    if (e.target.closest && e.target.closest('#resizer')) {
      save(listWidthKey(), 0);
      var list = document.getElementById('list');
      if (list) { list.style.width = ''; }
    }
  });

  function renderList() {
    var el = document.getElementById('list');
    if (!el) { return; }
    var r = route();
    el.classList.toggle('narrow', r.page === 'settings');
    var lw = load(listWidthKey(), 0);
    el.style.width = lw ? lw + 'px' : '';
    if (r.page === 'chat') {
      var body = document.getElementById('rows');
      if (!body || el.dataset.sel !== (selMode ? '1' : '')) {
        el.dataset.sel = selMode ? '1' : '';
        el.innerHTML = '<div class="pd-list-top"><label class="pd-search">' + icon('search', 14) + '<input id="search" placeholder="搜索" value="' + esc(query) + '"></label>' +
          (selMode ? '' : '<button class="pd-plus" data-act="sel-start" title="批量清理" aria-label="批量清理">' + icon('list-checks', 16) + '</button>' +
          '<button class="pd-plus" data-act="new" title="新建会话" aria-label="新建会话">' + icon('plus', 16) + '</button>') + '</div><div class="pd-list-body" id="rows"></div>' +
          (selMode ? '<div class="pd-selbar" id="selbar"></div>' : '');
        body = el.querySelector('.pd-list-body');
      }
      body.innerHTML = sessionRows(r.sid);
      var bar = document.getElementById('selbar');
      if (bar) {
        var n = Object.keys(selected).length;
        bar.innerHTML = '<button class="pd-btn" data-act="sel-all">' + (n && n === visibleSessions().length ? '取消全选' : '全选') + '</button><span class="pd-muted pd-selcount">' + (n ? '已选 ' + n + ' 项' : '') + '</span>' +
          '<button class="pd-btn pd-btn-danger" data-act="sel-delete"' + (n ? '' : ' disabled') + '>删除</button><button class="pd-btn" data-act="sel-cancel">完成</button>';
      }
    } else if (r.page === 'phone') {
      el.innerHTML = '<div class="pd-list-top"><button class="pd-icon-btn" data-go="tools" title="返回工具箱" aria-label="返回工具箱">' + icon('chevron-left', 18) + '</button><div class="pd-list-title">工作区</div></div><div class="pd-list-body">' + fsRows() + '</div>';
    } else if (r.page === 'contacts' || r.page === 'tools') {
      var keep = document.activeElement && document.activeElement.id === 'contact-search';
      el.innerHTML = PDX.listHtml(r);
      if (keep) { var cs = document.getElementById('contact-search'); if (cs) { cs.focus(); cs.setSelectionRange(cs.value.length, cs.value.length); } }
    } else {
      el.innerHTML = '<div class="pd-list-top"><div class="pd-list-title">设置</div></div><div class="pd-list-body">' + SETTINGS.map(function (s) {
        return '<button class="pd-row' + (r.section === s[0] ? ' active' : '') + '" style="height:48px" data-go="settings/' + s[0] + '">' +
          '<span style="color:' + (r.section === s[0] ? 'inherit' : 'var(--pd-text-2)') + '">' + icon(s[2], 20) + '</span><span class="pd-row-title">' + s[1] + '</span></button>';
      }).join('') + '</div>';
    }
  }

  /** visibleSessions：列表里能看到的会话（置顶在前，按更新时间排列，按搜索词过滤） */
  function visibleSessions() {
    var q = query.trim().toLowerCase();
    return sessions.slice().sort(function (a, b) {
      if (!!b.pinned !== !!a.pinned) { return b.pinned ? 1 : -1; }
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    }).filter(function (s) { return !hiddenSess[s.id] && (!q || (title(s) + ' ' + (s.preview || '')).toLowerCase().indexOf(q) >= 0); });
  }

  /** sessionRows：会话列表 */
  function sessionRows(active) {
    var q = query.trim();
    var list = visibleSessions();
    if (!list.length) { return '<div class="pd-empty">' + (q ? '没有找到' : '还没有会话') + '</div>'; }
    return list.map(function (s) {
      var n = unread[s.id] || 0;
      var waiting = s.state === 'awaiting';
      var sub = esc(s.preview || '');
      if (waiting) { sub = '<span class="pd-red">[待审批]</span> ' + esc((s.preview || '').replace(/^待确认：/, '')); }
      else if (s.state === 'running') { sub = '执行中' + (s.preview ? ' · ' + sub : '…'); }
      var mark = n ? '<span class="pd-badge">' + (n > 99 ? '99+' : n) + '</span>' : waiting ? '<span class="pd-dot"></span>' : '';
      var pick = selMode ? '<span class="pd-check' + (selected[s.id] ? ' on' : '') + '">' + (selected[s.id] ? icon('check', 12) : '') + '</span>' : '';
      return '<button class="pd-row' + (!selMode && s.id === active ? ' active' : '') + (s.pinned && s.id !== active ? ' pinned' : '') + '" ' + (selMode ? 'data-act="sel-toggle" data-id="' : 'data-go="chat/' + encodeURIComponent(s.id) + '" data-sid="') + esc(s.id) + '">' + pick +
        '<div class="pd-row-avatar">' + (PDX.sessionAvatar(s) || avatarHtml(s.kind)) + mark + '</div>' +
        '<div class="pd-row-main"><div class="pd-row-line"><span class="pd-row-title">' + esc(title(s)) + '</span>' + (s.autoApprove ? '<span class="pd-tag-auto">免审批</span>' : '') +
        '<span class="pd-row-time">' + listTime(s.updatedAt) + '</span></div><div class="pd-row-sub">' + (sub || '&nbsp;') + '</div></div></button>';
    }).join('');
  }

  function renderMain() {
    var el = document.getElementById('main');
    if (!el) { return; }
    PDChanges.close(false);
    PDToolView.reset();
    var r = route();
    if (r.page !== 'chat') { PDX.detachTerminal(); }
    if (r.page === 'chat') { renderChat(); }
    else if (r.page === 'phone') { el.innerHTML = fsMain(); }
    else if (r.page === 'contacts' || r.page === 'tools') { PDX.ensure(r); el.innerHTML = PDX.mainHtml(r); }
    else { el.innerHTML = settingsMain(r.section); if (r.section === 'security') { loadAudit(); } }
  }

  /* ---------- 聊天窗口 ---------- */

  function renderChat() {
    var el = document.getElementById('main');
    var r = route(), s = session(r.sid);
    PDX.detachTerminal();
    if (s && s.kind === 'terminal') {
      el.innerHTML = PDX.terminalHtml(s);
      PDX.attachTerminal(s);
      return;
    }
    if (!s) {
      el.innerHTML = '<div class="pd-empty-main">' + icon('message-circle', 88) + '</div>';
      return;
    }
    var composer = s.kind === 'terminal' ? '<div class="pd-sys" style="margin:16px">终端请在手机上使用</div>' :
      '<div class="pd-composer pd-drop"><div class="pd-tools">' +
      '<button class="pd-icon-btn" data-act="attach" title="发送文件" aria-label="发送文件">' + icon('folder', 20) + '</button>' +
      '<button class="pd-icon-btn" data-act="attach-image" title="发送图片" aria-label="发送图片">' + icon('image', 20) + '</button>' +
      '<button class="pd-icon-btn" data-act="prompt-pick" title="提示词" aria-label="提示词">' + icon('book-marked', 20) + '</button>' +
      (isAgent(s) ? '<button class="pd-icon-btn" data-act="interrupt" title="打断" aria-label="打断"' + (s.state === 'running' || s.state === 'awaiting' ? '' : ' disabled') + '>' + icon('square', 18) + '</button>' : '') +
      '</div><div class="pd-cmds" id="cmds" hidden></div><div class="pd-pending" id="chosen"></div><div class="pd-pending" id="pending"></div><textarea id="input" placeholder="' + (isAgent(s) ? '输入 / 查看指令' : '') + '"></textarea>' +
      '<div class="pd-composer-foot"><span class="pd-hint">Enter 发送，Shift + Enter 换行；可直接粘贴或拖入图片、文件</span>' +
      '<button class="pd-btn pd-btn-primary" id="send" data-act="send" disabled>发送</button></div>' +
      '<input type="file" id="file-any" class="pd-file-input" multiple tabindex="-1" aria-hidden="true"><input type="file" id="file-img" class="pd-file-input" accept="image/*" multiple tabindex="-1" aria-hidden="true"></div>';
    el.innerHTML = '<header class="pd-head" id="head"></header><div class="pd-chat-layout" id="chat-layout"><div class="pd-chat-column"><div class="pd-msgs" id="msgs"><div class="pd-empty">正在加载…</div></div>' + composer + '</div><aside id="tool-inspector" class="pd-tool-inspector" aria-label="工具详情" hidden></aside><aside id="change-view" class="ch-view" aria-label="文件侧栏" hidden></aside></div>';
    renderHead();
    renderPending();
    renderChosen();
    // 接入过电脑上的会话时，补上电脑上新增的对话
    if (isAgent(s)) { api('POST', P + '/api/sessions/' + encodeURIComponent(s.id) + '/sync').catch(function () {}); }
    var draft = load('pd.draft', {})[s.id];
    var composition = historyCompositions[s.id];
    if (composition) { pending = (composition.attachments || []).map(function (path) { return { path: path, name: path.split('/').pop() }; }); chosenSkills[s.id] = composition.skills || []; renderPending(); renderChosen(); }
    var input = document.getElementById('input');
    if (input) { input.value = draft || ''; syncSend(); input.focus(); }
    loadLog(s.id).then(function () { if (route().sid === s.id) { renderMsgs(true); } }).catch(function (e) { toast(e.message); });
  }

  function renderHead() {
    var el = document.getElementById('head');
    var s = session(route().sid);
    if (!el || !s) { return; }
    var sub = [];
    if (isAgent(s)) {
      if (s.state === 'running') { sub.push('执行中'); } else if (s.state === 'awaiting') { sub.push('等待你确认'); }
      if (s.provider && providerNames[s.provider]) { sub.push(providerNames[s.provider]); }
      if (s.model) { sub.push(s.model); }
      if (s.kind === 'pi' && historyBranch(s.id)) { sub.push('历史分支'); }
      if (s.autoApprove) { sub.push('免审批'); }
      if (s.muted) { sub.push('已关闭提醒'); }
    } else if (s.kind === 'assistant') {
      var phones = host ? host.devices.filter(function (d) { return d.online && !d.revoked; }) : [];
      sub.push(phones.length ? '手机在线' : '手机不在线，消息会在手机上线后送达');
    }
    el.innerHTML = '<div class="pd-head-main"><div class="pd-head-title">' + esc(title(s)) + '</div>' + (sub.length ? '<div class="pd-head-sub">' + esc(sub.join(' · ')) + '</div>' : '') + '</div>' +
      '<div class="pd-head-acts">' + (isAgent(s) ? '<button class="pd-icon-btn" data-act="head-model" title="模型与供应商" aria-label="模型与供应商">' + icon('cpu', 18) + '</button>' +
      ((s.kind === 'claude' || s.kind === 'codex') ? '<button class="pd-icon-btn" data-act="head-skills" title="Skills" aria-label="Skills">' + icon('sparkles', 18) + '</button>' : '') +
      '<button class="pd-icon-btn" data-act="head-mute" title="' + (s.muted ? '打开提醒' : '关闭提醒') + '" aria-label="' + (s.muted ? '打开提醒' : '关闭提醒') + '">' + icon(s.muted ? 'bell-off' : 'bell', 18) + '</button>' : '') +
      (s.kind === 'pi' ? '<button class="pd-icon-btn" data-act="history-open" title="历史分支" aria-label="历史分支">' + icon('history', 18) + '</button>' : '') +
      PDX.presetHeadHtml(s) +
      (isAgent(s) ? '<button class="pd-icon-btn" data-act="files-sidebar" title="文件与 Diff" aria-label="文件与 Diff" aria-expanded="' + PDChanges.isOpen() + '" aria-controls="change-view">' + icon('folder-open', 18) + '</button>' : '') +
      '<button class="pd-icon-btn" data-act="chat-more" title="更多" aria-label="更多">' + icon('menu', 18) + '</button></div>';
  }

  var changeGroups = Object.create(null);

  /** renderMsgs：重绘消息；原本在底部或首次打开时滚到底部 */
  function renderMsgs(first, preserve) {
    var el = document.getElementById('msgs');
    var sid = route().sid, lg = logs[sid];
    if (!el || !lg || !lg.loaded) { return; }
    var bottom = !preserve && (first || el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    var oldTop = el.scrollTop, viewportTop = el.getBoundingClientRect().top;
    var anchor = Array.prototype.filter.call(el.querySelectorAll('.pd-tool-row,.pd-tool-group-head,.pd-msg:not(.pd-tool-msg)[data-seq]'), function (node) { return node.getBoundingClientRect().bottom > viewportTop; })[0];
    var anchorSeq = anchor && (anchor.dataset.toolSeq || anchor.dataset.seq), anchorOffset = anchor && anchor.getBoundingClientRect().top - viewportTop;
    var items = buildItems(lg.events.length ? lg.events : [{ session: sid }]);
    var s = session(sid);
    var root = sessionRoot(s);
    changeGroups = Object.create(null);
    var toolContext = { sid: sid, root: root, icon: icon, copy: copyText, openChanges: function (files, source) {
      openChanges(sid, files, 0, source);
    }, refresh: function () { renderMsgs(false, true); } };
    var out = '', lastAt = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.at && it.at - lastAt > 5 * 60 * 1000) { out += '<div class="pd-msg-time">' + chatTime(it.at) + '</div>'; }
      if (it.at) { lastAt = it.at; }
      if (it.t === 'tool') {
        var tools = [it];
        while (i + 1 < items.length && items[i + 1].t === 'tool' && (!items[i + 1].at || items[i + 1].at - lastAt <= 5 * 60 * 1000)) { i++; tools.push(items[i]); if (items[i].at) { lastAt = items[i].at; } }
        out += PDToolView.groupHtml(tools, toolContext);
      } else { out += itemHtml(it, s); }
    }
    el.innerHTML = out || '<div class="pd-empty">' + (s && s.kind === 'assistant' ? '发一条消息或拖入文件，手机上的文件传输助手马上就能收到' : '还没有消息') + '</div>';
    PDToolView.update(items, toolContext);
    if (bottom) { el.scrollTop = el.scrollHeight; }
    else {
      var restored = anchorSeq && el.querySelector('[data-tool-seq="' + anchorSeq + '"],.pd-msg[data-seq="' + anchorSeq + '"]');
      el.scrollTop = oldTop;
      if (restored) { el.scrollTop += restored.getBoundingClientRect().top - viewportTop - anchorOffset; }
    }
    Array.prototype.forEach.call(el.querySelectorAll('img'), function (img) {
      if (!img.complete) { img.addEventListener('load', function () { if (bottom) { el.scrollTop = el.scrollHeight; } }, { once: true }); }
    });
    if (unread[sid] && document.visibilityState === 'visible') { setUnread(sid, 0); renderList(); renderRail(); }
  }

  /** itemHtml：一条消息；「我」在右侧，Agent 与手机在左侧 */
  function itemHtml(it, s) {
    var mine, body, who;
    var agentKind = s ? s.kind : '';
    switch (it.t) {
      case 'user':
        mine = !it.phone;
        body = '<div class="pd-bubble plain">' + esc(it.text) + '</div>' +
          (it.attachments.length ? '<div class="pd-attach">' + it.attachments.map(function (a) { return '<span>' + esc(a.split('/').pop()) + '</span>'; }).join('') + '</div>' : '') +
          (it.skills && it.skills.length ? '<div class="pd-attach">' + it.skills.map(function (k) { return '<span>' + icon('sparkles', 12) + esc(k) + '</span>'; }).join('') + '</div>' : '') +
          (it.cancelled ? '<div class="pd-queued">已取消</div>' : it.queued ? '<div class="pd-queued">排队中，Agent 空闲后发送</div>' : '');
        who = mine ? 'host' : 'phone';
        break;
      case 'host':
        mine = true; who = 'host';
        body = '<div class="pd-bubble plain">' + esc(it.text) + '</div>';
        break;
      case 'agent':
        mine = false; who = agentKind;
        body = '<div class="pd-bubble pd-md">' + md(it.text) + (it.streaming ? ' <span class="pd-muted">▍</span>' : '') + '</div>';
        break;
      case 'think':
        return '<div class="pd-msg" data-seq="' + it.seq + '"><div style="width:var(--pd-chat-avatar)"></div><div class="pd-msg-body"><details class="pd-think"><summary>' + icon('brain', 14) + (it.done ? '思考过程' : '正在思考…') + '</summary><pre>' + esc(it.text) + '</pre></details></div></div>';
      case 'tool':
        return '';
      case 'approval':
        mine = false; who = agentKind;
        var detail = it.input && typeof it.input.command === 'string' ? it.input.command : (it.summary || JSON.stringify(it.input, null, 2));
        body = '<div class="pd-approval"><div class="pd-approval-title">' + icon('shield-alert', 16) + approvalTitle(it.kind) + '<span class="pd-muted" style="margin-left:auto;font-weight:400">' + esc(it.tool) + '</span></div>' +
          '<pre>' + esc(detail) + '</pre>' + (it.status ? '<div class="pd-approval-done">' + approvalStatus(it.status) + '</div>' :
          '<div class="pd-approval-acts"><button class="pd-btn pd-btn-primary" data-act="decide" data-id="' + esc(it.id) + '" data-action="allow">允许</button>' +
          '<button class="pd-btn" data-act="decide" data-id="' + esc(it.id) + '" data-action="deny">拒绝</button>' +
          '<button class="pd-link" data-act="decide" data-id="' + esc(it.id) + '" data-action="always">本会话总是允许此类操作</button></div>') + '</div>';
        break;
      case 'diff':
        changeGroups[it.seq] = { files: it.files, at: it.at };
        mine = false; who = agentKind;
        body = '<div class="pd-card-msg"><div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' + icon('git-compare', 16) + '改动了 ' + it.files.length + ' 个文件</div>' +
          it.files.slice(0, 8).map(function (f, index) {
            var gone = f.status === 'deleted' || f.status === 'D';
            var name = '<button class="pd-link" data-act="diff-ref" data-change-seq="' + it.seq + '" data-file-index="' + index + '" title="查看本轮改动">' + esc(f.path) + '</button>';
            var stat = f.binary ? '<span class="pd-muted">' + (f.status === 'added' || f.status === 'A' ? '新建' : gone ? '删除' : '已修改') + ' · 二进制</span>' :
              '<span class="pd-add">+' + (f.added || 0) + '</span><span class="pd-del">-' + (f.removed || 0) + '</span>';
            return '<div class="pd-diff-row">' + name + stat + '</div>';
          }).join('') + '<button class="pd-link" data-act="diff-ref" data-change-seq="' + it.seq + '" data-file-index="0" style="margin-top:8px">' + (it.files.length > 8 ? '查看全部 ' + it.files.length + ' 个文件' : '查看 Diff') + '</button></div>';
        break;
      case 'sys':
        return '<div class="pd-sys' + (it.error ? ' err' : '') + '" data-seq="' + it.seq + '">' + esc(it.text) + (it.retryable ? ' <button class="pd-link" data-act="retry">重试</button>' : '') + '</div>';
      case 'file':
        mine = !it.up; who = mine ? 'host' : 'phone';
        body = fileHtml(it);
        break;
      default:
        return '';
    }
    return '<div class="pd-msg' + (mine ? ' mine' : '') + '" data-seq="' + it.seq + '">' + avatarHtml(who, true) + '<div class="pd-msg-body">' + body + '</div></div>';
  }

  function approvalTitle(kind) {
    return { command: '要执行命令', exec: '要执行命令', edit: '要修改文件', write: '要写入文件', read: '要读取文件', web: '要访问网络', fetch: '要访问网络' }[kind] || '需要你确认';
  }
  function approvalStatus(st) {
    return { allowed: '已允许', allow: '已允许', always: '已允许（本会话总是允许）', denied: '已拒绝', deny: '已拒绝', expired: '已过期', canceled: '已取消' }[st] || '已处理';
  }

  /** fileHtml：文件消息；图片直接显示，其他文件显示卡片 */
  function fileHtml(it) {
    var src = '/admin/api/assistant/file?seq=' + it.seq;
    if (isImage(it.name)) {
      return '<button class="pd-img" data-act="preview" data-seq="' + it.seq + '" data-name="' + esc(it.name) + '"><img alt="' + esc(it.name) + '" src="' + src + '" loading="lazy"></button>';
    }
    var ext = (/\.(\w+)$/.exec(it.name || '') || ['', 'FILE'])[1].toUpperCase().slice(0, 4);
    var color = { PDF: '#F4524D', DOC: '#2B7BF0', DOCX: '#2B7BF0', XLS: '#1FA463', XLSX: '#1FA463', PPT: '#F07A2B', PPTX: '#F07A2B', ZIP: '#9B6DE0', MD: '#5A6475', TXT: '#5A6475' }[ext] || '#8A94A6';
    return '<div class="pd-file"><div class="pd-file-main"><div style="flex:1;min-width:0"><div class="pd-file-name">' + esc(it.name) + '</div><div class="pd-file-size">' + fmtSize(it.size) + '</div></div>' +
      '<div class="pd-file-ext" style="background:' + color + '">' + esc(ext) + '</div></div>' +
      '<div class="pd-file-foot"><button class="pd-link" data-act="file-open" data-seq="' + it.seq + '">打开</button><button class="pd-link" data-act="file-reveal" data-seq="' + it.seq + '">显示</button></div></div>';
  }

  function renderPending() {
    var sid = route().sid;
    if (historyCompositions && historyCompositions[sid]) { historyCompositions[sid].attachments = pending.map(function (p) { return p.path; }); save('pd.historyCompositions', historyCompositions); }
    var el = document.getElementById('pending');
    if (!el) { return; }
    el.innerHTML = pending.map(function (p, i) {
      return '<span>' + esc(p.name) + '<button class="pd-icon-btn" style="width:18px;height:18px" data-act="unpend" data-i="' + i + '" aria-label="移除">' + icon('x', 12) + '</button></span>';
    }).join('');
    syncSend();
  }

  function syncSend() {
    var input = document.getElementById('input'), btn = document.getElementById('send');
    if (input && btn) { btn.disabled = !input.value.trim() && !pending.length; }
  }

  /**
   * send：发送当前输入
   *
   * 文件传输助手：文字以「电脑」身份发给手机；Agent 会话：与手机相同的发消息接口，附件路径随消息一起发送。
   */
  function send() {
    var s = session(route().sid);
    var input = document.getElementById('input');
    if (!s || !input || historyBusy[s.id]) { return; }
    var text = input.value;
    if (Object.prototype.hasOwnProperty.call(draftBranches, s.id) && historyBranch(s.id) !== undefined && draftBranches[s.id] !== historyBranch(s.id)) {
      confirmBox('当前分支已变化', '另一端切换了会话位置。保留这份草稿，并发送到当前分支吗？', '使用当前分支', function () { draftBranches[s.id] = historyBranch(s.id); save('pd.draftBranches', draftBranches); send(); }); return;
    }
    if (!text.trim() && !pending.length) { return; }
    if (isAgent(s) && /^\/(?:effort|tree)(?:\s|$)/i.test(text.trim()) && pending.length) { toast('请先移除附件再使用此指令'); return; }
    // 指令在电脑端执行（/compact 交给 Agent）
    var cmd = isAgent(s) && !pending.length ? /^\/(\S+)(?:\s|$)/.exec(text.trim()) : null;
    if (cmd && cmd[1] !== 'compact' && CMDS.some(function (c) { return c[0] === '/' + cmd[1].toLowerCase(); })) {
      input.value = '';
      saveDraft(s.id, '');
      syncSend();
      renderCmds();
      runCmd('/' + cmd[1].toLowerCase(), text.trim().slice(cmd[0].length).trim());
      return;
    }
    input.value = '';
    saveDraft(s.id, '');
    syncSend();
    var p;
    if (s.kind === 'assistant') {
      p = api('POST', '/admin/api/assistant/text', { text: text });
    } else {
      var att = pending.map(function (x) { return x.path; });
      var skills = chosenSkills[s.id] || [];
      pending = [];
      delete chosenSkills[s.id];
      renderPending();
      renderChosen();
      renderCmds();
      p = api('POST', P + '/api/sessions/' + encodeURIComponent(s.id) + '/messages', { text: text, attachments: att, skills: skills, expectedBranch: Object.prototype.hasOwnProperty.call(draftBranches, s.id) ? draftBranches[s.id] : historyBranch(s.id), clientId: 'desk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) });
    }
    p.then(function () { delete draftBranches[s.id]; save('pd.draftBranches', draftBranches); delete historyCompositions[s.id]; save('pd.historyCompositions', historyCompositions); }).catch(function (e) { input.value = text; saveDraft(s.id, text); if (att) { pending = att.map(function (path) { return { path: path, name: path.split('/').pop() }; }); renderPending(); } syncSend(); if (skills && skills.length) { chosenSkills[s.id] = skills; renderChosen(); } toast(e.message); });
  }

  var draftBranches = load('pd.draftBranches', {});
  function historyBranch(sid) {
    var events = (logs[sid] || {}).events || [];
    for (var i = events.length - 1; i >= 0; i--) { if ((events[i].type === 'history.reset' || events[i].type === 'history.bind') && events[i].data.branchId !== undefined) { return events[i].data.branchId || ''; } }
    return undefined;
  }

  function historyRejected(e) { return e.code === 'history_conflict' || e.code === 'history_image_unavailable'; }
  var historyBusy = {};
  var historyRequests = load('pd.historyRequests', {});
  var historyCompositions = load('pd.historyCompositions', {});
  function refreshHistoryLog(sid) {
    var lg = logs[sid];
    return api('GET', P + '/api/sessions/' + encodeURIComponent(sid) + '/events?after=' + (lg ? lg.last : 0)).then(function (evs) {
      (evs || []).forEach(onEvent);
      if (route().sid === sid) { renderMsgs(false); }
    });
  }
  function openHistory(s, entryId) {
    if (!s || historyBusy[s.id]) { return; }
    if (s.kind !== 'pi') { toast('历史分支当前仅支持 Pi 会话'); return; }
    if (historyRequests[s.id]) {
      var request = historyRequests[s.id];
      modal('确认上次切换结果', '<p>上次操作的响应未确认。重试会查询同一操作；如果成功，历史消息会替换当前草稿。</p>', '<button class="pd-btn" data-act="modal-close">取消</button><button class="pd-btn pd-btn-primary" id="history-resume">确认并恢复</button>');
      document.getElementById('history-resume').onclick = function () {
        historyBusy[s.id] = true;
        modalAction(this, function () { return api('POST', P + '/api/sessions/' + encodeURIComponent(s.id) + '/history/navigate', request, 50000); },
          function (result) { return acceptHistory(s, result); }, function (e, button) { historyFailure(s, e, button); }).then(function (result) { if (result) { showHistoryResult(s, result); } }).finally(function () { delete historyBusy[s.id]; });
      }; return;
    }
    remoteModal('历史分支', '正在读取会话历史…', function () {
      return api('GET', P + '/api/sessions/' + encodeURIComponent(s.id) + '/history', undefined, 45000).then(function (view) {
        refreshHistoryLog(s.id).catch(function (e) { console.warn('历史已读取，聊天同步失败', e); });
        return view;
      });
    }, function (view) { showHistoryTree(s, view, entryId); }, true);
  }
  function historyFailure(s, e, button) {
    button.textContent = historyRejected(e) ? '刷新历史' : '重试同一操作';
    if (historyRejected(e)) {
      delete historyRequests[s.id]; save('pd.historyRequests', historyRequests);
      button.onclick = function () { openHistory(s); };
    }
  }

  function showHistoryTree(s, view, entryId) {
    var turns = view.tree || [], byId = {}, children = {}, expanded = { root: true }, counts = {}, selected, generation = 0, shown = 80;
    turns.forEach(function (t) { byId[t.id] = t; (children[t.parentId || ''] || (children[t.parentId || ''] = [])).push(t); if (t.current) { expanded[t.id] = true; } });
    turns.slice().reverse().forEach(function (t) { counts[t.id] = (counts[t.id] || 0) + 1; counts[t.parentId] = (counts[t.parentId] || 0) + counts[t.id]; });
    modal('历史分支', '<div class="pd-history-layout"><section class="pd-history-nav" aria-label="对话路线">' +
      '<div class="pd-history-toolbar"><input class="pd-input" id="history-search" placeholder="搜索请求或回复" aria-label="搜索请求或回复"><button class="pd-btn" id="history-locate">定位当前</button></div>' +
      '<p class="pd-history-legend"><span></span>绿色连线是当前路线 · 点击节点预览</p><div id="history-list" class="pd-history-list"></div></section>' +
      '<section id="history-pane" class="pd-history-pane" aria-label="对话预览"></section></div>', '<span class="pd-muted">原路线会保留；文件修改和已执行的命令不会撤销。</span>');
    modalRoot.querySelector('.pd-dialog').classList.add('pd-history-dialog');
    var search = document.getElementById('history-search'), list = document.getElementById('history-list'), pane = document.getElementById('history-pane');
    function rows() {
      var q = search.value.trim().toLowerCase(), keep = {}, result = [], stack = (children[''] || []).slice().reverse().map(function (t) { return { turn: t, depth: 0, guides: [], fork: false }; });
      if (q) { turns.forEach(function (t) {
        if ((t.text + ' ' + (t.replies || []).map(function (n) { return n.text; }).join(' ')).toLowerCase().indexOf(q) < 0) { return; }
        var cursor = t; while (cursor && !keep[cursor.id]) { keep[cursor.id] = true; cursor = byId[cursor.parentId]; }
      }); }
      while (stack.length) {
        var row = stack.pop(), t = row.turn, kids = children[t.id] || [];
        if (q && !keep[t.id]) { continue; }
        result.push(row);
        if (q || expanded[t.id]) { for (var k = kids.length - 1; k >= 0; k--) {
          var guides = row.guides.filter(function (g) { return !g.last; });
          if (kids.length > 1) { guides.push({ depth: row.depth, last: k === kids.length - 1, active: kids.slice(k + 1).some(function (t) { return t.current; }), upper: kids.slice(k).some(function (t) { return t.current; }) }); }
          stack.push({ turn: kids[k], depth: row.depth + (kids.length > 1 ? 1 : 0), guides: guides, fork: kids.length > 1 });
        } }
      }
      return result;
    }
    function draw() {
      var visible = rows();
      list.innerHTML = visible.slice(0, shown).map(function (row) {
        var t = row.turn, kids = children[t.id] || [], open = search.value.trim() || expanded[t.id];
        var stamp = !open && kids.length ? t.latestAt || t.timestamp : t.timestamp;
        var date = stamp ? new Date(stamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        var meta = [date, kids.length > 1 ? kids.length + ' 条后续路线' : '', !open && kids.length ? '已收起 ' + (counts[t.id] - 1) + ' 轮' : ''].filter(Boolean).join(' · ');
        return '<div class="pd-history-branch' + (t.current ? ' on-path' : '') + (t.here ? ' is-here' : '') + (selected === t.id ? ' is-selected' : '') + (row.fork || !t.parentId ? ' starts-route' : '') + (!open || !kids.length ? ' ends-route' : '') + '" style="--branch-indent:' + Math.min(row.depth, 5) * 14 + 'px">' +
          row.guides.filter(function (g) { return g.depth < Math.min(row.depth, 5); }).map(function (g) { return '<span aria-hidden="true" class="pd-history-guide' + (g.last ? ' last-guide' : '') + (g.active ? ' active-guide' : '') + '" style="left:' + (10 + g.depth * 14) + 'px"></span>' + (row.fork && g.depth === row.depth - 1 && g.upper ? '<span aria-hidden="true" class="pd-history-guide last-guide active-guide" style="left:' + (10 + g.depth * 14) + 'px"></span>' : ''); }).join('') + (row.fork ? '<span aria-hidden="true" class="pd-history-fork" style="left:' + (10 + (Math.min(row.depth, 5) - 1) * 14) + 'px"></span>' : '') + '<span class="pd-history-rail" aria-hidden="true"><i></i></span><button class="pd-history-row" data-turn="' + esc(t.id) + '"' + (t.here ? ' aria-current="location"' : '') + '>' +
          (t.here ? '<span class="pd-history-here">当前所在</span>' : '') + '<span class="pd-history-text">' + esc(t.text || '无文字请求') + '</span>' + (!open && kids.length && t.latestText && t.latestText !== t.text ? '<span class="pd-history-meta pd-history-last">末条请求：' + esc(t.latestText) + '</span>' : '') + '<span class="pd-history-meta">' + esc(meta) + '</span></button>' +
          (kids.length ? '<button class="pd-icon-btn" data-fold="' + esc(t.id) + '" aria-label="' + (open ? '收起后续路线' : '展开后续路线') + '" aria-expanded="' + !!open + '">' + icon(open ? 'chevron-down' : 'chevron-right', 16) + '</button>' : '') + '</div>';
      }).join('') || '<p class="pd-muted">没有匹配的对话</p>';
      if (visible.length > shown) { list.innerHTML += '<button class="pd-btn" id="history-more">加载更多路线</button>'; }
    }
    function selectTurn(turn, initial) {
      if (!turn) { pane.innerHTML = '<p class="pd-muted">暂无对话。发送消息后可在这里查看路线。</p>'; return; }
      selected = turn.id; draw();
      var choices = (turn.user ? [turn.user] : []).concat(turn.replies || []);
      if (turn.end && !choices.some(function (n) { return n.id === turn.end.id; })) { choices.push(turn.end); }
      var node = initial || turn.end || turn.user, events = [], before = 0, notice = '', targetText = '';
      pane.innerHTML = '<div class="pd-history-preview-head"><span class="pd-history-meta">只读预览</span><h3>' + esc(turn.text || '对话起点') + '</h3>' +
        (choices.length ? '<label class="pd-history-meta" for="history-position">选择操作位置</label><select class="pd-input" id="history-position">' + choices.map(function (n) { return '<option value="' + esc(n.id) + '"' + (node && n.id === node.id ? ' selected' : '') + '>' + esc(n.mode === 'edit' ? '修改这条请求' : n.role === 'branch' ? '这条路线最后停留的位置' : '回复 · ' + (n.text || '无文字回复')) + '</option>'; }).join('') + '</select>' : '') + '</div><div id="history-conversation" class="pd-history-conversation"></div><div class="pd-history-preview-foot"><p id="history-notice" class="pd-muted"></p><button class="pd-btn pd-btn-primary" id="history-action" disabled>正在加载预览…</button></div>';
      var conversation = pane.querySelector('#history-conversation'), action = pane.querySelector('#history-action'), position = pane.querySelector('#history-position');
      function drawConversation() {
        var items = buildItems(events, true);
        conversation.innerHTML = (before > 0 ? '<button class="pd-btn" id="history-earlier">加载更早的对话</button>' : '') + items.map(function (it) {
          if (it.t === 'tool' || it.t === 'think') { return '<details class="pd-history-detail"><summary>' + esc(it.t === 'tool' ? '工具 · ' + it.name : '思考过程') + '</summary><pre>' + esc(it.t === 'tool' ? it.summary + '\n' + it.output : it.text) + '</pre></details>'; }
          var text = it.text || (it.t === 'file' ? '文件：' + it.name : it.t === 'approval' ? '审批：' + it.summary : it.t === 'diff' ? '本轮改动：' + it.files.length + ' 个文件' : '');
          if (it.attachments && it.attachments.length) { text += '\n' + it.attachments.map(function (p) { return '附件：' + p; }).join('\n'); }
          return text ? '<article class="pd-history-message' + (it.t === 'user' ? ' from-user' : '') + '"><span class="pd-history-meta">' + (it.t === 'user' ? '你' : it.t === 'agent' ? 'Pi' : '记录') + '</span><div>' + esc(text) + '</div></article>' : '';
        }).join('');
        if (!items.length) { conversation.innerHTML += '<p class="pd-muted">此位置还没有对话内容</p>'; }
        var earlier = conversation.querySelector('#history-earlier'); if (earlier) { earlier.onclick = function () { earlier.disabled = true; loadPreview(true); }; }
      }
      function loadPreview(earlier) {
        var targetId = node.id;
        var mine = ++generation, cursor = earlier ? before : -1;
        action.disabled = true; action.textContent = '正在加载预览…';
        if (!earlier) { conversation.innerHTML = '<p class="pd-muted" role="status"><span class="pd-wait-spinner" aria-hidden="true"></span> 正在加载这条路线的对话…</p>'; }
        api('GET', P + '/api/sessions/' + encodeURIComponent(s.id) + '/history/entries?targetId=' + encodeURIComponent(targetId) + '&before=' + cursor + '&limit=50', undefined, 45000).then(function (page) {
          if (mine !== generation || !conversation.isConnected) { return; }
          if (page.before === undefined) { throw new Error('请更新电脑端后再预览历史'); }
          events = earlier ? (page.events || []).concat(events) : page.events || [];
          before = page.before; notice = page.inputNotice || ''; targetText = page.targetText || node.text;
          pane.querySelector('#history-notice').textContent = notice;
          var here = node.mode !== 'edit' && node.here;
          action.textContent = here ? '当前所在位置' : node.mode === 'edit' ? '修改并重试' : turn.end && node.id === turn.end.id ? '切换到此分支' : '从这里继续';
          action.disabled = !!here;
          drawConversation();
          if (!earlier) { conversation.scrollTop = conversation.scrollHeight; }
        }).catch(function (e) {
          if (mine !== generation || !conversation.isConnected) { return; }
          conversation.innerHTML = '<p role="alert">' + esc(e.message) + '</p><button class="pd-btn" id="history-retry">重试预览</button>';
          conversation.querySelector('#history-retry').onclick = function () { loadPreview(false); };
          action.textContent = '预览未加载';
        });
      }
      if (position) { position.onchange = function () { node = choices.filter(function (n) { return n.id === position.value; })[0]; loadPreview(false); }; }
      action.onclick = function () { var tree = modalRoot.firstElementChild; showHistoryConfirmation(s, view, Object.assign({}, node, { inputNotice: notice, text: node.role === 'branch' ? turn.text : targetText }), function () { modalRoot.replaceChildren(tree); }); };
      if (node) { loadPreview(false); } else { ++generation; action.textContent = '对话尚未开始'; drawConversation(); }
    }
    list.onclick = function (e) {
      if (e.target.closest('#history-more')) { shown += 80; draw(); return; }
      var fold = e.target.closest('[data-fold]');
      if (fold) { expanded[fold.dataset.fold] = !expanded[fold.dataset.fold]; draw(); return; }
      var b = e.target.closest('[data-turn]'); if (b) { selectTurn(byId[b.dataset.turn]); if (window.innerWidth < 700) { pane.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }
    };
    search.oninput = function () { shown = 80; draw(); };
    document.getElementById('history-locate').onclick = function () {
      search.value = ''; turns.forEach(function (t) { if (t.current) { expanded[t.id] = true; } }); shown = turns.length; draw();
      var here = list.querySelector('[aria-current="location"]'); if (here) { here.scrollIntoView({ block: 'center' }); here.focus(); }
    };
    var initial = (view.nodes || []).filter(function (n) { return n.id === entryId; })[0];
    var turn = initial && turns.filter(function (t) { return t.user && t.user.id === entryId || t.end && t.end.id === entryId || (t.replies || []).some(function (n) { return n.id === entryId; }); })[0];
    selectTurn(turn || turns.filter(function (t) { return t.here; })[0] || turns[0], initial);
  }

  function showHistoryConfirmation(s, view, node, back) {
    var input = document.getElementById('input');
    var editing = node.mode === 'edit';
    var hasDraft = input && (input.value || pending.length || (chosenSkills[s.id] || []).length);
    modal(editing ? '回到这条消息之前？' : '切换到这个位置？',
      '<blockquote class="pd-history-preview">' + esc(node.text || '无文字内容') + '</blockquote>' + (node.inputNotice ? '<p class="pd-muted">' + esc(node.inputNotice) + '</p>' : '') + '<p>' +
      (editing ? '原消息将放回输入框供你修改。' : '继续使用所选位置的对话上下文。') + '原来的后续对话会保留在历史分支中。</p><p class="pd-muted">已修改的文件和已执行的命令不会撤销。</p>' +
      (editing && hasDraft ? '<p>确认后会用历史消息替换输入框已有的草稿和附件。</p>' : ''),
      (back ? '<button class="pd-btn" id="history-back">返回预览</button>' : '<button class="pd-btn" data-act="modal-close">取消</button>') + '<button class="pd-btn pd-btn-primary" id="history-confirm">' + (editing && hasDraft ? '替换草稿并回到这里' : '回到这里') + '</button>');
    if (back) { document.getElementById('history-back').onclick = back; }
    var request = { operationId: 'history-' + Date.now() + '-' + Math.random().toString(36).slice(2), expectedLeaf: view.leafId, targetId: node.id, mode: node.mode };
    document.getElementById('history-confirm').onclick = function () {
      historyBusy[s.id] = true;
      historyRequests[s.id] = request; save('pd.historyRequests', historyRequests);
      modalAction(this, function () { return api('POST', P + '/api/sessions/' + encodeURIComponent(s.id) + '/history/navigate', request, 50000); },
        function (result) { return acceptHistory(s, result); }, function (e, button) { historyFailure(s, e, button); }).then(function (result) { if (result) { showHistoryResult(s, result); } }).finally(function () { delete historyBusy[s.id]; });
    };
  }

  function acceptHistory(s, result) {
    delete historyRequests[s.id]; save('pd.historyRequests', historyRequests);
    if (result.cancelled) { return refreshHistoryLog(s.id).then(function () { return result; }); }
    draftBranches[s.id] = result.branchId || ''; save('pd.draftBranches', draftBranches);
    if (result.draft) {
      saveDraft(s.id, result.draft.text || '');
      historyCompositions[s.id] = { attachments: result.draft.attachments || [], skills: result.draft.skills || [] };
      save('pd.historyCompositions', historyCompositions);
      if (route().sid === s.id) {
        var input = document.getElementById('input'); if (input) { input.value = result.draft.text || ''; }
        pending = (result.draft.attachments || []).map(function (path) { return { name: path.split('/').pop(), path: path }; });
        chosenSkills[s.id] = result.draft.skills || []; renderPending(); renderChosen(); syncSend();
      }
    }
    return refreshHistoryLog(s.id).then(function () { return result; });
  }

  function showHistoryResult(s, result) {
    if (route().sid !== s.id) { return; }
    if (result.cancelled) { toast('历史切换已取消'); return; }
    var input = document.getElementById('input'); if (input) { input.focus(); }
    toast(result.draft ? '已回到所选位置，可以修改后发送' : '已切换历史分支');
    if (result.draftWarnings && result.draftWarnings.length) {
      modal('部分历史附件不可用', '<p>' + result.draftWarnings.map(esc).join('<br>') + '</p><p>附件引用仍保留在草稿中，请移除不可用附件或重新附加文件。</p>', '<button class="pd-btn pd-btn-primary" data-act="modal-close">知道了</button>');
    }
  }

  function saveDraft(id, text) {
    var d = load('pd.draft', {});
    if (text) { d[id] = text; } else { delete d[id]; }
    save('pd.draft', d);
  }

  /** confirmSend：文件传输助手发送前先让用户确认 */
  var sendQueue = [];
  function confirmSend(files) {
    sendQueue = files;
    modal('发送给手机', '<div class="pd-muted" style="font-size:12px;margin-bottom:8px">共 ' + files.length + ' 个文件</div><div class="pd-pick-list">' + files.map(function (f) {
      return '<div class="pd-pick-row" style="cursor:default">' + icon(isImage(f.name) ? 'image' : 'file', 16) + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.name) + '</span><span class="pd-muted" style="font-size:12px">' + fmtSize(f.size) + '</span></div>';
    }).join('') + '</div>', '<button class="pd-btn" data-act="modal-close">取消</button><button class="pd-btn pd-btn-primary" data-act="send-files-ok">发送</button>');
  }

  /** sendFiles：文件传输助手确认后发给手机；Agent 会话先作为附件，随下一条消息发送 */
  function sendFiles(files) {
    var s = session(route().sid);
    if (!s || !files.length) { return; }
    if (s.kind === 'assistant') { confirmSend(files); return; }
    uploadForm('/admin/api/sessions/' + encodeURIComponent(s.id) + '/attach', files).then(function (r) {
      (r.paths || []).forEach(function (p) { pending.push({ name: p.split('/').pop(), path: p }); });
      renderPending();
      var input = document.getElementById('input');
      if (input) { input.focus(); }
    }).catch(function (e) { toast(e.message); });
  }

  /** pastedFiles：剪贴板里的文件；截图等没有名字的图片按时间命名 */
  function pastedFiles(e) {
    var out = [];
    var items = (e.clipboardData && e.clipboardData.items) || [];
    Array.prototype.forEach.call(items, function (it) {
      if (it.kind !== 'file') { return; }
      var f = it.getAsFile();
      if (!f) { return; }
      if (!f.name || /^image\.\w+$/.test(f.name)) {
        var d = new Date();
        var ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        f = new File([f], '粘贴图片-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.' + ext, { type: f.type });
      }
      out.push(f);
    });
    return out;
  }

  /** chatText：会话的全部文字（复制全部对话） */
  function chatText(sid) {
    var lg = logs[sid];
    if (!lg) { return ''; }
    return buildItems(lg.events).map(function (it) {
      switch (it.t) {
        case 'user': return (it.phone ? '手机：' : '我：') + it.text;
        case 'host': return '电脑：' + it.text;
        case 'agent': return it.text;
        case 'tool': return '[' + it.summary + ']' + (it.output ? '\n' + it.output : '');
        case 'sys': return it.text;
        case 'file': return '[文件] ' + it.name;
        default: return '';
      }
    }).filter(Boolean).join('\n\n');
  }

  /** itemText：一条消息的文字 */
  function itemText(sid, seq) {
    var lg = logs[sid];
    var it = lg && buildItems(lg.events).filter(function (x) { return x.seq === seq; })[0];
    if (!it) { return ''; }
    return it.text || it.output || it.name || '';
  }

  /* ---------- 斜杠指令、模型与供应商、skill、接着电脑上的会话 ---------- */
  var CMDS = [
    ['/model', '切换模型', 'cpu'],
    ['/effort', '切换思考强度（Pi）', 'cpu'],
    ['/tree', '回到历史位置或切换分支（Pi）', 'history'],
    ['/provider', '切换模型供应商', 'server'],
    ['/skills', '查看、启用并选用 skill', 'sparkles'],
    ['/resume', '接着电脑上的会话聊', 'history'],
    ['/new', '在同一 Agent 和目录下开新会话', 'plus'],
    ['/stop', '打断当前执行', 'square'],
    ['/status', '查看当前会话状态', 'info'],
    ['/usage', '查看本会话用量', 'layout-grid'],
    ['/compact', '压缩上下文', 'layout-grid']
  ];
  var cmdIndex = 0;
  var chosenSkills = {};          // 会话 ID → 下一条消息要用的 skill [{ name, path }]

  /** matchCmds：输入以 / 开头且还没有空格时匹配指令 */
  function matchCmds(text) {
    if (!/^\/\S*$/.test(text || '')) { return []; }
    return CMDS.filter(function (c) { return c[0].indexOf(text.toLowerCase()) === 0; });
  }

  /** renderCmds：输入框上方的指令候选 */
  function renderCmds() {
    var box = document.getElementById('cmds'), input = document.getElementById('input');
    var s = session(route().sid);
    if (!box || !input) { return; }
    var list = s && isAgent(s) ? matchCmds(input.value).filter(function (c) { return (c[0] !== '/effort' && c[0] !== '/tree') || s.kind === 'pi'; }) : [];
    if (!list.length) { box.innerHTML = ''; box.hidden = true; return; }
    cmdIndex = Math.min(cmdIndex, list.length - 1);
    box.hidden = false;
    box.innerHTML = list.map(function (c, i) {
      return '<button class="pd-cmd' + (i === cmdIndex ? ' active' : '') + '" data-act="cmd" data-cmd="' + c[0] + '">' + icon(c[2], 16) + '<span class="pd-mono">' + c[0] + '</span><span class="pd-muted">' + c[1] + '</span></button>';
    }).join('');
  }

  /** pickCmd：选中指令；/compact 交给 Agent，其余在这里执行 */
  function pickCmd(name) {
    var input = document.getElementById('input');
    if (!input) { return; }
    if (name === '/compact') { input.value = '/compact'; renderCmds(); send(); return; }
    input.value = '';
    saveDraft(route().sid, '');
    syncSend();
    renderCmds();
    runCmd(name);
  }

  /** runCmd：执行指令 */
  function runCmd(name, arg) {
    var s = session(route().sid);
    if (!s) { return; }
    switch (name) {
      case '/model': chooseModel(s); break;
      case '/tree': openHistory(s); break;
      case '/effort': chooseEffort(s, arg || ''); break;
      case '/provider': chooseProvider(s); break;
      case '/skills': skillsModal(s); break;
      case '/status': statusModal(s); break;
      case '/usage': usageModal(s); break;
      case '/resume': externalModal(); break;
      case '/stop':
        api('POST', P + '/api/sessions/' + encodeURIComponent(s.id) + '/interrupt').then(function () { toast('已打断'); }).catch(function (er) { toast(er.message); });
        break;
      case '/new':
        api('POST', P + '/api/sessions', { kind: s.kind, workspaceId: s.workspaceId, cwd: s.cwd, model: s.model, effort: s.effort || '', autoApprove: s.kind === 'pi' && !!s.autoApprove }).then(function (s2) {
          if (s.provider) { return api('PATCH', P + '/api/sessions/' + encodeURIComponent(s2.id), { provider: s.provider }); }
          return s2;
        }).then(function (s2) {
          sessions.push(s2);
          location.hash = 'chat/' + encodeURIComponent(s2.id);
        }).catch(function (er) { toast(er.message); });
        break;
    }
  }

  /** infoRows：弹窗里的「名称 内容」列表 */
  function infoRows(rows) {
    return '<dl class="pd-kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>';
  }

  /** statusModal：当前会话状态 */
  function statusModal(s) {
    var st = { running: '执行中', awaiting: '等待审批', interrupted: '已打断', error: '出错', exited: '已结束' }[s.state] || '空闲';
    modal('会话状态', infoRows([
      ['Agent', AGENT[s.kind] || s.kind],
      ['模型', s.model || '默认'],
      ['供应商', s.provider || '跟随电脑设置'],
      ['工作目录', s.cwd || '工作区根目录'],
      ['状态', st],
      ['审批', s.autoApprove ? '免审批' : '需要确认'],
      ['提醒', s.muted ? '已关闭' : '已开启']
    ].concat(s.kind === 'pi' ? [['强度设置', s.effort === 'default' ? '跟随 Pi 配置' : (s.effort || '沿用 Pi 会话')]] : [])), '<button class="pd-btn pd-btn-primary" data-act="modal-close">好</button>');
  }

  /** usageModal：本会话累计用量（按已加载的记录统计） */
  function usageModal(s) {
    var lg = logs[s.id], turns = 0, inTok = 0, outTok = 0, cost = 0;
    ((lg && lg.events) || []).forEach(function (e) {
      if (e.type !== 'usage') { return; }
      var d = typeof e.data === 'string' ? JSON.parse(e.data) : (e.data || {});
      turns++;
      inTok += d.inputTokens || 0;
      outTok += d.outputTokens || 0;
      cost += d.costUsd || 0;
    });
    var rows = [['轮数', String(turns)], ['输入', inTok + ' tokens'], ['输出', outTok + ' tokens']];
    if (cost > 0) { rows.push(['费用', '$' + cost.toFixed(4)]); }
    modal('本会话用量', infoRows(rows), '<button class="pd-btn pd-btn-primary" data-act="modal-close">好</button>');
  }

  /** patchSession：修改会话并刷新界面 */
  function patchSession(s, body, done) {
    return api('PATCH', P + '/api/sessions/' + encodeURIComponent(s.id), body).then(function (s2) {
      Object.assign(s, s2);
      renderHead();
      renderList();
      if (done) { toast(done); }
      return s2;
    });
  }

  /** chooseModel：切换模型（列表来自 Agent 或所选供应商） */
  function chooseModel(s) {
    remoteModal('切换模型', '正在获取模型列表…', function () { return api('GET', P + '/api/agents/' + s.kind + '/models' + (s.provider ? '?provider=' + encodeURIComponent(s.provider) : '')); }, function (list) {
      list = list || [];
      modal('切换模型', (list.length ? '<div class="pd-pick-list">' + list.map(function (m) {
        return '<button class="pd-pick-row' + (m === s.model ? ' active' : '') + '" data-act="model-pick" data-sid="' + esc(s.id) + '" data-model="' + esc(m) + '">' + icon(m === s.model ? 'check' : 'cpu', 16) + '<span class="pd-mono">' + esc(m) + '</span></button>';
      }).join('') + '</div>' : '<div class="pd-muted">没有查到可选模型，可以直接填写</div>') +
        '<div class="pd-field" style="margin-top:10px"><label for="model-custom">其他模型</label><input class="pd-input pd-mono" id="model-custom" placeholder="填写模型名称" value=""></div>',
        (s.model ? '<button class="pd-btn" data-act="model-pick" data-sid="' + esc(s.id) + '" data-model="">恢复默认</button>' : '') + '<button class="pd-btn" data-act="modal-close">取消</button><button class="pd-btn pd-btn-primary" data-act="model-custom" data-sid="' + esc(s.id) + '">使用</button>');
    });
  }

  function effortRequest(method, s, level) {
    return api(method, P + '/api/sessions/' + encodeURIComponent(s.id) + '/effort', method === 'PUT' ? { level: level } : undefined, 30000).catch(function (er) {
      if ((er.status === 404 && !er.code) || er.status === 405) { er.message = '电脑端尚不支持 /effort，请更新电脑端'; }
      throw er;
    });
  }

  /** chooseEffort：由 Pi 提供档位；显示实际值，默认与关闭分别列出。 */
  function chooseEffort(s, arg) {
    if (!s || s.kind !== 'pi') { toast('/effort 当前仅支持 Pi 会话'); return; }
    if (arg && arg.trim()) { setEffort(s, arg.trim().toLowerCase()); return; }
    remoteModal('思考强度', '正在读取可用思考强度…', function () { return effortRequest('GET', s); }, function (info) {
      Object.assign(s, info.session);
      var setting = info.override === 'default' ? '跟随 Pi 配置' : (info.override || '沿用 Pi 会话');
      var rows = [{ value: 'default', label: '跟随 Pi 配置', note: '清除本会话的强度覆盖', selected: info.override === 'default' }].concat((info.levels || []).map(function (v) {
        return { value: v, label: v === 'off' ? 'off（关闭思考）' : v, note: v === info.level ? '当前实际生效' : '', selected: info.override !== 'default' && v === info.level };
      }));
      modal('思考强度', infoRows([['模型', info.model], ['实际强度', info.level], ['强度设置', setting]]) +
        '<div class="pd-pick-list" id="effort-options">' + rows.map(function (r) {
          return '<button class="pd-pick-row" data-act="effort-pick" data-sid="' + esc(s.id) + '" data-level="' + esc(r.value) + '">' + icon(r.selected ? 'check' : 'cpu', 16) +
            '<span><span>' + esc(r.label) + '</span>' + (r.note ? '<span class="pd-muted" style="display:block;font-size:12px">' + esc(r.note) + '</span>' : '') + '</span></button>';
        }).join('') + '</div>', '<button class="pd-btn" data-act="modal-close">取消</button>');
    });
  }

  var effortPending = {};
  function setEffort(s, level) {
    if (!s || effortPending[s.id]) { return; }
    effortPending[s.id] = true;
    var button = modalRoot.querySelector('[data-act="effort-pick"][data-level="' + CSS.escape(level) + '"]');
    if (!button) {
      modal('调整思考强度', '<p>' + esc(level) + '</p>', '<button class="pd-btn pd-btn-primary" id="effort-apply">重试</button>');
      button = document.getElementById('effort-apply');
      button.onclick = function () { setEffort(s, level); };
    }
    modalAction(button, function () { return effortRequest('PUT', s, level); }, function (info) {
      Object.assign(s, info.session); renderHead();
      toast((level === 'default' ? '已跟随 Pi 配置，当前为 ' : '实际思考强度：') + info.level);
    }).finally(function () { delete effortPending[s.id]; });
  }

  /** chooseProvider：切换模型供应商（CC Switch 中的供应商，只影响这个会话） */
  function chooseProvider(s) {
    if (s.kind !== 'claude' && s.kind !== 'codex') { toast('只有 Claude Code 与 Codex 可以切换供应商'); return; }
    remoteModal('模型供应商', '正在读取模型供应商…', function () { return api('GET', P + '/api/agents/' + s.kind + '/providers'); }, function (r) {
      if (!r.available) { throw new Error('电脑上没有找到 CC Switch'); }
      var cur = (r.list || []).filter(function (p) { return p.current; })[0];
      var rows = [{ id: '', name: '跟随电脑当前设置', host: cur ? '当前：' + cur.name : '' }].concat(r.list || []);
      modal('模型供应商', '<div class="pd-muted" style="font-size:12px;margin-bottom:8px">只对这个会话生效，不影响电脑上的其他会话</div><div class="pd-pick-list">' + rows.map(function (p) {
        var on = (s.provider || '') === p.id;
        return '<button class="pd-pick-row' + (on ? ' active' : '') + '" data-act="provider-pick" data-sid="' + esc(s.id) + '" data-id="' + esc(p.id) + '">' + icon(on ? 'check' : 'server', 16) +
          '<span style="flex:1;min-width:0"><div>' + esc(p.name) + (p.current ? ' <span class="pd-muted" style="font-size:12px">电脑当前</span>' : '') + '</div>' + (p.host ? '<div class="pd-path">' + esc(p.host) + '</div>' : '') + '</span></button>';
      }).join('') + '</div>', '<button class="pd-btn" data-act="modal-close">关闭</button>');
    });
  }

  /** skillsModal：skill 列表；开关控制是否启用，勾选后随下一条消息使用，点名称查看说明 */
  var skillList = [];
  function skillsModal(s) {
    if (s.kind !== 'claude' && s.kind !== 'codex') { toast('这个 Agent 暂不支持 skill'); return; }
    modal('Skills', '<div class="pd-muted">正在读取…</div>', '<button class="pd-btn" data-act="modal-close">完成</button>');
    api('GET', P + '/api/agents/' + s.kind + '/skills?session=' + encodeURIComponent(s.id)).then(function (list) {
      skillList = list || [];
      renderSkills(s);
    }).catch(function (er) { closeModal(); toast(er.message); });
  }
  function renderSkills(s) {
    var chosen = chosenSkills[s.id] || [];
    var scope = { project: '项目', user: '本机', system: '自带', admin: '管理员' };
    modal('Skills', skillList.length ? '<div class="pd-muted" style="font-size:12px;margin-bottom:8px">勾选的 skill 会随下一条消息使用；右侧开关控制是否启用</div><div class="pd-pick-list" style="max-height:420px">' + skillList.map(function (k) {
      var picked = chosen.some(function (c) { return c.path === k.path; });
      return '<div class="pd-pick-row" style="cursor:default">' +
        '<input type="checkbox" class="pd-skill-pick" data-path="' + esc(k.path) + '"' + (picked ? ' checked' : '') + (k.enabled ? '' : ' disabled') + ' aria-label="随下一条消息使用">' +
        '<button class="pd-link" style="flex:1;min-width:0;text-align:left" data-act="skill-view" data-path="' + esc(k.path) + '"><div>' + esc(k.name) + ' <span class="pd-muted" style="font-size:12px">' + (scope[k.scope] || k.scope) + '</span></div>' +
        '<div class="pd-path" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(k.description || '') + '</div></button>' +
        '<label class="pd-switch"><input type="checkbox" class="pd-skill-toggle" data-path="' + esc(k.path) + '"' + (k.enabled ? ' checked' : '') + ' aria-label="启用"><span></span></label></div>';
    }).join('') + '</div>' : '<div class="pd-muted">没有找到已安装的 skill</div>', '<button class="pd-btn pd-btn-primary" data-act="modal-close">完成</button>');
  }

  /** renderChosen：输入框上方显示已选的 skill */
  function renderChosen() {
    var historySid = route().sid;
    if (historyCompositions && historyCompositions[historySid]) { historyCompositions[historySid].skills = chosenSkills[historySid] || []; save('pd.historyCompositions', historyCompositions); }
    var el = document.getElementById('chosen');
    var sid = route().sid, list = chosenSkills[sid] || [];
    if (!el) { return; }
    el.innerHTML = list.map(function (k, i) {
      return '<span>' + icon('sparkles', 12) + esc(k.name) + '<button class="pd-icon-btn" style="width:18px;height:18px" data-act="unskill" data-i="' + i + '" aria-label="移除">' + icon('x', 12) + '</button></span>';
    }).join('');
  }

  /** externalModal：电脑上最近的 Claude Code 与 Codex 会话，选一个接着聊 */
  var externalList = [];
  function externalModal() {
    modal('接着电脑上的会话', '<div class="pd-muted">正在读取…</div>', '<button class="pd-btn" data-act="modal-close">取消</button>');
    api('GET', P + '/api/external?limit=80').then(function (list) {
      externalList = list || [];
      modal('接着电脑上的会话', externalList.length ? '<div class="pd-pick-list" style="max-height:440px">' + externalList.map(function (x, i) {
        return '<button class="pd-pick-row" data-act="external-pick" data-i="' + i + '">' + avatarHtml(x.kind, true) +
          '<span style="flex:1;min-width:0"><div style="display:flex;gap:6px;align-items:baseline"><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x.title) + '</span>' + (x.session ? '<span class="pd-muted" style="font-size:12px;flex-shrink:0">已接入</span>' : '') + '</div>' +
          '<div class="pd-path" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x.cwd) + ' · ' + listTime(x.updatedAt) + '</div></span></button>';
      }).join('') + '</div>' : '<div class="pd-muted">电脑上没有找到 Claude Code 或 Codex 的会话</div>', '<button class="pd-btn" data-act="modal-close">取消</button>');
    }).catch(function (er) { closeModal(); toast(er.message); });
  }

  /** importExternal：接入电脑上的会话；目录还不是工作区时先确认添加 */
  function importExternal(x) {
    if (x.session) { closeModal(); unhideSession(x.session); location.hash = 'chat/' + encodeURIComponent(x.session); return; }
    api('POST', P + '/api/sessions/import', { kind: x.kind, agentSessionId: x.id, cwd: x.cwd, title: x.title }).then(function (s2) {
      closeModal();
      if (!session(s2.id)) { sessions.push(s2); }
      delete logs[s2.id];
      location.hash = 'chat/' + encodeURIComponent(s2.id);
    }).catch(function (er) {
      if (er.code !== 'no_workspace') { toast(er.message); return; }
      confirmBox('添加工作区', '「' + esc(x.cwd) + '」还不是工作区。添加后手机也能浏览这个文件夹，并接着这个会话聊。', '添加并继续', function () {
        api('POST', P + '/api/ws', { path: x.cwd }).then(function () { importExternal(x); }).catch(function (e2) { toast(e2.message); });
      });
    });
  }

  function sessionRoot(s) {
    var ws = s && wsById(s.workspaceId), root = ws ? ws.rootPath : s && s.workspaceId === 'computer' ? '/' : '';
    if (s && s.cwd && s.cwd !== '.') root = /^(\/|[A-Za-z]:[\\/])/.test(s.cwd) ? s.cwd : root ? root.replace(/\/$/, '') + '/' + s.cwd : '';
    return root;
  }
  function sidebarOptions(sid) {
    var s = session(sid), root = sessionRoot(s), ws = wsById(s.workspaceId), cwd = s.cwd === '.' ? '' : s.cwd || '';
    if (/^\//.test(cwd)) cwd = ws ? cwd.slice(ws.rootPath.replace(/\/$/, '').length).replace(/^\//, '') : cwd.replace(/^\//, '');
    var base = P + '/api/ws/' + encodeURIComponent(s.workspaceId), diff = P + '/api/sessions/' + encodeURIComponent(sid) + '/diff';
    function path(p) { return (cwd ? cwd + '/' : '') + p; }
    function fileURL(p) { return base + '/file?path=' + encodeURIComponent(path(p)); }
    return { sid: sid, root: root, rootName: root.split('/').filter(Boolean).pop() || '会话目录', icon: icon, isImage: isImage, fileURL: fileURL,
      list: function (dir, signal) {
        return api('GET', base + '/list?hidden=1&counts=0&path=' + encodeURIComponent(path(dir) || '.'), undefined, 45000, signal).then(function (r) {
          return (r.entries || []).map(function (f) { return Object.assign({}, f, { path: (dir ? dir + '/' : '') + f.name, abs: root.replace(/\/$/, '') + '/' + (dir ? dir + '/' : '') + f.name }); });
        });
      },
      read: function (p, signal) {
        return fetch(fileURL(p), { credentials: 'same-origin', signal: signal, headers: { Range: 'bytes=0-262143' } }).then(function (res) {
          if (res.status === 416 && res.headers.get('Content-Range') === 'bytes */0') return { text: '', truncated: false };
          return res.text().then(function (text) {
            if (!res.ok) { var error; try { error = JSON.parse(text); } catch (_) {} throw new Error(error && error.message || '无法读取文件'); }
            var total = /\/(\d+)$/.exec(res.headers.get('Content-Range') || '');
            return { text: text, truncated: !!total && +total[1] > 262144 };
          });
        });
      },
      loadDiffs: function (signal) { return api('GET', diff, undefined, 45000, signal).then(function (r) { return { files: r.files || [], source: r.git ? '当前工作目录的未提交改动' : '本会话记录的改动' }; }); },
      loadDiff: function (file, signal) {
        if (file.lines) return Promise.resolve(file.lines.join('\n'));
        if (file.binary) return Promise.resolve(null);
        var query = file.ref ? 'ref=' + encodeURIComponent(file.ref) : 'path=' + encodeURIComponent(file.path);
        return api('GET', diff + '?' + query, undefined, 45000, signal).then(function (r) { return r.diff; });
      },
      openFile: function (file) { if (file.abs) api('POST', '/admin/api/open', { which: 'abs', path: file.abs }).catch(function (e) { toast(e.message); }); }
    };
  }
  function openChanges(sid, files, index, source) {
    PDToolView.dismiss();
    PDChanges.open(Object.assign(sidebarOptions(sid), { diff: { files: files, index: index, source: source } }));
  }

  /** popMenu：在指定位置弹出菜单 */
  function popMenu(x, y, items) {
    closeMenu();
    var m = document.createElement('div');
    m.className = 'pd-menu';
    m.id = 'menu';
    function one(it) {
      return '<button data-menu="' + it[0] + '"' + (it[2] ? ' class="danger"' : '') + '>' + (it[3] ? icon(it[3], 16) : '') + esc(it[1]) + '</button>';
    }
    m.innerHTML = items.map(function (it) {
      if (typeof it === 'string' && it.charAt(0) === '#') { return '<div class="pd-menu-sec">' + esc(it.slice(1)) + '</div>'; }
      if (it === '-') { return '<hr>'; }
      // 带二级菜单：第五项是子菜单的条目，鼠标移上去才展开
      if (it[4]) {
        return '<div class="pd-subwrap"><button type="button" class="pd-subbtn">' + (it[3] ? icon(it[3], 16) : '') + '<span style="flex:1">' + esc(it[1]) + '</span>' + icon('chevron-right', 14) + '</button>' +
          '<div class="pd-menu pd-submenu">' + it[4].map(one).join('') + '</div></div>';
      }
      return one(it);
    }).join('');
    m.addEventListener('mouseover', function (e) {
      var wrap = e.target.closest('.pd-subwrap');
      if (!wrap) { return; }
      var sub = wrap.querySelector('.pd-submenu');
      var wr = wrap.getBoundingClientRect();
      sub.style.maxHeight = (window.innerHeight - 16) + 'px';
      sub.style.display = 'block';
      var sw = sub.offsetWidth, sh = sub.offsetHeight;
      sub.style.display = '';
      var top = Math.max(8, Math.min(wr.top - 4, window.innerHeight - sh - 8));
      sub.style.top = (top - wr.top) + 'px';
      sub.classList.toggle('left', wr.right + sw > window.innerWidth - 8);
    });
    document.body.appendChild(m);
    var w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
    return new Promise(function (resolve) { menuResolve = resolve; });
  }
  var menuResolve = null;
  function closeMenu() {
    var m = document.getElementById('menu');
    if (m) { m.remove(); }
    if (menuResolve) { var r = menuResolve; menuResolve = null; r(null); }
  }

  /* ---------- 文件：电脑工作区与手机工作空间 ---------- */
  var ph = { kind: '', ws: '', dev: '', phones: null, path: '', entries: [], root: '', readOnly: false, error: '', loading: false, etag: '' };
  var TEXT_EXT = /\.(txt|md|markdown|json|js|ts|jsx|tsx|go|py|dart|java|kt|swift|c|h|cpp|rs|rb|php|sh|yaml|yml|toml|ini|conf|cfg|csv|log|xml|html|css|scss|sql|env)$/i;

  function wsById(id) { return ((host && host.workspaces) || []).filter(function (w) { return w.id === id; })[0]; }
  function wsBase() { return P + '/api/ws/' + encodeURIComponent(ph.ws); }
  function isWsSrc() { return ph.kind === 'ws'; }
  function fsReady() { return !!(isWsSrc() ? ph.ws : ph.dev) && !ph.error; }
  function fsName() {
    if (isWsSrc()) { var w = wsById(ph.ws); return w ? w.name : '工作区'; }
    return '手机文件';
  }

  /** fsRows：左侧列表——电脑的工作区与在线的手机 */
  function fsRows() {
    var wss = (host && host.workspaces) || [];
    var out = '<div class="pd-list-sec">电脑</div>';
    out += wss.length ? wss.map(function (w) {
      return '<button class="pd-row' + (isWsSrc() && w.id === ph.ws ? ' active' : '') + '" data-act="fs-pick" data-kind="ws" data-id="' + esc(w.id) + '"><div class="pd-row-avatar">' + avatarHtml('host') + '</div>' +
        '<div class="pd-row-main"><div class="pd-row-line"><span class="pd-row-title">' + esc(w.name) + '</span></div><div class="pd-row-sub">' + esc(w.rootPath) + '</div></div></button>';
    }).join('') : '<div class="pd-empty">还没有工作区</div>';
    out += '<div class="pd-list-sec">手机</div>';
    if (!ph.phones) { return out + '<div class="pd-empty">正在读取…</div>'; }
    out += ph.phones.length ? ph.phones.map(function (p) {
      return '<button class="pd-row' + (!isWsSrc() && p.id === ph.dev ? ' active' : '') + '" data-act="fs-pick" data-kind="phone" data-id="' + esc(p.id) + '" data-phone="' + esc(p.id) + '" data-name="' + esc(p.name) + '"><div class="pd-row-avatar">' + avatarHtml('phone') + '</div>' +
        '<div class="pd-row-main"><div class="pd-row-line"><span class="pd-row-title">' + esc(p.name) + '</span></div><div class="pd-row-sub">' + (p.online ? '在线' : '不在线') + '</div></div></button>';
    }).join('') : '<div class="pd-empty">没有在线的手机<br>在手机上打开 PocketDesk 后会出现在这里</div>';
    return out;
  }

  /** canEditFs：当前位置是否允许重命名、删除 */
  function canEditFs() { return fsReady() && !ph.readOnly; }

  function fsMain() {
    var ready = fsReady();
    var canEdit = ready && !ph.readOnly;
    var head = '<header class="pd-head"><div class="pd-head-main"><div class="pd-head-title">' + esc(fsName()) + '</div><div class="pd-head-sub pd-mono">' + esc(ph.root || (isWsSrc() ? '' : '管理手机上的工作空间')) + '</div></div><div class="pd-head-acts">' +
      (ready ? '<button class="pd-btn" data-act="fs-root">' + icon('folder-search', 16) + '更换目录</button>' : '') +
      (canEdit ? '<button class="pd-btn" data-act="fs-mkdir">' + icon('folder-plus', 16) + '新建文件夹</button>' +
        '<button class="pd-btn pd-btn-primary" data-act="fs-upload">' + icon('upload', 16) + '上传</button>' : '') +
      '<button class="pd-icon-btn" data-act="fs-refresh" title="刷新" aria-label="刷新">' + icon('refresh-cw', 16) + '</button>' +
      (!isWsSrc() && ph.dev ? '<button class="pd-icon-btn" data-act="phone-kick" title="移除这台手机" aria-label="移除这台手机">' + icon('trash', 16) + '</button>' : '') + '</div></header>';
    var body;
    if (!ph.kind && ph.phones) { body = '<div class="pd-empty">没有可管理的位置，先在「设置 → 权限」里添加工作区，或在手机上打开 PocketDesk</div>'; }
    else if (!ph.kind) { body = '<div class="pd-empty">正在读取…</div>'; }
    else if (ph.error) { body = '<div class="pd-warn">' + icon('alert-triangle', 16) + '<div>' + esc(ph.error) + '</div></div>'; }
    else {
      var parts = ph.path ? ph.path.split('/') : [];
      var crumbs = '<button class="pd-link" data-act="fs-cd" data-path="">' + (isWsSrc() ? esc(fsName()) : '工作空间') + '</button>' + parts.map(function (p, i) {
        return '<span>/</span><button class="pd-link" data-act="fs-cd" data-path="' + esc(parts.slice(0, i + 1).join('/')) + '">' + esc(p) + '</button>';
      }).join('');
      var rows = ph.entries.map(function (e) {
        var p = (ph.path ? ph.path + '/' : '') + e.name;
        var tile = e.isDir ? tileHtml('folder', 'var(--pd-tile-blue)') : isImage(e.name) ? tileHtml('image', 'var(--pd-tile-teal)') : tileHtml('file', 'var(--pd-tile-indigo)');
        return '<tr class="pd-fsrow" data-path="' + esc(p) + '" data-name="' + esc(e.name) + '" data-dir="' + (e.isDir ? 1 : 0) + '"><td><button class="pd-name pd-name-btn" data-act="fs-open" data-path="' + esc(p) + '" data-dir="' + (e.isDir ? 1 : 0) + '">' + tile + '<span>' + esc(e.name) + '</span></button></td>' +
          '<td class="pd-muted pd-nowrap pd-hide-s">' + (e.isDir ? '' : fmtSize(e.size)) + '</td><td class="pd-muted pd-nowrap pd-hide-s">' + (e.modTime ? fmtTime(e.modTime).slice(0, 16) : '') + '</td>' +
          '</tr>';
      }).join('');
      body = '<div class="pd-crumbs">' + crumbs + (ph.loading ? '<em class="pd-muted" style="margin-left:8px;font-style:normal">加载中…</em>' : '') + '</div>' +
        '<div class="pd-card' + (canEdit ? ' pd-drop' : '') + '">' + (rows ? '<table class="pd-table"><tr><th>名称</th><th class="pd-hide-s" style="width:90px">大小</th><th class="pd-hide-s" style="width:140px">修改时间</th></tr>' + rows + '</table>' :
          '<div class="pd-empty">' + (canEdit ? '这个文件夹是空的，把文件拖进来即可上传' : '这个文件夹是空的') + '</div>') + '</div>';
    }
    return head + '<div class="pd-page"><div class="pd-page-inner" style="max-width:none">' + body + '</div></div><input type="file" id="fs-file" class="pd-file-input" multiple tabindex="-1" aria-hidden="true">';
  }

  function phoneCall(op, args) { return api('POST', '/admin/api/phone/' + encodeURIComponent(ph.dev) + '/call', { op: op, args: args || {} }); }
  function phoneFileUrl(p) { return '/admin/api/phone/' + encodeURIComponent(ph.dev) + '/file?path=' + encodeURIComponent(p); }
  function fsUrl(p) { return isWsSrc() ? wsBase() + '/file?path=' + encodeURIComponent(p) : phoneFileUrl(p); }
  function fsParent(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function fsRedraw() { if (route().page === 'phone') { renderList(); renderMain(); } }

  /**
   * fsLoad：刷新左侧列表并读取当前目录
   *
   * 处理流程：
   * 1、读取在线的手机；当前位置失效（工作区被删、手机下线）或还没选时，改选第一个电脑工作区，没有则选第一台手机
   * 2、读取当前目录
   */
  function fsLoad() {
    ph.loading = true;
    fsRedraw();
    return (host ? Promise.resolve() : loadHost()).then(function () {
      return api('GET', '/admin/api/phones');
    }).then(function (list) {
      // 1、位置
      ph.phones = (list || []).filter(function (p) { return p.online; });
      var wss = (host && host.workspaces) || [];
      var ok = ph.kind === 'ws' ? wss.some(function (w) { return w.id === ph.ws; }) : ph.kind === 'phone' && ph.phones.some(function (p) { return p.id === ph.dev; });
      if (!ok) {
        ph.path = '';
        ph.entries = [];
        if (wss.length) { ph.kind = 'ws'; ph.ws = wss[0].id; ph.dev = ''; }
        else if (ph.phones.length) { ph.kind = 'phone'; ph.dev = ph.phones[0].id; ph.ws = ''; }
        else { ph.kind = ''; ph.ws = ''; ph.dev = ''; ph.root = ''; ph.error = ''; return; }
      }
      // 2、目录
      if (isWsSrc()) {
        return api('GET', wsBase() + '/list?path=' + encodeURIComponent(ph.path || '.')).then(function (r) {
          ph.entries = r.entries || [];
          ph.readOnly = !!r.readOnly;
          ph.root = wsById(ph.ws).rootPath;
          ph.error = '';
        });
      }
      return phoneCall('list', { path: ph.path }).then(function (r) {
        ph.entries = r.entries || [];
        ph.readOnly = false;
        ph.root = r.root || '';
        ph.error = '';
      });
    }).catch(function (er) { ph.error = er.message; }).then(function () { ph.loading = false; fsRedraw(); });
  }

  /** fsOp：新建文件夹、重命名、删除 */
  function fsOp(op, p, name) {
    if (isWsSrc()) { return api('POST', wsBase() + '/ops', { op: op, path: op === 'mkdir' ? (ph.path || '.') : p, name: name }); }
    if (op === 'delete') { return phoneCall('delete', { paths: [p] }); }
    return phoneCall(op, { path: op === 'mkdir' ? ph.path : p, name: name });
  }

  /** uniqueName：与目录里已有的名字重复时加序号 */
  function uniqueName(name, taken) {
    if (!taken[name]) { return name; }
    var i = name.lastIndexOf('.');
    var stem = i > 0 ? name.slice(0, i) : name, ext = i > 0 ? name.slice(i) : '';
    var n = 1;
    while (taken[stem + ' (' + n + ')' + ext]) { n++; }
    return stem + ' (' + n + ')' + ext;
  }

  function fsUpload(files) {
    if (!files.length || !fsReady() || ph.readOnly) { return; }
    if (!isWsSrc()) { phoneUpload(files); return; }
    var taken = {}, dir = ph.path, id = ph.ws;
    ph.entries.forEach(function (e) { taken[e.name] = true; });
    toast('正在上传 ' + files.length + ' 个文件…');
    files.reduce(function (chain, f) {
      return chain.then(function () {
        var name = uniqueName(f.name, taken);
        taken[name] = true;
        var url = P + '/api/ws/' + encodeURIComponent(id) + '/file?create=1&path=' + encodeURIComponent((dir ? dir + '/' : '') + name);
        return fetch(url, { method: 'PUT', body: f, credentials: 'same-origin' }).then(function (res) {
          if (res.ok) { return; }
          return res.json().catch(function () { return null; }).then(function (d) { throw new Error((d && d.message) || '上传失败'); });
        });
      });
    }, Promise.resolve()).then(function () { toast('已上传'); fsLoad(); }).catch(function (er) { toast(er.message); fsLoad(); });
  }

  function phoneUpload(files) {
    if (!files.length || !ph.dev) { return; }
    toast('正在上传 ' + files.length + ' 个文件到手机…');
    uploadForm('/admin/api/phone/' + encodeURIComponent(ph.dev) + '/upload?dir=' + encodeURIComponent(ph.path), files)
      .then(function () { toast('已上传到手机'); fsLoad(); }).catch(function (er) { toast(er.message); });
  }

  /** fsOpen：图片预览，文本在窗口里编辑，其他格式用默认程序打开（手机上的先存到电脑） */
  function fsOpen(p) {
    var name = p.split('/').pop();
    if (isImage(name)) {
      imagePreview(name, fsUrl(p), isWsSrc() ? '<button class="pd-btn" data-act="fs-reveal" data-path="' + esc(p) + '">' + icon('folder-open', 16) + '显示</button>'
        : '<button class="pd-btn" data-act="phone-fetch" data-path="' + esc(p) + '">' + icon('download', 16) + '存到电脑</button>');
      return;
    }
    if (!TEXT_EXT.test(name)) {
      if (isWsSrc()) {
        api('POST', '/admin/api/open', { which: 'wsfile', id: ph.ws, path: p }).catch(function (er) { toast(er.message); });
        return;
      }
      toast('正在从手机取文件…');
      api('POST', '/admin/api/phone/' + encodeURIComponent(ph.dev) + '/fetch', { path: p, open: true }, 300000).catch(function (er) { toast(er.message); });
      return;
    }
    fetch(fsUrl(p), { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) { return res.json().then(function (d) { throw new Error((d && d.message) || '读取失败'); }); }
      ph.etag = res.headers.get('ETag') || '';
      return res.text();
    }).then(function (text) {
      modalRoot.innerHTML = '<div class="pd-scrim"><div class="pd-dialog pd-editor" role="dialog" aria-modal="true" aria-label="' + esc(name) + '">' +
        '<div class="pd-dialog-head"><div class="pd-dialog-title">' + esc(name) + '</div><button class="pd-icon-btn" data-act="modal-close" aria-label="关闭">' + icon('x', 18) + '</button></div>' +
        '<textarea id="edit-text" class="pd-input" spellcheck="false"' + (ph.readOnly ? ' readonly' : '') + '></textarea>' +
        '<div class="pd-dialog-foot"><button class="pd-btn" data-act="modal-close">' + (ph.readOnly ? '关闭' : '取消') + '</button>' +
        (ph.readOnly ? '' : '<button class="pd-btn pd-btn-primary" data-act="fs-save" data-path="' + esc(p) + '">' + icon('save', 16) + '保存</button>') + '</div></div></div>';
      var ta = document.getElementById('edit-text');
      ta.value = text;
      ta.focus();
    }).catch(function (er) { toast(er.message); });
  }

  /** fsSave：保存编辑的文本；电脑上的文件带上打开时的版本，被别处改过会提示冲突 */
  function fsSave(p) {
    var text = document.getElementById('edit-text').value;
    var done = function () { closeModal(); toast('已保存'); fsLoad(); };
    if (isWsSrc()) {
      fetch(wsBase() + '/file?path=' + encodeURIComponent(p), { method: 'PUT', headers: { 'If-Match': ph.etag || '*' }, body: text, credentials: 'same-origin' }).then(function (res) {
        if (res.ok) { done(); return; }
        return res.json().catch(function () { return null; }).then(function (d) { throw new Error((d && d.message) || '保存失败'); });
      }).catch(function (er) { toast(er.message); });
      return;
    }
    var f = new File([text], p.split('/').pop(), { type: 'text/plain' });
    uploadForm('/admin/api/phone/' + encodeURIComponent(ph.dev) + '/upload?overwrite=1&dir=' + encodeURIComponent(fsParent(p)), [f]).then(done).catch(function (er) { toast(er.message); });
  }

  /** phoneRootPicker：浏览手机存储选择工作空间目录 */
  function phoneRootPicker(p) {
    phoneCall('browse', { path: p || '' }).then(function (r) {
      var dirs = (r.dirs || []).map(function (d) {
        return '<button class="pd-pick-row" data-act="phone-browse" data-path="' + esc(r.path + '/' + d) + '">' + icon('folder', 16) + '<span>' + esc(d) + '</span></button>';
      }).join('') || '<div class="pd-empty">没有子文件夹</div>';
      modal('选择手机工作空间',
        '<div class="pd-mono pd-muted" style="font-size:12px;word-break:break-all">' + esc(r.path) + '</div>' +
        (r.parent ? '<button class="pd-pick-row" data-act="phone-browse" data-path="' + esc(r.parent) + '">' + icon('chevron-left', 16) + '<span>上一级</span></button>' : '') +
        '<div class="pd-pick-list">' + dirs + '</div>',
        '<button class="pd-btn" data-act="modal-close">取消</button><button class="pd-btn pd-btn-primary" data-act="phone-setroot" data-path="' + esc(r.path) + '">使用这个文件夹</button>');
    }).catch(function (er) { toast(er.message); });
  }

  /* ---------- 设置 ---------- */

  function settingsMain(section) {
    var name = (SETTINGS.filter(function (s) { return s[0] === section; })[0] || SETTINGS[0])[1];
    var body = host ? ({ overview: overviewView, workspaces: workspacesView, devices: devicesView, transfer: transferView, security: securityView, appearance: appearanceView, about: aboutView }[section] || overviewView)() : ['', ''];
    return '<header class="pd-head"><div class="pd-head-main"><div class="pd-head-title">' + name + '</div></div>' + (body[1] ? '<div class="pd-head-acts">' + body[1] + '</div>' : '') + '</header>' +
      '<div class="pd-page"><div class="pd-page-inner">' + (host ? body[0] : '<div class="pd-empty">正在读取…</div>') + '</div></div>';
  }

  function setting(ic, color, name, desc, id, on) {
    return '<div class="pd-setting">' + tileHtml(ic, color) + '<div class="pd-setting-text"><div>' + name + '</div><div class="pd-setting-desc">' + desc + '</div></div>' + toggle(id, on) + '</div>';
  }
  function toggle(id, on) { return '<label class="pd-switch"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span></span></label>'; }
  function fmtFp(fp) { return ((fp || '').toUpperCase().match(/.{1,4}/g) || []).join(' '); }
  function platformName(p) { return { ios: 'iOS', android: 'Android', web: '浏览器' }[p] || p || '未知'; }
  function ago(ms) {
    if (!ms) { return '从未在线'; }
    var d = (Date.now() - ms) / 1000;
    if (d < 60) { return '刚刚在线'; }
    if (d < 3600) { return Math.floor(d / 60) + ' 分钟前在线'; }
    if (d < 86400) { return Math.floor(d / 3600) + ' 小时前在线'; }
    return Math.floor(d / 86400) + ' 天前在线';
  }

  function overviewView() {
    if (!host) { return ['', '']; }
    var online = host.devices.filter(function (d) { return d.online; }).length;
    var paired = host.devices.filter(function (d) { return !d.revoked; }).length;
    var addrs = (host.addresses || []).map(function (a) {
      return '<div><span class="pd-mono">' + esc(a.ip) + '</span> <span class="pd-tag' + (a.kind === 'tailscale' ? '' : ' pd-tag-ok') + '">' + (a.kind === 'tailscale' ? 'Tailscale' : '局域网') + '</span></div>';
    }).join('') || '<span class="pd-muted">未检测到局域网或 Tailscale 地址</span>';
    var agents = (host.agents || []).map(function (a) {
      var n = sessions.filter(function (s) { return s.kind === a.kind; }).length;
      return '<button class="pd-agent' + (a.installed ? '' : ' off') + '" data-act="agent" data-kind="' + esc(a.kind) + '"' + (a.installed ? '' : ' disabled') + '>' + avatarHtml(a.kind) +
        '<div style="min-width:0;flex:1"><div>' + esc(a.label) + '</div><div class="pd-muted" style="font-size:12px">' + (a.installed ? esc(a.version || '已安装') + (n ? ' · ' + n + ' 个会话' : '') : '未安装') + '</div></div>' +
        (a.installed ? '<span class="pd-muted">' + icon('chevron-right', 16) + '</span>' : '') + '</button>';
    }).join('');
    return ['<div class="pd-hero"><div class="pd-hero-icon">' + icon('monitor', 26) + '</div><div><div class="pd-hero-name">' + esc(host.host.name) + '</div><div class="pd-hero-state"><i></i>运行中 · 端口 ' + host.host.port + '</div></div>' +
      '<div class="pd-stats"><div><b>' + online + '</b><span>在线手机</span></div><div><b>' + paired + '</b><span>已配对</span></div><div><b>' + host.workspaces.length + '</b><span>工作区</span></div></div></div>' +
      '<div class="pd-h2">连接</div><div class="pd-card"><dl class="pd-kv"><dt>访问地址</dt><dd>' + addrs + '</dd><dt>证书指纹</dt><dd class="pd-mono" style="font-size:12px">' + esc(fmtFp(host.host.fingerprint)) + '</dd></dl></div>' +
      remoteCard() +
      '<div class="pd-h2">AI 编程工具</div><div class="pd-agents">' + agents + '</div>',
      '<button class="pd-btn pd-btn-primary" data-act="pair">' + icon('qr-code', 16) + '配对新手机</button>'];
  }

  /** remoteCard：异地连接（Tailscale）状态与下载入口 */
  function remoteCard() {
    var r = host.remote || { state: 'missing', addresses: [] };
    var desc, act = '';
    if (r.state === 'ready') {
      desc = '已连通，手机在外面用流量也能连接：' + r.addresses.map(function (ip) { return '<span class="pd-mono">' + esc(ip) + '</span>'; }).join('、');
    } else if (r.state === 'offline') {
      desc = '已安装 Tailscale，但还没登录或没打开。打开 Tailscale 并登录后，这里会显示 Tailscale 地址。';
      act = '<button class="pd-btn" data-act="remote-check">' + icon('refresh-cw', 16) + '重新检测</button>';
    } else {
      desc = '不在同一个局域网时，电脑和手机都装上 Tailscale（基于 WireGuard 的加密组网，免费）并登录同一个账号即可连接。';
      act = '<button class="pd-btn pd-btn-primary" data-act="remote-download">' + icon('download', 16) + '下载 Tailscale</button>';
    }
    var tag = { ready: '<span class="pd-tag pd-tag-ok">已连通</span>', offline: '<span class="pd-tag">未登录</span>', missing: '<span class="pd-tag">未安装</span>' }[r.state];
    // 电脑开着 Clash 等的 TUN 模式：提示放行 Tailscale，并给出可粘贴的 Clash 扩展脚本
    var tun = (r.proxyTun && r.proxyTun.length) ? '<div class="pd-setting">' + tileHtml('shield', 'var(--pd-tile-amber)') +
      '<div class="pd-setting-text"><div>检测到代理的 TUN 模式 <span class="pd-tag">' + esc(r.proxyTun.join('、')) + '</span></div>' +
      '<div class="pd-setting-desc">可用分流脚本：Claude、Codex 与谷歌走住宅出口，其他走基础节点，手机经 Tailscale 仍能连上。</div></div>' +
      '<button class="pd-btn" data-act="clash-script">' + icon('copy', 16) + 'Clash 分流脚本</button></div>' : '';
    return '<div class="pd-h2">异地连接</div><div class="pd-card"><div class="pd-setting">' + tileHtml('wifi', 'var(--pd-tile-blue)') +
      '<div class="pd-setting-text"><div>Tailscale ' + tag + '</div><div class="pd-setting-desc">' + desc + '</div></div>' + act + '</div>' + tun + '</div>';
  }

  function workspacesView() {
    var rows = host.workspaces.map(function (w) {
      return '<tr><td><div class="pd-name">' + tileHtml('folder', 'var(--pd-tile-blue)') + esc(w.name) + '</div></td><td class="pd-path">' + esc(w.rootPath) + '</td>' +
        '<td><span class="pd-tag' + (w.readOnly ? '' : ' pd-tag-ok') + '">' + (w.readOnly ? '只读' : '读写') + '</span></td>' +
        '<td><div class="pd-actions"><button class="pd-link" data-act="ws-edit" data-id="' + esc(w.id) + '">编辑</button><button class="pd-link pd-link-danger" data-act="ws-del" data-id="' + esc(w.id) + '">删除</button></div></td></tr>';
    }).join('');
    var warns = host.workspaces.filter(function (w) { return w.warning; }).map(function (w) { return '<div class="pd-warn">' + icon('alert-triangle', 16) + '<div>' + esc(w.warning) + '</div></div>'; }).join('');
    return ['<div class="pd-card">' + (rows ? '<table class="pd-table"><tr><th>名称</th><th>路径</th><th style="width:70px">权限</th><th style="width:100px">操作</th></tr>' + rows + '</table>' : '<div class="pd-empty">还没有工作区</div>') + '</div>' + warns,
      '<button class="pd-btn pd-btn-primary" data-act="ws-add">' + icon('plus', 16) + '添加工作区</button>'];
  }

  function devicesView() {
    var rows = host.devices.map(function (d) {
      var status = d.revoked ? '<span class="pd-tag">已吊销</span>' : d.online ? '<span class="pd-tag pd-tag-ok">在线</span>' : '<span class="pd-muted">' + ago(d.lastSeen) + '</span>';
      var act = d.online && !d.revoked ? '<button class="pd-link pd-link-danger" data-act="dev-revoke" data-id="' + esc(d.id) + '" data-name="' + esc(d.name) + '">吊销</button>'
        : '<button class="pd-link pd-link-danger" data-act="dev-remove" data-id="' + esc(d.id) + '" data-name="' + esc(d.name) + '">移除</button>';
      return '<tr><td><div class="pd-name">' + tileHtml('smartphone', d.revoked ? 'var(--pd-tile-ink)' : 'var(--pd-tile-teal)') + esc(d.name) + '</div></td><td class="pd-muted pd-hide-s">' + esc(platformName(d.platform)) + '</td><td>' + status + '</td><td>' + act + '</td></tr>';
    }).join('');
    return ['<div class="pd-card">' + (rows ? '<table class="pd-table"><tr><th>名称</th><th class="pd-hide-s">系统</th><th>状态</th><th style="width:70px">操作</th></tr>' + rows + '</table>' : '<div class="pd-empty">还没有配对的手机</div>') + '</div>' +
      '<div class="pd-muted" style="font-size:12px;margin:10px 2px">移除或吊销后，这台手机需要重新扫码配对才能再连接。</div>',
      (host.devices.some(function (d) { return !d.online || d.revoked; }) ? '<button class="pd-btn" data-act="dev-remove-offline">' + icon('trash', 16) + '移除全部不在线设备</button>' : '') +
      '<button class="pd-btn pd-btn-primary" data-act="pair">' + icon('qr-code', 16) + '配对新手机</button>'];
  }

  function transferView() {
    var c = host.config, n = c.notify || {};
    return ['<div class="pd-h2">收件目录</div><div class="pd-card"><div class="pd-form-grid" style="grid-template-columns:1fr">' +
      '<div class="pd-form-row"><div class="pd-field"><label for="inbox">两端互传的文件存到这里的日期文件夹</label><input class="pd-input pd-mono" id="inbox" value="' + esc(c.transfer.inboxDir) + '"></div>' +
      '<button class="pd-btn" data-act="pick-folder" data-target="inbox" data-prompt="选择收件目录">' + icon('folder-search', 16) + '选择…</button>' +
      '<button class="pd-btn" data-act="open-inbox" title="在访达中打开" aria-label="打开收件目录">' + icon('folder-open', 16) + '</button></div></div>' +
      '<div class="pd-setting">' + tileHtml('pause', 'var(--pd-tile-amber)') + '<div class="pd-setting-text"><div>暂停所有传输</div><div class="pd-setting-desc">暂停期间手机会自动等待，恢复后继续</div></div>' + toggle('pause-all', host.transfersPaused) + '</div></div>' +
      '<div class="pd-h2">后台通知</div><div class="pd-card"><div class="pd-form-grid">' +
      '<div class="pd-field"><label for="nkind">推送方式</label><select class="pd-input" id="nkind"><option value="">不推送</option><option value="ntfy"' + (n.kind === 'ntfy' ? ' selected' : '') + '>ntfy</option><option value="bark"' + (n.kind === 'bark' ? ' selected' : '') + '>Bark</option></select></div>' +
      '<div class="pd-field"><label for="nurl">服务地址</label><input class="pd-input" id="nurl" placeholder="https://ntfy.sh" value="' + esc(n.url) + '"></div>' +
      '<div class="pd-field"><label for="ntopic">主题或设备密钥</label><input class="pd-input" id="ntopic" value="' + esc(n.topic) + '"></div></div>' +
      '<div class="pd-notify-tip"><div class="pd-setting-desc">手机上安装 ntfy 并订阅同一个主题。手机 App 不在线时，待审批和任务完成会推送到 ntfy，点通知直接打开对应聊天；可在聊天右上角关闭某个会话的提醒。</div>' +
      '<div class="pd-actions"><button class="pd-btn" data-act="notify-random">' + icon('refresh-cw', 16) + '生成随机主题</button><button class="pd-btn" data-act="notify-test">' + icon('send', 16) + '发送测试通知</button></div></div></div>' +
      '<div class="pd-savebar"><button class="pd-btn pd-btn-primary" data-act="save-transfer">保存</button></div>', ''];
  }

  function securityView() {
    var f = host.config.features;
    return ['<div class="pd-card">' +
      setting('bot', 'var(--pd-tile-indigo)', 'Agent 会话', '向电脑上的 AI 编程工具发送提示词', 'f-agents', f.agents) +
      setting('terminal', 'var(--pd-tile-ink)', '终端', '手机可在电脑上执行任意命令，每次进入需验证指纹或面容', 'f-terminal', f.terminal) +
      setting('pencil', 'var(--pd-tile-amber)', '文件编辑', '可保存、重命名、移动和删除工作区文件', 'f-fileEdit', f.fileEdit) +
      '<div class="pd-setting">' + tileHtml('clock', 'var(--pd-tile-blue)') + '<div class="pd-setting-text"><div>终端空闲自动结束</div><div class="pd-setting-desc">没有输入也没有连接超过设定小时数后结束</div></div>' +
      '<input class="pd-input" id="idle" type="number" min="1" max="720" style="width:80px" value="' + host.config.terminalIdleHours + '" aria-label="小时"></div></div>' +
      '<div class="pd-h2">操作记录</div><div class="pd-card" id="audit"><div class="pd-empty">正在加载…</div></div>', ''];
  }

  function appearanceView() { return PDX.appearanceHtml(); }

  function aboutView() {
    return ['<div class="pd-card"><dl class="pd-kv"><dt>版本</dt><dd>' + esc(host.host.version) + '</dd><dt>数据目录</dt><dd class="pd-mono" style="font-size:12px">' + esc(host.dataDir) + '</dd></dl></div>' +
      '<div class="pd-savebar" style="justify-content:flex-start"><button class="pd-btn pd-btn-danger" data-act="quit">' + icon('log-out', 16) + '退出服务</button></div>', ''];
  }

  function loadAudit() {
    api('GET', '/admin/api/audit').then(function (list) {
      var el = document.getElementById('audit');
      if (!el) { return; }
      var names = { desktop: '电脑' };
      host.devices.forEach(function (d) { names[d.id] = d.name; });
      if (!list.length) { el.innerHTML = '<div class="pd-empty">暂无记录</div>'; return; }
      el.innerHTML = '<table class="pd-table" style="font-size:12px"><tr><th>时间</th><th>设备</th><th>操作</th><th class="pd-hide-s">详情</th></tr>' + list.slice(0, 100).map(function (a) {
        var detail = JSON.stringify(a.detail) || '';
        if (detail.length > 160) { detail = detail.slice(0, 160) + '…'; }
        return '<tr><td class="pd-nowrap">' + fmtTime(a.createdAt) + '</td><td class="pd-nowrap">' + esc(names[a.deviceId] || '电脑') + '</td><td class="pd-nowrap">' + esc(a.action) + '</td><td class="pd-hide-s pd-path">' + esc(detail) + '</td></tr>';
      }).join('') + '</table>';
    }).catch(function () {});
  }

  /* ---------- 配对 ---------- */
  function pairBody() {
    if (!pairInfo) { return '<div class="pd-pair-body"><div class="pd-pair-title">配对新手机</div><div class="pd-muted">正在生成配对码…</div></div>'; }
    var addr = (pairInfo.addresses || [])[0] || '未检测到局域网地址';
    return '<div class="pd-pair-body"><div class="pd-pair-title">配对新手机</div>' +
      '<div class="pd-qr"><img alt="配对二维码" src="' + esc(pairInfo.qr) + '"></div><div class="pd-muted" id="pair-left">' + countdownText() + '</div>' +
      '<div class="pd-steps"><div class="pd-step"><div class="pd-stepnum">1</div><div>在手机上打开 PocketDesk，点消息页右上角「+ → 扫一扫」</div></div>' +
      '<div class="pd-step"><div class="pd-stepnum">2</div><div>对准上方二维码扫描，或手动输入下方配对码</div></div>' +
      '<div class="pd-step"><div class="pd-stepnum">3</div><div>在电脑上点击「允许」完成配对</div></div></div>' +
      '<div class="pd-codebox"><div><div class="pd-muted" style="font-size:11px">手动配对码</div><div class="pd-code-big">' + esc(pairInfo.code) + '</div></div>' +
      '<div class="pd-muted" style="font-size:11px;text-align:right">' + esc(pairInfo.hostName) + '<br><span class="pd-mono">' + esc(addr) + '</span></div></div>' +
      '<div style="display:flex;gap:8px"><button class="pd-btn" data-act="pair-refresh">换一个配对码</button><button class="pd-btn" data-act="pair-close">关闭</button></div></div>';
  }
  function countdownText() {
    if (!pairInfo) { return ''; }
    var left = Math.max(0, Math.floor((pairInfo.expiresAt - Date.now()) / 1000));
    if (left === 0) { return '配对码已过期，请点「换一个配对码」'; }
    return '配对码 5 分钟内有效，剩余 <span class="pd-countdown">' + pad(Math.floor(left / 60)) + ':' + pad(left % 60) + '</span>';
  }
  /** startPair：生成配对码；主窗口里以弹窗显示，独立配对窗口占满 */
  function startPair() {
    pairInfo = null;
    showPair();
    api('POST', '/admin/api/pair/start').then(function (p) {
      pairInfo = p;
      showPair();
      clearInterval(pairTimer);
      pairTimer = setInterval(function () { var el = document.getElementById('pair-left'); if (el) { el.innerHTML = countdownText(); } }, 1000);
    }).catch(function (e) { toast(e.message); });
  }
  /** showPair：主窗口里以弹窗显示（标题栏可关闭，内容可滚动），独立配对窗口占满 */
  function showPair() {
    if (route().page === 'pair') { render(); return; }
    modalRoot.innerHTML = '<div class="pd-scrim" data-act="pair-close"><div class="pd-dialog pd-pair-dialog" role="dialog" aria-modal="true" aria-label="配对新手机">' +
      '<div class="pd-dialog-head"><div class="pd-dialog-title">配对新手机</div><button class="pd-icon-btn" data-act="pair-close" aria-label="关闭">' + icon('x', 18) + '</button></div>' +
      '<div class="pd-pair-scroll">' + pairBody() + '</div></div></div>';
  }
  function closePair() {
    api('POST', '/admin/api/pair/cancel').catch(function () {});
    clearInterval(pairTimer);
    pairInfo = null;
    if (route().page === 'pair') { location.hash = 'settings/devices'; } else { closeModal(); }
  }

  // Keep the loading surface alive from the initial click. Its DOM identity
  // prevents late requests from reopening a closed or replaced dialog.
  function remoteModal(title, message, loadData, render, tree) {
    modal(title, '<div class="pd-remote-load" aria-busy="true"><div class="pd-skeleton' + (tree ? ' tree' : '') + '">' + Array.from({ length: tree ? 6 : 5 }, function () { return '<div class="pd-skeleton-row"><i></i><i></i></div>'; }).join('') + '</div><div class="pd-remote-notice" role="status"></div></div>', '<button class="pd-btn" data-act="modal-close">关闭</button>');
    var holder = modalRoot.querySelector('.pd-remote-load'), sid = route().sid;
    if (tree) { holder.classList.add('pd-history-loading'); modalRoot.querySelector('.pd-dialog').classList.add('pd-history-dialog'); holder.insertAdjacentHTML('afterbegin', '<div class="pd-history-toolbar"><input class="pd-input" placeholder="搜索请求或回复" disabled><button class="pd-btn" disabled>定位当前</button></div>'); }
    function active() { return holder.isConnected && route().sid === sid; }
    function run() {
      holder.setAttribute('aria-busy', 'true'); holder.classList.remove('failed', 'visible');
      var error = holder.querySelector('.pd-remote-error'); if (error) { error.remove(); }
      var notice = holder.querySelector('.pd-remote-notice'); notice.textContent = '';
      var delay = setTimeout(function () { if (active()) { holder.classList.add('visible'); } }, 150);
      var slow = setTimeout(function () { if (active()) { notice.textContent = message; } }, 3000);
      Promise.resolve().then(loadData).then(function (data) { if (active()) { render(data); var ready = modalRoot.querySelector('.pd-dialog'); if (ready) { ready.style.animation = 'none'; ready.querySelector('.pd-modal-body').classList.add('pd-remote-ready'); } } }).catch(function (e) {
        if (!active()) { return; }
        holder.classList.add('failed');
        var block = document.createElement('div'); block.className = 'pd-remote-error';
        block.innerHTML = '<p>' + esc(e.message || '加载失败，请重试') + '</p><button class="pd-btn">重试</button>';
        block.querySelector('button').onclick = run; holder.appendChild(block);
      }).finally(function () { clearTimeout(delay); clearTimeout(slow); if (holder.isConnected) { holder.setAttribute('aria-busy', 'false'); } });
    }
    run();
  }

  function modalAction(button, request, success, failure) {
    var dialog = button.closest('.pd-dialog');
    if (!dialog || dialog.dataset.busy) { return Promise.resolve(); }
    dialog.dataset.busy = 'true'; dialog.setAttribute('aria-busy', 'true');
    var controls = Array.from(dialog.querySelectorAll('button,input')).map(function (el) { return { el: el, disabled: el.disabled }; });
    controls.forEach(function (c) { c.el.disabled = true; });
    // Disabled controls must not move keyboard focus back into the chat.
    dialog.tabIndex = -1; dialog.focus({ preventScroll: true });
    function holdFocus(event) { if (event.key === 'Tab') { event.preventDefault(); } }
    dialog.addEventListener('keydown', holdFocus);
    var original = button.innerHTML;
    button.innerHTML = (button.classList.contains('pd-pick-row') ? original : '') + '<span class="pd-action-progress"><span class="pd-wait-spinner" aria-hidden="true"></span> 正在切换…</span>';
    var previous = dialog.querySelector('.pd-action-error'); if (previous) { previous.remove(); }
    function release() {
      delete dialog.dataset.busy; dialog.setAttribute('aria-busy', 'false');
      controls.forEach(function (c) { c.el.disabled = c.disabled; }); button.innerHTML = original;
      dialog.removeEventListener('keydown', holdFocus);
      if (dialog.isConnected) { button.focus({ preventScroll: true }); }
    }
    return Promise.resolve().then(request).then(function (result) { return success ? success(result) : result; }).then(function (result) {
      release(); if (dialog.isConnected) { closeModal(); }
      return result;
    }).catch(function (e) {
      release(); if (!dialog.isConnected) { return; }
      var error = document.createElement('p'); error.className = 'pd-action-error'; error.setAttribute('role', 'alert'); error.textContent = e.message || '操作失败，请重试';
      dialog.querySelector('.pd-modal-body').appendChild(error);
      if (failure) { failure(e, button); }
    });
  }

  /* ---------- 弹窗 ---------- */
  function modal(t, body, foot) {
    modalRoot.innerHTML = '<div class="pd-scrim"><div class="pd-dialog" role="dialog" aria-modal="true" aria-label="' + esc(t) + '">' +
      '<div class="pd-dialog-head"><div class="pd-dialog-title">' + esc(t) + '</div><button class="pd-icon-btn" data-act="modal-close" aria-label="关闭">' + icon('x', 18) + '</button></div>' +
      '<div class="pd-modal-body">' + body + '</div><div class="pd-dialog-foot">' + foot + '</div></div></div>';
    var first = modalRoot.querySelector('input,button.pd-btn-primary');
    if (first) { first.focus(); }
  }
  function closeModal() { if (modalRoot.querySelector('.pd-dialog[data-busy]')) { return; } modalRoot.innerHTML = ''; }
  function confirmBox(t, text, okLabel, onOk) {
    modal(t, '<div>' + text + '</div>', '<button class="pd-btn" data-act="modal-close">取消</button><button class="pd-btn pd-btn-danger" id="confirm-ok">' + okLabel + '</button>');
    document.getElementById('confirm-ok').onclick = function () { closeModal(); onOk(); };
  }
  function imagePreview(t, src, actions, seq) { PDX.viewer(t, src, actions, seq); }
  function workspaceForm(w) {
    w = w || { id: '', name: '', rootPath: '', readOnly: false };
    modal(w.id ? '编辑工作区' : '添加工作区',
      '<div class="pd-field"><label for="wname">名称</label><input class="pd-input" id="wname" value="' + esc(w.name) + '"></div>' +
      '<div class="pd-form-row"><div class="pd-field"><label for="wpath">文件夹路径</label><input class="pd-input pd-mono" id="wpath" value="' + esc(w.rootPath) + '" placeholder="点右侧按钮选择文件夹"></div>' +
      '<button class="pd-btn" data-act="pick-folder" data-target="wpath" data-name="wname" data-prompt="选择工作区文件夹">' + icon('folder-open', 16) + '选择…</button></div>' +
      '<label class="pd-check-line"><input type="checkbox" id="wro"' + (w.readOnly ? ' checked' : '') + '>只读（手机上不能修改）</label>',
      '<button class="pd-btn" data-act="modal-close">取消</button><button class="pd-btn pd-btn-primary" data-act="ws-save" data-id="' + esc(w.id) + '">保存</button>');
  }

  /** newSession：新建会话对话框（选择工作目录，可选电脑上任意文件夹） */
  function newSession(kind, auto) { PDX.newSession({ kind: kind, auto: auto }); }

  /* ---------- 电脑端状态与配对请求 ---------- */
  function loadHost() {
    return api('GET', '/admin/api/state').then(function (s) {
      var first = !host;
      host = s;
      checkRequests();
      var r = route();
      var sig = JSON.stringify((s.workspaces || []).map(function (w) { return [w.id, w.name, w.rootPath]; }));
      // 首次读到状态时绘制设置页；之后只刷新纯展示的分区，避免冲掉正在编辑的输入
      if (r.page === 'settings' && !modalRoot.innerHTML && (first || r.section === 'overview' || r.section === 'devices')) { renderMain(); }
      if (r.page === 'chat') { renderHead(); if (first || sig !== wsSig) { renderMsgs(false, true); } }
      // 文件页左侧的工作区列表有变化时刷新
      if (r.page === 'phone' && sig !== wsSig) { wsSig = sig; renderList(); } else { wsSig = sig; }
      if (!document.getElementById('rail') && r.page !== 'pair') { render(); }
    }).catch(function () {});
  }

  /** checkRequests：有手机请求配对时弹窗确认 */
  function checkRequests() {
    (host.pending || []).forEach(function (req) {
      if (shownRequests[req.id]) { return; }
      shownRequests[req.id] = true;
      modal('配对请求', '<div style="display:flex;gap:12px;align-items:center">' + avatarHtml('phone') +
        '<div>是否允许「' + esc(req.name) + '」配对？<div class="pd-muted" style="font-size:12px">允许后这台手机可以访问已授权的工作区并控制 AI 编程工具</div></div></div>',
        '<button class="pd-btn" data-act="req" data-id="' + esc(req.id) + '" data-allow="0">拒绝</button><button class="pd-btn pd-btn-primary" data-act="req" data-id="' + esc(req.id) + '" data-allow="1">允许</button>');
    });
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', function (e) {
    var mi = e.target.closest('[data-menu]');
    if (mi) {
      var r0 = menuResolve;
      menuResolve = null;
      closeMenu();
      if (r0) { r0(mi.dataset.menu); }
      return;
    }
    if (e.target.closest('.pd-subbtn')) { return; }
    closeMenu();
    var t = e.target.closest('[data-go],[data-act]');
    if (!t) { return; }
    if (t.dataset.go) {
      location.hash = t.dataset.go;
      return;
    }
    var act = t.dataset.act, id = t.dataset.id, sid = route().sid;
    switch (act) {
      case 'modal-close':
        if (t.classList.contains('pd-scrim') && e.target !== t) { return; }
        closeModal();
        break;
      case 'sel-start': selMode = true; selected = {}; renderList(); break;
      case 'sel-cancel': selMode = false; selected = {}; renderList(); break;
      case 'sel-toggle':
        if (selected[id]) { delete selected[id]; } else { selected[id] = true; }
        renderList();
        break;
      case 'sel-all':
        var vis = visibleSessions();
        selected = Object.keys(selected).length === vis.length ? {} : vis.reduce(function (m, x) { m[x.id] = true; return m; }, {});
        renderList();
        break;
      case 'sel-delete':
        var ids = Object.keys(selected);
        if (!ids.length) { break; }
        confirmBox('删除 ' + ids.length + ' 个聊天', '只删除电脑上的这些聊天，手机上的会话保留。', '删除', function () {
          ids.forEach(hideSession);
          selMode = false;
          selected = {};
          if (ids.indexOf(route().sid) >= 0) { location.hash = 'chat'; }
          renderList();
          renderRail();
          toast('已删除');
        });
        break;
      case 'pair': startPair(); break;
      case 'pair-refresh': startPair(); break;
      case 'pair-close':
        if (t.classList.contains('pd-scrim') && e.target !== t) { return; }
        closePair();
        break;
      case 'req':
        api('POST', '/admin/api/pair/' + encodeURIComponent(id), { allow: t.dataset.allow === '1' }).then(function () {
          closeModal();
          toast(t.dataset.allow === '1' ? '已允许配对' : '已拒绝');
          if (t.dataset.allow === '1' && pairInfo) { clearInterval(pairTimer); pairInfo = null; }
          setTimeout(loadHost, 600);
        }).catch(function (er) { closeModal(); toast(er.message); });
        break;
      // 聊天
      case 'send': send(); break;
      case 'attach': document.getElementById('file-any').click(); break;
      case 'attach-image': document.getElementById('file-img').click(); break;
      case 'unpend': pending.splice(+t.dataset.i, 1); renderPending(); break;
      case 'interrupt':
        api('POST', P + '/api/sessions/' + encodeURIComponent(sid) + '/interrupt').then(function () { toast('已打断'); }).catch(function (er) { toast(er.message); });
        break;
      case 'retry':
        api('POST', P + '/api/sessions/' + encodeURIComponent(sid) + '/retry').catch(function (er) { toast(er.message); });
        break;
      case 'decide':
        api('POST', P + '/api/approvals/' + encodeURIComponent(id), { action: t.dataset.action }).catch(function (er) { toast(er.message); });
        break;
      case 'save-img':
        saveImage(t);
        break;
      case 'mm-zoom':
        mermaidStep(t.closest('.pd-code'), t.dataset.d);
        break;
      case 'copy-code':
        copyText(t.closest('.pd-code').querySelector('code').textContent);
        break;
      case 'preview':
        imagePreview(t.dataset.name, '/admin/api/assistant/file?seq=' + t.dataset.seq,
          '<button class="pd-btn" data-act="file-open" data-seq="' + t.dataset.seq + '">' + icon('external-link', 16) + '打开</button>' +
          '<button class="pd-btn" data-act="file-reveal" data-seq="' + t.dataset.seq + '">' + icon('folder-open', 16) + '显示</button>', t.dataset.seq);
        break;
      case 'file-open':
      case 'file-reveal':
        api('POST', '/admin/api/assistant/open', { seq: +t.dataset.seq, reveal: act === 'file-reveal' }).catch(function (er) { toast(er.message); });
        break;
      case 'cmd': pickCmd(t.dataset.cmd); break;
      case 'head-model':
        var rm = t.getBoundingClientRect(), sm = session(sid);
        var mopts = [['model', '切换模型', false, 'cpu']];
        if (sm && sm.kind === 'pi') { mopts.push(['effort', '思考强度', false, 'cpu']); }
        if (sm && (sm.kind === 'claude' || sm.kind === 'codex')) { mopts.push(['provider', '模型供应商', false, 'server']); }
        popMenu(rm.right - 170, rm.bottom + 4, mopts).then(function (k) {
          if (k === 'model') { chooseModel(sm); } else if (k === 'provider') { chooseProvider(sm); } else if (k === 'effort') { chooseEffort(sm); }
        });
        break;
      case 'head-skills': skillsModal(session(sid)); break;
      case 'head-mute':
        var su = session(sid);
        if (su) { patchSession(su, { muted: !su.muted }, su.muted ? '已打开提醒' : '已关闭提醒').catch(function (e) { toast(e.message); }); }
        break;
      case 'effort-pick':
        setEffort(session(t.dataset.sid), t.dataset.level);
        break;
      case 'model-pick':
        modalAction(t, function () { return patchSession(session(t.dataset.sid || sid), { model: t.dataset.model }, null); }, function () { toast(t.dataset.model ? '已切换到 ' + t.dataset.model : '已恢复默认模型'); });
        break;
      case 'model-custom':
        var mc = document.getElementById('model-custom').value.trim();
        if (!mc) { toast('请填写模型名称'); break; }
        modalAction(t, function () { return patchSession(session(t.dataset.sid || sid), { model: mc }, null); }, function () { toast('已切换到 ' + mc); });
        break;
      case 'provider-pick':
        var pv = t.querySelector('div');
        if (id) { providerNames[id] = pv ? pv.firstChild.textContent.trim() : ''; }
        modalAction(t, function () { return patchSession(session(t.dataset.sid || sid), { provider: id || '' }, null); }, function () { toast(id ? '已切换供应商' : '已改为跟随电脑当前设置'); });
        break;
      case 'skill-view':
        var sv = session(sid), kv = skillList.filter(function (x) { return x.path === t.dataset.path; })[0];
        if (!sv || !kv) { break; }
        api('GET', P + '/api/agents/' + sv.kind + '/skill?session=' + encodeURIComponent(sv.id) + '&path=' + encodeURIComponent(kv.path)).then(function (r) {
          modal(kv.name, '<div class="pd-path" style="margin-bottom:8px">' + esc(kv.path) + '</div><div class="pd-md pd-skill-md">' + md(String(r.text || '').replace(/^---\n[\s\S]*?\n---\n/, '')) + '</div>',
            '<button class="pd-btn" data-act="skills-back">返回</button>');
        }).catch(function (er) { toast(er.message); });
        break;
      case 'skills-back': renderSkills(session(sid)); break;
      case 'unskill':
        (chosenSkills[sid] || []).splice(+t.dataset.i, 1);
        renderChosen();
        break;
      case 'external-pick': importExternal(externalList[+t.dataset.i]); break;
      case 'diff-ref':
        var changes = changeGroups[t.dataset.changeSeq];
        if (changes) { openChanges(sid, changes.files, +t.dataset.fileIndex || 0, '所选轮次的已保存差异' + (changes.at ? ' · ' + chatTime(changes.at) : '') + ' · 非当前文件'); }
        break;
      case 'notify-random':
        var nt = document.getElementById('ntopic'), nk = document.getElementById('nkind');
        if (nk && !nk.value) { nk.value = 'ntfy'; }
        if (nt) { nt.value = 'pocketdesk-' + Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(9)), function (b) { return (b % 36).toString(36); }).join(''); }
        break;
      case 'notify-test':
        api('POST', '/admin/api/notify/test', { kind: document.getElementById('nkind').value, url: document.getElementById('nurl').value.trim(), topic: document.getElementById('ntopic').value.trim() })
          .then(function () { toast('已发出，请看手机是否收到'); }).catch(function (er) { toast(er.message); });
        break;
      case 'files-sidebar': PDToolView.dismiss(); PDChanges.toggle(sidebarOptions(sid)); break;
      case 'history-open': openHistory(session(sid)); break;
      case 'chat-more':
        var rect = t.getBoundingClientRect(), s = session(sid);
        var more = [['copy-all', '复制全部对话', false, 'copy'], ['pin', s && s.pinned ? '取消置顶' : '置顶聊天', false, 'pin']];
        if (s && isAgent(s)) { more.push(['mute', s.muted ? '打开提醒' : '关闭提醒', false, s.muted ? 'bell' : 'bell-off']); }
        more.push('-', ['delete', '删除聊天', true, 'trash']);
        popMenu(rect.right - 170, rect.bottom + 4, more).then(function (k) { chatMenu(k, sid); });
        break;
      case 'new':
        var rc = t.getBoundingClientRect();
        PDX.newMenu(rc.left, rc.bottom + 4).then(function (k) {
          if (k === 'pair') { startPair(); } else if (k === 'assistant') { openAssistant(); } else if (k === 'resume') { externalModal(); }
        });
        break;
      case 'agent':
        var kind = t.dataset.kind, ra = t.getBoundingClientRect();
        var recent = sessions.filter(function (s) { return s.kind === kind && !hiddenSess[s.id]; }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).slice(0, 5);
        var opts = recent.map(function (s) { return ['open:' + s.id, title(s), false, 'message-circle']; });
        if (opts.length) { opts.push('-'); }
        opts.push(['new', '新建 ' + AGENT[kind] + ' 会话', false, 'plus']);
        if (kind === 'claude' || kind === 'codex' || kind === 'pi') { opts.push(['auto', AGENT[kind] + ' 免审批', false, 'shield-alert']); }
        popMenu(ra.left, ra.bottom + 4, opts).then(function (k) {
          if (!k) { return; }
          if (k.indexOf('open:') === 0) { unhideSession(k.slice(5)); location.hash = 'chat/' + encodeURIComponent(k.slice(5)); return; }
          newSession(kind, k === 'auto');
        });
        break;
      case 'remote-download':
        api('POST', '/admin/api/remote/download').then(function () { toast('已在浏览器打开 Tailscale 官方下载页'); }).catch(function (er) { toast(er.message); });
        break;
      case 'clash-script':
        api('GET', '/admin/api/remote/clash-script').then(function (r) {
          modal('Clash 分流脚本', '<div class="pd-muted" style="font-size:12px;margin-bottom:8px">1、只改脚本开头的「填写区」，填上住宅代理<br>2、Clash Verge：订阅页 →「全局扩展脚本」→ 整份粘贴 → 保存<br>3、订阅自己的「扩展脚本」保持为空，否则会覆盖这里的设置</div>' +
            '<textarea id="clash-text" class="pd-input pd-mono" readonly style="width:100%;height:280px;font-size:12px">' + esc(r.script) + '</textarea>',
            '<button class="pd-btn" data-act="modal-close">关闭</button><button class="pd-btn pd-btn-primary" data-act="clash-copy">复制</button>');
        }).catch(function (er) { toast(er.message); });
        break;
      case 'clash-copy':
        var ta = document.getElementById('clash-text');
        if (ta) { copyText(ta.value); }
        break;
      case 'remote-check':
        loadHost().then(function () { renderMain(); toast(host.remote && host.remote.state === 'ready' ? '已连通' : '还没有检测到 Tailscale 地址'); });
        break;
      case 'ws-pick':
        Array.prototype.forEach.call(modalRoot.querySelectorAll('[data-act="ws-pick"]'), function (b) { b.classList.toggle('active', b === t); });
        break;
      case 'create':
        var pick = modalRoot.querySelector('[data-act="ws-pick"].active');
        api('POST', P + '/api/sessions', { kind: t.dataset.kind, workspaceId: pick.dataset.id, cwd: '.', autoApprove: t.dataset.auto === '1' }).then(function (s2) {
          closeModal();
          sessions.push(s2);
          location.hash = 'chat/' + encodeURIComponent(s2.id);
        }).catch(function (er) { toast(er.message); });
        break;
      // 文件
      case 'fs-pick':
        ph.kind = t.dataset.kind; ph.ws = t.dataset.kind === 'ws' ? id : ''; ph.dev = t.dataset.kind === 'phone' ? id : ''; ph.path = ''; ph.entries = []; ph.error = '';
        fsLoad();
        break;
      case 'fs-refresh': fsLoad(); break;
      case 'phone-kick':
        var cur = (ph.phones || []).filter(function (p) { return p.id === ph.dev; })[0];
        if (cur) { kickPhone(cur.id, cur.name); }
        break;
      case 'fs-cd': ph.path = t.dataset.path; fsLoad(); break;
      case 'fs-open':
        if (t.dataset.dir === '1') { ph.path = t.dataset.path; fsLoad(); } else { fsOpen(t.dataset.path); }
        break;
      case 'fs-upload': document.getElementById('fs-file').click(); break;
      case 'fs-reveal':
        api('POST', '/admin/api/open', { which: 'wsfile', id: ph.ws, path: t.dataset.path, reveal: true }).catch(function (er) { toast(er.message); });
        break;
      case 'phone-fetch':
        toast('正在从手机取文件…');
        api('POST', '/admin/api/phone/' + encodeURIComponent(ph.dev) + '/fetch', { path: t.dataset.path }, 300000).then(function (r) { toast('已存到 ' + r.path); }).catch(function (er) { toast(er.message); });
        break;
      case 'fs-mkdir':
        modal('新建文件夹', '<div class="pd-field"><label for="mkname">名称</label><input class="pd-input" id="mkname"></div>',
          '<button class="pd-btn" data-act="modal-close">取消</button><button class="pd-btn pd-btn-primary" data-act="fs-mkdir-ok">新建</button>');
        break;
      case 'fs-mkdir-ok':
        fsOp('mkdir', '', document.getElementById('mkname').value.trim()).then(function () { closeModal(); fsLoad(); }).catch(function (er) { toast(er.message); });
        break;
      case 'fs-rename':
        modal('重命名', '<div class="pd-field"><label for="rnname">新名称</label><input class="pd-input" id="rnname" value="' + esc(t.dataset.name) + '"></div>',
          '<button class="pd-btn" data-act="modal-close">取消</button><button class="pd-btn pd-btn-primary" data-act="fs-rename-ok" data-path="' + esc(t.dataset.path) + '">确定</button>');
        break;
      case 'fs-rename-ok':
        fsOp('rename', t.dataset.path, document.getElementById('rnname').value.trim()).then(function () { closeModal(); fsLoad(); }).catch(function (er) { toast(er.message); });
        break;
      case 'fs-delete':
        confirmBox('删除', isWsSrc() ? '确定删除「' + esc(t.dataset.name) + '」？文件会移到电脑的回收站。' : '确定从手机上删除「' + esc(t.dataset.name) + '」？删除后无法恢复。', '删除', function () {
          fsOp('delete', t.dataset.path).then(function () { toast('已删除'); fsLoad(); }).catch(function (er) { toast(er.message); });
        });
        break;
      case 'fs-save': fsSave(t.dataset.path); break;
      case 'fs-root':
        if (isWsSrc()) { workspaceForm(wsById(ph.ws)); } else { phoneRootPicker(''); }
        break;
      case 'phone-browse': phoneRootPicker(t.dataset.path); break;
      case 'phone-setroot':
        phoneCall('setRoot', { path: t.dataset.path }).then(function () { closeModal(); toast('已更换手机工作空间'); ph.path = ''; fsLoad(); }).catch(function (er) { toast(er.message); });
        break;
      // 发送文件确认
      case 'send-files-ok':
        closeModal();
        toast('正在发送 ' + sendQueue.length + ' 个文件…');
        uploadForm('/admin/api/assistant/files', sendQueue).catch(function (e) { toast(e.message); });
        sendQueue = [];
        break;
      // 设置
      case 'theme': save('pd.theme', t.dataset.theme); applyTheme(); renderMain(); break;
      case 'pick-folder':
        api('POST', '/admin/api/pick-folder', { prompt: t.dataset.prompt }, 300000).then(function (r) {
          if (!r.path) { return; }
          var input = document.getElementById(t.dataset.target);
          if (input) { input.value = r.path; }
          var name = t.dataset.name && document.getElementById(t.dataset.name);
          if (name && !name.value.trim()) { name.value = r.name; }
        }).catch(function (er) { toast(er.message); });
        break;
      case 'open-inbox': api('POST', '/admin/api/open', { which: 'inbox' }).catch(function (er) { toast(er.message); }); break;
      case 'save-transfer':
        api('PATCH', '/admin/api/config', {
          inboxDir: document.getElementById('inbox').value.trim(),
          notify: { kind: document.getElementById('nkind').value, url: document.getElementById('nurl').value.trim(), topic: document.getElementById('ntopic').value.trim() }
        }).then(function () { toast('已保存'); loadHost(); }).catch(function (er) { toast(er.message); });
        break;
      case 'quit':
        confirmBox('退出服务', '退出后手机将无法连接这台电脑，直到服务再次启动。', '退出', function () {
          api('POST', '/admin/api/quit').then(function () { app.innerHTML = '<div class="pd-center"><div class="pd-muted">服务已退出，可以关闭此窗口</div></div>'; });
        });
        break;
      case 'ws-add': workspaceForm(); break;
      case 'ws-edit': workspaceForm(host.workspaces.filter(function (w) { return w.id === id; })[0]); break;
      case 'ws-save':
        api('POST', '/admin/api/workspaces', { id: id, name: document.getElementById('wname').value, rootPath: document.getElementById('wpath').value, readOnly: document.getElementById('wro').checked })
          .then(function () { closeModal(); toast('已保存'); loadHost().then(function () { renderMain(); if (route().page === 'phone') { fsLoad(); } }); }).catch(function (er) { toast(er.message); });
        break;
      case 'ws-del':
        confirmBox('删除工作区', '只移除这个工作区的配置，电脑上的文件不会被删除。', '删除', function () {
          api('DELETE', '/admin/api/workspaces/' + encodeURIComponent(id)).then(function () { toast('已删除'); loadHost().then(renderMain); }).catch(function (er) { toast(er.message); });
        });
        break;
      case 'dev-revoke':
        confirmBox('吊销设备', '吊销后「' + esc(t.dataset.name) + '」将立即断开，需要重新扫码配对。', '吊销', function () {
          api('DELETE', '/admin/api/devices/' + encodeURIComponent(id)).then(function () { toast('已吊销'); loadHost().then(renderMain); }).catch(function (er) { toast(er.message); });
        });
        break;
      case 'dev-remove':
        confirmBox('移除设备', '移除「' + esc(t.dataset.name) + '」后，它需要重新扫码配对才能再连接。', '移除', function () {
          api('POST', '/admin/api/devices/' + encodeURIComponent(id) + '/remove').then(function () { toast('已移除'); loadHost().then(renderMain); }).catch(function (er) { toast(er.message); });
        });
        break;
      case 'dev-remove-offline':
        var off = host.devices.filter(function (d) { return !d.online || d.revoked; });
        confirmBox('移除全部不在线设备', '将移除 ' + off.length + ' 台不在线的设备，它们需要重新扫码配对才能再连接。', '移除', function () {
          Promise.all(off.map(function (d) { return api('POST', '/admin/api/devices/' + encodeURIComponent(d.id) + '/remove').catch(function () {}); }))
            .then(function () { toast('已移除'); loadHost().then(renderMain); });
        });
        break;
      default:
        PDX.act(act, t, e);
        break;
    }
  });

  /** kickPhone：移除一台手机——先断开并吊销，再从列表删除，需要重新扫码配对才能再连接 */
  function kickPhone(id, name) {
    confirmBox('移除手机', '移除「' + esc(name) + '」后它会立即断开，需要重新扫码配对才能再连接。', '移除', function () {
      api('DELETE', '/admin/api/devices/' + encodeURIComponent(id))
        .then(function () { return api('POST', '/admin/api/devices/' + encodeURIComponent(id) + '/remove'); })
        .then(function () { toast('已移除'); if (ph.dev === id) { ph.dev = ''; ph.kind = ''; } fsLoad(); loadHost(); })
        .catch(function (er) { toast(er.message); });
    });
  }

  /** deleteSession：只删除电脑端的这条聊天，手机端的会话保留 */
  function deleteSession(id) {
    var s = session(id);
    confirmBox('删除该聊天', '只删除电脑上的这条聊天，手机上的会话保留。' + (s && s.kind === 'assistant' ? '之后可在「+」里重新打开文件传输助手。' : ''), '删除', function () {
      hideSession(id);
      if (route().sid === id) { location.hash = 'chat'; }
      renderList();
      renderRail();
    });
  }

  /** openAssistant：打开文件传输助手；删除过的重新显示 */
  function openAssistant() {
    var a = sessions.filter(function (x) { return x.kind === 'assistant'; })[0];
    if (!a) { toast('暂时无法打开，请稍后再试'); return; }
    unhideSession(a.id);
    location.hash = 'chat/' + encodeURIComponent(a.id);
    renderList();
    renderRail();
  }

  /** itemOf：会话里的一条消息 */
  function itemOf(sid, seq) {
    var lg = logs[sid];
    return lg && buildItems(lg.events).filter(function (x) { return x.seq === seq; })[0];
  }

  /** copyFileMsg：把记录里的图片或文件复制到系统剪贴板 */
  function copyFileMsg(seq) {
    api('POST', '/admin/api/assistant/copy', { seq: seq }).then(function () { toast('已复制'); }).catch(function (er) { toast(er.message); });
  }

  /** chatMenu：聊天窗口右上角菜单 */
  function chatMenu(k, sid) {
    var s = session(sid);
    if (k === 'copy-all') { copyText(chatText(sid)); }
    if (k === 'delete') { deleteSession(sid); }
    if (k === 'mute' && s) { patchSession(s, { muted: !s.muted }, s.muted ? '已打开提醒' : '已关闭提醒').catch(function (e) { toast(e.message); }); }
    if (k === 'pin' && s) {
      api('PATCH', P + '/api/sessions/' + encodeURIComponent(sid), { pinned: !s.pinned }).then(function (s2) { s.pinned = s2.pinned; renderList(); }).catch(function (er) { toast(er.message); });
    }
  }

  // 右键：消息可复制、删除、复制全部；会话可置顶、标为已读或未读
  document.addEventListener('contextmenu', function (e) {
    var msg = e.target.closest('.pd-msg,.pd-sys');
    var row = e.target.closest('.pd-row[data-sid]');
    var phone = e.target.closest('.pd-row[data-phone]');
    var fsr = e.target.closest('.pd-fsrow');
    var pv = e.target.closest('.pd-viewer img[data-seq]');
    if (pv) {
      e.preventDefault();
      popMenu(e.clientX, e.clientY, [['copy-file', '复制图片', false, 'copy']]).then(function (k) { if (k) { copyFileMsg(+pv.dataset.seq); } });
      return;
    }
    if (fsr) {
      e.preventDefault();
      var fsItems = [];
      if (isWsSrc()) { fsItems.push(['fs-reveal', '在访达中显示', false, 'folder-open']); }
      else if (fsr.dataset.dir !== '1') { fsItems.push(['phone-fetch', '存到电脑', false, 'download']); }
      if (route().page === 'phone' && canEditFs()) { fsItems.push(['fs-rename', '重命名', false, 'pencil'], ['fs-delete', '删除', true, 'trash']); }
      if (fsItems.length) {
        popMenu(e.clientX, e.clientY, fsItems).then(function (k) {
          if (!k) { return; }
          var b = document.createElement('button');
          b.hidden = true; b.dataset.act = k; b.dataset.path = fsr.dataset.path; b.dataset.name = fsr.dataset.name;
          document.body.appendChild(b); b.click(); b.remove();
        });
      }
      return;
    }
    if (phone) {
      e.preventDefault();
      popMenu(e.clientX, e.clientY, [['kick', '移除这台手机', true, 'trash']]).then(function (k) { if (k === 'kick') { kickPhone(phone.dataset.phone, phone.dataset.name); } });
      return;
    }
    // 输入框保留系统菜单（粘贴等），其他地方不显示网页引擎自带的「返回、重新载入」
    if (!msg && !row) {
      if (!e.target.closest('input,textarea,[contenteditable],.pd-tool-detail-scroll')) { e.preventDefault(); }
      return;
    }
    e.preventDefault();
    if (msg) {
      var toolEntry = e.target.closest('.pd-tool-entry');
      if (msg.classList.contains('pd-tool-msg') && !toolEntry) { return; }
      var sid = route().sid, seq = +(toolEntry ? toolEntry.querySelector('.pd-tool-row').dataset.toolSeq : msg.dataset.seq);
      var sel = String(window.getSelection() || '');
      var items = [];
      if (sel) { items.push(['copy-sel', '复制选中的文字', false, 'copy']); }
      var mi0 = itemOf(sid, seq);
      var isFile = !!mi0 && mi0.t === 'file';
      if (session(sid) && session(sid).kind === 'pi' && mi0 && (mi0.t === 'user' || mi0.t === 'agent')) { items.push(['history', mi0.t === 'user' ? '修改并重试' : '从这里继续', false, 'history']); }
      items.push(isFile ? ['copy-file', isImage(mi0.name) ? '复制图片' : '复制文件', false, 'copy'] : ['copy', '复制', false, 'copy']);
      if (!isFile) { items.push(['fav', '收藏', false, 'star']); }
      items.push(['copy-all', '复制全部对话', false, 'copy'], '-', ['delete', '删除', true, 'trash']);
      popMenu(e.clientX, e.clientY, items).then(function (k) {
        if (k === 'history') { openHistory(session(sid), mi0.entryId); }
        if (k === 'copy-sel') { copyText(sel); }
        if (k === 'copy-file') { copyFileMsg(seq); }
        if (k === 'copy') { copyText(itemText(sid, seq)); }
        if (k === 'fav') { PDX.favoriteText(itemText(sid, seq), session(sid) ? title(session(sid)) : ''); }
        if (k === 'copy-all') { copyText(chatText(sid)); }
        if (k === 'delete') {
          (hidden[sid] = hidden[sid] || []).push(seq);
          save('pd.hidden', hidden);
          renderMsgs(false);
        }
      });
      return;
    }
    var s = session(row.dataset.sid);
    popMenu(e.clientX, e.clientY, [['pin', s.pinned ? '取消置顶' : '置顶', false, 'pin'], [unread[s.id] ? 'read' : 'unread', unread[s.id] ? '标为已读' : '标为未读', false, 'message-circle'], '-', ['multi', '批量清理', false, 'list-checks'], ['delete', '删除', true, 'trash']]).then(function (k) {
      if (k === 'multi') { selMode = true; selected = {}; selected[s.id] = true; renderList(); }
      if (k === 'delete') { deleteSession(s.id); }
      if (k === 'pin') { chatMenu('pin', s.id); }
      if (k === 'read') { setUnread(s.id, 0); renderList(); renderRail(); }
      if (k === 'unread') { setUnread(s.id, 1); renderList(); renderRail(); }
    });
  });

  var composing = false, composeEnd = 0;
  document.addEventListener('compositionstart', function () { composing = true; });
  document.addEventListener('compositionend', function () { composing = false; composeEnd = Date.now(); });
  document.addEventListener('keydown', function (e) {
    var ime = e.isComposing || e.keyCode === 229 || composing || Date.now() - composeEnd < 100;
    if (e.key === 'Escape') { closeMenu(); if (modalRoot.innerHTML) { if (pairInfo && route().page !== 'pair') { closePair(); } else { closeModal(); } } }
    var cmds = document.getElementById('cmds');
    if (e.target.id === 'input' && cmds && !cmds.hidden && !ime) {
      var n = cmds.children.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cmdIndex = (cmdIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderCmds(); return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickCmd(cmds.children[cmdIndex].dataset.cmd); return; }
      if (e.key === 'Escape') { cmds.hidden = true; return; }
    }
    if (e.target.id === 'input' && e.key === 'Enter' && !e.shiftKey && !ime) {
      e.preventDefault();
      send();
    }
  });
  document.addEventListener('wheel', function (e) {
    var box = e.target.closest && e.target.closest('.pd-mermaid-box');
    if (!box || !(e.ctrlKey || e.metaKey) || !box.querySelector('.pd-mermaid[data-code]:not(.pd-mermaid-todo)')) { return; }
    e.preventDefault();
    mermaidStep(box, e.deltaY < 0 ? 'in' : 'out');
  }, { passive: false });
  document.addEventListener('input', function (e) {
    if (PDX.onInput(e.target)) { return; }
    if (e.target.id === 'input') { var draftSid = route().sid; if (e.target.value && !Object.prototype.hasOwnProperty.call(draftBranches, draftSid)) { draftBranches[draftSid] = historyBranch(draftSid) || ''; save('pd.draftBranches', draftBranches); } syncSend(); saveDraft(route().sid, e.target.value); cmdIndex = 0; renderCmds(); }
    if (e.target.id === 'search') { query = e.target.value; renderList(); }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (PDX.onChange(t)) { return; }
    if (t.id === 'file-any' || t.id === 'file-img' || t.id === 'fs-file') {
      var files = Array.prototype.slice.call(t.files || []);
      t.value = '';
      if (t.id === 'fs-file') { fsUpload(files); } else { sendFiles(files); }
      return;
    }
    if (t.classList.contains('pd-skill-pick')) {
      var ss = session(route().sid), k = skillList.filter(function (x) { return x.path === t.dataset.path; })[0];
      if (!ss || !k) { return; }
      var cur = (chosenSkills[ss.id] || []).filter(function (x) { return x.path !== k.path; });
      if (t.checked) {
        if (cur.length >= 8) { t.checked = false; toast('一次最多选 8 个'); return; }
        cur.push({ name: k.name, path: k.path });
      }
      chosenSkills[ss.id] = cur;
      renderChosen();
      return;
    }
    if (t.classList.contains('pd-skill-toggle')) {
      var s3 = session(route().sid), k3 = skillList.filter(function (x) { return x.path === t.dataset.path; })[0];
      if (!s3 || !k3) { return; }
      t.disabled = true;
      api('PUT', P + '/api/agents/' + s3.kind + '/skills?session=' + encodeURIComponent(s3.id), { path: k3.path, enabled: t.checked }).then(function () {
        k3.enabled = t.checked;
        if (!k3.enabled) { chosenSkills[s3.id] = (chosenSkills[s3.id] || []).filter(function (x) { return x.path !== k3.path; }); renderChosen(); }
        renderSkills(s3);
        toast(k3.enabled ? '已启用，新开始的一轮生效' : '已停用');
      }).catch(function (er) { t.checked = !t.checked; t.disabled = false; toast(er.message); });
      return;
    }
    if (t.id === 'pause-all') { api('POST', '/admin/api/transfers/pause', { paused: t.checked }).then(loadHost); }
    else if (/^f-/.test(t.id)) {
      var f = Object.assign({}, host.config.features);
      f[t.id.slice(2)] = t.checked;
      api('PATCH', '/admin/api/config', { features: f }).then(function () { toast('已更新'); loadHost(); }).catch(function (er) { toast(er.message); });
    } else if (t.id === 'idle') {
      var v = parseInt(t.value, 10);
      if (v > 0) { api('PATCH', '/admin/api/config', { terminalIdleHours: v }).then(function () { toast('已更新'); }); }
    }
  });

  // 粘贴与拖入：聊天中发送（Agent 会话作为附件），手机文件中上传到当前目录
  function dropTarget() {
    var r = route();
    if (modalRoot.innerHTML) { return ''; }
    if (r.page === 'chat' && session(r.sid) && session(r.sid).kind !== 'terminal') { return 'chat'; }
    if (r.page === 'phone' && fsReady() && !ph.readOnly) { return 'files'; }
    if (PDX.dropTarget(r)) { return 'clip'; }
    return '';
  }
  document.addEventListener('paste', function (e) {
    var tgt = dropTarget();
    if (!tgt) { return; }
    var files = pastedFiles(e);
    if (!files.length) { return; }
    e.preventDefault();
    if (tgt === 'chat') { sendFiles(files); } else if (tgt === 'clip') { PDX.addFiles(files); } else { fsUpload(files); }
  });
  document.addEventListener('dragover', function (e) {
    if (!dropTarget()) { return; }
    e.preventDefault();
    app.classList.add('pd-dragging');
  });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) { app.classList.remove('pd-dragging'); } });
  document.addEventListener('drop', function (e) {
    app.classList.remove('pd-dragging');
    var tgt = dropTarget();
    if (!tgt) { return; }
    e.preventDefault();
    var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
    if (tgt === 'chat') { sendFiles(files); } else if (tgt === 'clip') { PDX.addFiles(files); } else { fsUpload(files); }
  });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && route().page === 'chat') { renderMsgs(false); } });

  var lastPage = '';
  window.addEventListener('hashchange', function () {
    var r = route();
    closeMenu();
    if (modalRoot.innerHTML && !modalRoot.querySelector('[data-act="req"]') && !pairInfo) { closeModal(); }
    if (r.page === 'pair') { startPair(); return; }
    pending = [];
    // 同一页面内切换会话只刷新列表与聊天，保留图标栏
    if (lastPage === r.page && document.getElementById('rail')) {
      renderRail();
      renderList();
      renderMain();
    } else {
      render();
    }
    lastPage = r.page;
    if (r.page === 'phone') { fsLoad(); }
  });

  /* ---------- 启动 ---------- */
  if (!location.hash) { history.replaceState(null, '', '#chat'); }
  var r0 = route();
  lastPage = r0.page;
  render();
  if (r0.page === 'pair') { startPair(); }
  // 供应商名称用于标题栏显示
  ['claude', 'codex'].forEach(function (k) {
    api('GET', P + '/api/agents/' + k + '/providers').then(function (r) {
      (r.list || []).forEach(function (p) { providerNames[p.id] = p.name; });
      if (route().page === 'chat') { renderHead(); }
    }).catch(function () {});
  });
  loadHost().then(function () {
    loadSessions().then(function () {
      if (route().page === 'chat' && !route().sid) {
        var first = sessions.filter(function (s) { return s.kind === 'assistant' && !hiddenSess[s.id]; })[0];
        if (first) { location.hash = 'chat/' + encodeURIComponent(first.id); }
      } else if (route().page === 'chat') { renderMain(); }
    });
  });
  if (r0.page === 'phone') { fsLoad(); }
  connect();
  setUnread('', 0);
  // 电脑端状态（在线手机、配对请求）每 3 秒刷新
  setInterval(loadHost, 3000);
})();
