#!/usr/bin/env python3
"""Mac web UI integration/performance check against an isolated compiled server.

Requires Playwright Python and its browser. Example:
  python3 scripts/test-mac-changes.py --server /tmp/pocketdesk --browser webkit
No real workspace, clipboard, file opener, or running PocketDesk instance is used.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

from playwright.async_api import async_playwright, expect


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def fixture(root, binary):
    workspace = root / 'workspace'
    workspace.mkdir()
    key = secrets.token_hex(24)
    (root / 'admin.key').write_text(key)
    port = free_port()
    (root / 'config.json').write_text(json.dumps({
        'hostName': 'Mac change viewer fixture', 'port': free_port(), 'adminPort': port,
        'defaultWorkspace': str(workspace), 'transfer': {'inboxDir': str(workspace)},
        'agents': {'pi': ['/usr/bin/true']},
    }))
    log = (root / 'server.log').open('w')
    proc = subprocess.Popen([str(binary), 'serve'], env={**os.environ, 'POCKETDESK_HOME': str(root)}, stdout=log, stderr=log)
    base = f'http://127.0.0.1:{port}'

    def api(path, body=None):
        request = urllib.request.Request(base + path, headers={'X-PD-Key': key, 'Content-Type': 'application/json'},
                                         data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(request, timeout=2) as response:
            return json.load(response)

    try:
        for _ in range(100):
            try:
                api('/admin/api/state')
                break
            except Exception:
                if proc.poll() is not None:
                    raise RuntimeError((root / 'server.log').read_text())
                time.sleep(.1)
        workspaces = api('/admin/p/api/ws')
        ws = next(w for w in workspaces if w['rootPath'] == str(workspace))
        session = api('/admin/p/api/sessions', {'kind': 'pi', 'workspaceId': ws['id'], 'cwd': '.'})['id']
        files = [{'path': f'src/group-{i // 100:03d}/module-{i:05d}.js', 'ref': f'changes-{i}',
                  'abs': str(workspace / f'module-{i:05d}.js'), 'status': 'modified', 'added': 2, 'removed': 2} for i in range(10000)]
        files[3].update(binary=True, ref='', status='added')
        files[4]['status'] = 'deleted'
        files[9998]['path'] = 'src/测试/e\u0301-索引.js'
        small = '--- a/sample.js\n+++ b/sample.js\n@@ -10,3 +10,3 @@\n export function greeting(name) {\n-  return "old <tag> " + name;\n+  return "new <tag> " + name;\n }\n'
        large = '@@ -0,0 +1,50000 @@\n' + '\n'.join(f'+const item{i} = {i};' for i in range(50000)) + '\n'
        patch = '*** Begin Patch\n' + '\n'.join(f'*** Update File: src/tool-{i}.js\n@@\n-const old = 1;\n-console.log(old);\n+const next = 2;\n+console.log(next);' for i in range(10000)) + '\n*** End Patch'
        long = '0123456789' * 60
        patch = patch.replace('*** Update File: src/tool-1.js\n@@\n-const old = 1;\n-console.log(old);\n+const next = 2;\n+console.log(next);', f'*** Update File: src/tool-1.js\n@@\n-const value = "{long}old";\n+const value = "{long}new";')
        now = int(time.time() * 1000)
        with sqlite3.connect(next(root.glob('*.db'))) as db:
            db.executemany('insert into turn_diffs values(?,?,?,?)',
                           [(session, f'changes-{i}', large if i == 0 else small.replace('new <tag>', f'new-{i} <tag>'), now) for i in range(10000)])
            db.execute('update turn_diffs set text=? where session_id=? and ref=?', ('@@ -0,0 +1,150000 @@\n' + '+x\n' * 150000, session, 'changes-2'))
            seq = db.execute('select coalesce(max(seq),0) from events where session_id=?', (session,)).fetchone()[0]
            for kind, data in [
                ('msg.user', {'text': '请检查这轮文件改动。'}),
                ('tool.start', {'id': 'tool-fixture', 'name': 'apply_patch', 'kind': 'edit', 'input': {'patch': patch}}),
                ('tool.end', {'id': 'tool-fixture', 'output': 'Updated files', 'error': False}),
                ('diff.summary', {'files': files, 'git': True}),
            ]:
                seq += 1
                db.execute('insert into events values(?,?,?,?,?)', (session, seq, kind, json.dumps(data), now))
            db.execute('update sessions set last_seq=?,title=?,updated_at=? where id=?', (seq, '变更预览验收', now, session))
        return proc, log, base, key, session
    except BaseException:
        proc.terminate()
        proc.wait(timeout=10)
        log.close()
        raise


async def check(base, key, session, args):
    async with async_playwright() as playwright:
        engine = getattr(playwright, args.browser)
        launch = {'headless': True}
        if args.executable:
            launch['executable_path'] = args.executable
        browser = await engine.launch(**launch)
        context = await browser.new_context(viewport={'width': 900, 'height': 600})
        await context.add_init_script("""
            window.activeWorkers=0;const NativeWorker=window.Worker;window.Worker=class extends NativeWorker {constructor(...args){super(...args);this.live=true;window.activeWorkers++;}terminate(){if(this.live){this.live=false;window.activeWorkers--;}super.terminate();}};
            window.testCopies=[];
            Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>window.testCopies.push(t)}});
            window.longTasks=[];
            if (PerformanceObserver.supportedEntryTypes.includes('longtask'))
              new PerformanceObserver(l=>window.longTasks.push(...l.getEntries().map(x=>x.duration))).observe({type:'longtask',buffered:true});
        """)
        page = await context.new_page()
        page.set_default_timeout(10000)
        errors, requests = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('request', lambda r: requests.append(r.url) if '/diff?ref=' in r.url else None)
        await page.route('**/sync', lambda r: r.fulfill(content_type='application/json', body='{}'))
        await page.goto(f'{base}/?k={key}#chat/{session}')
        await expect(page.locator('.pd-diff-row')).to_have_count(8)
        await page.locator('#input').fill('保留这份草稿')
        start = time.monotonic()
        await page.get_by_text('查看全部 10000 个文件', exact=True).click()
        await expect(page.locator('.ch-code-row')).to_have_count(160)
        first_ready = time.monotonic() - start
        assert len(requests) == 1
        assert await page.locator('.ch-file').count() <= 40
        assert await page.locator('.ch-code-scroll').evaluate('e=>e.clientHeight') > 250
        if args.screenshots:
            await page.screenshot(path=str(args.screenshots / f'changes-{args.browser}-900.png'), animations='disabled')
        await page.locator('[data-change="files"]').click()
        await page.locator('#ch-filter').fill('é-索引')
        await expect(page.locator('.ch-file')).to_have_count(1)
        await expect(page.locator('.ch-file')).to_have_attribute('data-change-file', '9998')
        await page.locator('#ch-filter').fill('')
        await expect(page.locator('.ch-file[data-change-file="0"]')).to_be_visible()
        await page.locator('.ch-files [data-change="hide-files"]').click()
        await page.locator('[data-change="find"]').click()
        await page.locator('#ch-search').fill('item49999')
        await expect(page.locator('.ch-hits')).to_contain_text('1 / 1')
        await expect(page.locator('.ch-code-scroll')).to_contain_text('item49999')
        await page.keyboard.press('Escape')
        await expect(page.locator('#change-view')).to_be_visible()

        async def select_file(index):
            if not await page.locator('#ch-filter').is_visible():
                await page.locator('[data-change="files"]').click()
            await page.locator('#ch-filter').fill(f'module-{index:05d}')
            await expect(page.locator('.ch-file')).to_have_count(1)
            await expect(page.locator('.ch-file')).to_have_attribute('data-change-file', str(index))
            await page.locator('.ch-file').click()
            await expect(page.locator('.ch-path')).to_contain_text(f'module-{index:05d}')

        await select_file(9999)
        await expect(page.locator('.ch-code-row')).to_have_count(7)
        assert len(requests) == 2
        await page.locator('[data-change="copy"]').click()
        assert 'new-9999 <tag>' in (await page.evaluate('window.testCopies'))[-1]
        await select_file(3)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('二进制文件没有文本差异')
        assert len(requests) == 2
        await select_file(4)
        await expect(page.locator('[data-change="open"]')).to_be_disabled()
        await expect(page.locator('.ch-code-row')).to_have_count(7)
        await select_file(0)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('item49999')
        assert len(requests) == 3, 'revisiting a cached file should not fetch again'

        # Even a transport that ignores cancellation cannot publish a stale result.
        await page.evaluate("""() => { window.realFetch=window.fetch;window.fetch=(url,opts)=>window.realFetch(url,String(url).endsWith('ref=changes-6')?{...opts,signal:undefined}:opts); }""")
        gate, started, delivered = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def slow(route):
            response = await route.fetch()
            started.set()
            await gate.wait()
            await route.fulfill(response=response)
            delivered.set()

        await page.route('**/diff?ref=changes-6', slow, times=1)
        await select_file(6)
        await started.wait()
        await select_file(7)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('new-7')
        gate.set()
        await delivered.wait()
        await page.wait_for_timeout(100)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('new-7')
        await page.evaluate('window.fetch=window.realFetch')
        await page.route('**/diff?ref=changes-8', lambda r: r.fulfill(status=503, content_type='application/json', body='{"message":"fixture retry"}'), times=1)
        await select_file(8)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('fixture retry')
        await page.locator('[data-change="retry"]').click()
        await expect(page.locator('.ch-code-scroll')).to_contain_text('new-8')
        await select_file(9999)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('new-9999')
        assert len(requests) == 8, 'bounded cache must evict old files'
        await select_file(2)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('150,000')
        await page.locator('[data-change="copy"]').click()
        copied = (await page.evaluate('window.testCopies'))[-1]
        assert copied.count('\n') == 150001, 'render guard must preserve the full source for copying'
        await page.locator('[data-change="close"]').click()
        await expect(page.locator('#input')).to_have_value('保留这份草稿')
        assert await page.evaluate('window.activeWorkers') == 0
        await page.locator('.pd-tool-group-head').click()
        await page.locator('.pd-tool-row').click()
        await expect(page.locator('.ch-source')).to_contain_text('工具提交的补丁')
        await expect(page.locator('.ch-code-row')).to_have_count(5)
        assert all(not text for text in await page.locator('.ch-number').all_text_contents())
        await expect(page.locator('[data-change="open"]')).to_be_enabled()
        await page.set_viewport_size({'width': 1900, 'height': 1000})
        await page.locator('[data-change="split"]').click()
        await expect(page.locator('.ch-code-table.split')).to_be_visible()
        copied = await page.evaluate("""() => {
          const cells=document.querySelectorAll('.ch-code-row.pair .ch-cell:first-child code');
          const range=document.createRange();range.setStart(cells[0],0);range.setEnd(cells[1],cells[1].childNodes.length);
          const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
          const transfer=new DataTransfer();cells[0].dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:transfer}));
          selection.removeAllRanges();return transfer.getData('text/plain');
        }""")
        assert copied == 'const old = 1;\nconsole.log(old);', copied

        if args.screenshots:
            await page.screenshot(path=str(args.screenshots / f'changes-{args.browser}-wide.png'), animations='disabled')
        await page.locator('[data-change="next"]').click()
        await expect(page.locator('.ch-horizontal')).to_be_visible()
        await page.locator('.ch-hbar').first.evaluate('e=>e.scrollLeft=200')
        await expect(page.locator('.ch-cell .ch-line-text').first).to_have_css('transform', 'matrix(1, 0, 0, 1, -200, 0)')
        await page.locator('.ch-hbar').first.evaluate('e=>e.scrollLeft=1e9')
        await page.wait_for_function('()=>{const t=document.querySelector(".ch-cell .ch-line-text");return t.getBoundingClientRect().right<=t.parentElement.getBoundingClientRect().right+1}')
        await page.locator('[data-change="wrap"]').click()
        await expect(page.locator('.ch-horizontal')).not_to_be_visible()
        await expect(page.locator('.ch-cell .ch-line-text').first).to_have_css('transform', 'none')
        heights = await page.locator('.ch-code-row.pair .ch-cell').evaluate_all('els=>els.map(e=>e.getBoundingClientRect().height)')
        assert heights[0] > 30 and abs(heights[0]-heights[1]) < 1, heights
        width = await page.locator('#change-view').evaluate('e=>e.clientWidth')
        await page.locator('.ch-resize').focus()
        await page.keyboard.press('ArrowLeft')
        await page.wait_for_function('(w)=>document.getElementById("change-view").clientWidth>=w+30', arg=width)
        await page.evaluate("document.documentElement.dataset.theme='dark'")
        if args.screenshots:
            await page.screenshot(path=str(args.screenshots / f'changes-{args.browser}-dark.png'), animations='disabled')
        await page.locator('[data-change="close"]').click()
        assert await page.evaluate('window.activeWorkers') == 0
        await page.locator('.pd-tool-inspect-input').click()
        await expect(page.locator('#tool-inspector')).to_be_visible()
        await expect(page.locator('#change-view')).not_to_be_visible()
        assert not errors, errors
        print(json.dumps({'browser': args.browser, 'files': 10000, 'selectedFileLines': 50000,
                          'firstReadySeconds': round(first_ready, 3), 'diffRequests': len(requests),
                          'longTasks': await page.evaluate("PerformanceObserver.supportedEntryTypes.includes('longtask') ? window.longTasks : null"), 'pageErrors': errors}))
        await browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True, type=Path)
    parser.add_argument('--browser', choices=['chromium', 'webkit'], default='webkit')
    parser.add_argument('--executable', help='Optional Chromium executable path')
    parser.add_argument('--screenshots', type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pd-change-ui-') as folder:
        root = Path(folder)
        proc, log, base, key, session = fixture(root, args.server.resolve())
        try:
            asyncio.run(asyncio.wait_for(check(base, key, session, args), timeout=60))
        except BaseException:
            print((root / 'server.log').read_text()[-4000:])
            raise
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            log.close()


if __name__ == '__main__':
    main()
