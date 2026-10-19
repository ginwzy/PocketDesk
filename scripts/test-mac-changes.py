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
    project = workspace / 'project'; project.mkdir()
    for i in range(10000): (project / f'module-{i:05d}.js').write_text(f'const current = {i};\n')
    (project / 'nested').mkdir(); (project / 'nested/current.js').write_text('const current = \"<current>\";\n')
    (project / 'empty.txt').touch()
    (project / 'large.txt').write_text('x' * 300000)
    (project / 'image.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>')
    (workspace / 'outside.txt').write_text('outside session directory')
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
        session = api('/admin/p/api/sessions', {'kind': 'pi', 'workspaceId': ws['id'], 'cwd': 'project'})['id']
        computer_session = api('/admin/p/api/sessions', {'kind': 'pi', 'workspaceId': 'computer', 'cwd': str(project)})['id']
        repo = workspace / 'repository'; repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        (repo / 'current.js').write_text('const version = \"before\";\n')
        subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], check=True)
        (repo / 'current.js').write_text('const version = \"after\";\n')
        git_session = api('/admin/p/api/sessions', {'kind': 'pi', 'workspaceId': ws['id'], 'cwd': 'repository'})['id']
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
        return proc, log, base, key, session, computer_session, git_session
    except BaseException:
        proc.terminate()
        proc.wait(timeout=10)
        log.close()
        raise


async def check(base, key, session, computer_session, git_session, args):
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
        directory_start = time.monotonic()
        await page.locator('[data-act="files-sidebar"]').click()
        await expect(page.locator('#change-view')).to_be_visible()
        await expect(page.locator('#change-view [role="tab"]')).to_have_count(2)
        await expect(page.locator('#ch-tab-files')).to_have_attribute('aria-selected', 'true')
        await expect(page.locator('.ch-file')).not_to_have_count(0)
        directory_ready = time.monotonic() - directory_start
        assert await page.locator('.ch-file').count() <= 40
        assert len(requests) == 0, 'opening files must not load diffs'
        identity = await page.locator('#change-view').evaluate('e => {e.testIdentity=123;return e.testIdentity}')
        await page.locator('.ch-filter').fill('nested')
        await expect(page.locator('.ch-file')).to_have_count(1)
        await page.locator('.ch-file').click()
        await expect(page.locator('.ch-location > span')).to_have_text('nested')
        await page.locator('.ch-file').click()
        await expect(page.locator('.ch-file-text')).to_contain_text('<current>')
        assert await page.locator('.ch-file-text script').count() == 0
        await page.locator('[data-change="back"]').click()
        await expect(page.locator('.ch-file')).to_have_count(1)
        await page.locator('[data-change="up"]').click()
        await expect(page.locator('.ch-filter')).to_be_visible()

        async def browser_file(name):
            await page.locator('.ch-filter').fill(name)
            await expect(page.locator('.ch-file')).to_have_count(1)
            await expect(page.locator('.ch-file strong')).to_have_text(name)
            await page.locator('.ch-file').click()

        await browser_file('empty.txt')
        await expect(page.locator('.ch-file-text')).to_have_text('')
        await page.locator('[data-change="back"]').click()
        await browser_file('large.txt')
        await expect(page.locator('.ch-scroll .ch-source')).to_contain_text('256 KB')
        assert await page.locator('.ch-file-text').evaluate('e=>e.textContent.length') == 262144
        await page.locator('[data-change="back"]').click()
        await browser_file('image.svg')
        await expect(page.locator('.ch-image')).to_be_visible()
        await page.wait_for_function('document.querySelector(".ch-image").naturalWidth === 16')
        await page.locator('[data-change="back"]').click()
        await page.locator('.ch-filter').fill('')
        await expect(page.locator('.ch-file')).not_to_have_count(1)
        if args.screenshots:
            await page.screenshot(path=str(args.screenshots / f'sidebar-{args.browser}-files.png'), animations='disabled')
        await page.locator('#ch-tab-diff').click()
        await expect(page.locator('.ch-file')).not_to_have_count(0)
        await expect(page.locator('.ch-source')).to_contain_text('本会话记录的改动')
        assert await page.locator('#change-view').evaluate('e=>e.testIdentity') == identity
        assert len(requests) == 0, 'the diff list must not prefetch patches'
        await page.locator('[data-act="files-sidebar"]').click()
        await expect(page.locator('#change-view')).not_to_be_visible()

        start = time.monotonic()
        await page.get_by_text('查看全部 10000 个文件', exact=True).click()
        await expect(page.locator('.ch-code-row')).to_have_count(160)
        first_ready = time.monotonic() - start
        assert len(requests) == 1
        assert await page.locator('#ch-tab-diff').get_attribute('aria-selected') == 'true'
        assert await page.locator('.ch-toolbar,.ch-find,.ch-resize,.ch-footer').count() == 0
        assert await page.locator('.ch-code-scroll').evaluate('e=>e.clientHeight') > 350
        await page.locator('.ch-code-scroll').evaluate('e=>e.scrollTop=1e9')
        await expect(page.locator('.ch-code-scroll')).to_contain_text('item49999')
        assert await page.locator('.ch-code-row').count() <= 160
        if args.screenshots:
            await page.screenshot(path=str(args.screenshots / f'sidebar-{args.browser}-diff.png'), animations='disabled')

        async def select_file(index):
            await page.locator('[data-change="back"]').click()
            await page.locator('.ch-filter').fill(f'module-{index:05d}')
            await expect(page.locator('.ch-file')).to_have_count(1)
            await expect(page.locator('.ch-file')).to_have_attribute('data-change-file', str(index))
            await page.locator('.ch-file').click()
            await expect(page.locator('.ch-location > span')).to_contain_text(f'module-{index:05d}')

        await select_file(9999)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('new-9999 <tag>')
        assert len(requests) == 2
        await select_file(3)
        await expect(page.locator('.ch-scroll')).to_contain_text('二进制文件没有文本差异')
        assert len(requests) == 2
        await select_file(4)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('new-4')
        await select_file(0)
        await expect(page.locator('.ch-code-scroll')).to_contain_text('item49999')
        assert len(requests) == 3, 'revisiting a cached file should not fetch again'
        await page.locator('#ch-tab-files').click()
        assert await page.evaluate('window.activeWorkers') == 0
        await page.locator('#ch-tab-diff').click()
        await expect(page.locator('.ch-code-scroll')).to_contain_text('item49999')
        assert len(requests) == 3

        # A late transport response must not replace the file browser after switching tabs.
        gate, started, delivered = asyncio.Event(), asyncio.Event(), asyncio.Event()
        await page.evaluate("""() => { window.realFetch=window.fetch;window.fetch=(url,opts)=>window.realFetch(url,String(url).endsWith('ref=changes-6')?{...opts,signal:undefined}:opts); }""")
        async def slow(route):
            response = await route.fetch(); started.set(); await gate.wait()
            await route.fulfill(response=response); delivered.set()
        await page.route('**/diff?ref=changes-6', slow, times=1)
        await select_file(6); await started.wait()
        await page.locator('#ch-tab-files').click(); gate.set(); await delivered.wait()
        await page.wait_for_timeout(100)
        await expect(page.locator('#ch-tab-files')).to_have_attribute('aria-selected', 'true')
        await expect(page.locator('.ch-file')).not_to_have_count(0)
        assert await page.evaluate('window.activeWorkers') == 0
        await page.evaluate('window.fetch=window.realFetch')
        await page.locator('#ch-tab-diff').click()
        await expect(page.locator('.ch-code-scroll')).to_contain_text('new-6')
        await page.route('**/diff?ref=changes-8', lambda r: r.fulfill(status=503, content_type='application/json', body='{"message":"fixture retry"}'), times=1)
        await select_file(8)
        await expect(page.locator('.ch-scroll')).to_contain_text('fixture retry')
        await page.locator('[data-change="retry"]').click()
        await expect(page.locator('.ch-code-scroll')).to_contain_text('new-8')
        await select_file(2)
        await expect(page.locator('.ch-scroll')).to_contain_text('150,000')
        await page.locator('[data-change="close"]').click()
        assert await page.evaluate('window.activeWorkers') == 0
        await expect(page.locator('#input')).to_have_value('保留这份草稿')
        await page.locator('.pd-tool-group-head').click()
        await page.locator('.pd-tool-row').click()
        await expect(page.locator('.ch-source')).to_contain_text('工具提交的补丁')
        await expect(page.locator('.ch-code-row')).to_have_count(5)
        assert all(not text for text in await page.locator('.ch-number').all_text_contents())
        await page.locator('#ch-tab-files').click()
        await page.set_viewport_size({'width': 1700, 'height': 1000})
        await expect(page.locator('#input')).to_be_visible()
        await page.locator('#change-view').evaluate('e=>e.testIdentity=456')
        await page.locator('.pd-diff-row [data-act="diff-ref"]').first.click()
        await expect(page.locator('.ch-source')).to_contain_text('所选轮次')
        await expect(page.locator('.ch-code-row')).to_have_count(160)
        assert await page.locator('#change-view').evaluate('e=>e.testIdentity') == 456
        await page.locator('#ch-tab-files').click()
        assert await page.locator('#change-view').evaluate('e=>e.testIdentity') == 456
        if args.screenshots:
            await page.screenshot(path=str(args.screenshots / f'sidebar-{args.browser}-wide.png'), animations='disabled')
        await page.locator('[data-change="close"]').click()
        await page.locator('.pd-tool-inspect-input').click()
        await expect(page.locator('#tool-inspector')).to_be_visible()
        await expect(page.locator('#change-view')).not_to_be_visible()
        await page.goto(f'{base}/?k={key}#chat/{computer_session}')
        await page.locator('[data-act="files-sidebar"]').click()
        await expect(page.locator('.ch-location > span')).to_have_text('project')
        await expect(page.locator('.ch-filter')).to_be_visible()
        await page.locator('.ch-filter').fill('outside.txt')
        await expect(page.locator('.ch-empty')).to_contain_text('没有匹配')
        await page.goto(f'{base}/?k={key}#chat/{git_session}')
        await page.locator('[data-act="files-sidebar"]').click()
        await page.locator('#ch-tab-diff').click()
        await expect(page.locator('.ch-source')).to_contain_text('未提交改动')
        await expect(page.locator('.ch-file strong')).to_have_text('current.js')
        await page.locator('.ch-file').click()
        await expect(page.locator('.ch-code-scroll')).to_contain_text('before')
        await expect(page.locator('.ch-code-scroll')).to_contain_text('after')
        await page.evaluate("document.documentElement.dataset.theme='dark'")
        if args.screenshots:
            await page.screenshot(path=str(args.screenshots / f'sidebar-{args.browser}-dark.png'), animations='disabled')
        await page.locator('[data-change="close"]').click()
        assert await page.evaluate('window.activeWorkers') == 0
        assert not errors, errors
        print(json.dumps({'browser': args.browser, 'files': 10000, 'selectedFileLines': 50000,
                          'directoryReadySeconds': round(directory_ready, 3), 'firstReadySeconds': round(first_ready, 3), 'diffRequests': len(requests),
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
        proc, log, base, key, session, computer_session, git_session = fixture(root, args.server.resolve())
        try:
            asyncio.run(asyncio.wait_for(check(base, key, session, computer_session, git_session, args), timeout=60))
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
