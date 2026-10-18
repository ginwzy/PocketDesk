#!/usr/bin/env python3
"""安装 PocketDesk.app 并重启服务；失败时恢复旧应用。

先编译：scripts/package-mac.sh
检查：python3 scripts/install-mac.py --check
后台安装（适合从 PocketDesk 自身发起）：
  python3 scripts/install-mac.py --background --delay 60
日志、安装结果和旧版本保存在 ~/PocketDesk/updates/install-*/。
"""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

BUNDLE_ID = "com.pocketdesk.desktop"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def log(message):
    print(f"{datetime.datetime.now().isoformat(timespec='seconds')} {message}", flush=True)


def command(args, timeout=30):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{args[0]} 失败：{result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def bundle_version(app):
    with (app / "Contents/Info.plist").open("rb") as file:
        info = plistlib.load(file)
    if info.get("CFBundleIdentifier") != BUNDLE_ID:
        raise RuntimeError(f"应用标识不匹配：{app}")
    command(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
    return command([app / "Contents/MacOS/pocketdesk", "version"]).removeprefix("PocketDesk ")


def request(data, path="/admin/api/state", method="GET"):
    config = json.loads((data / "config.json").read_text())
    key = (data / "admin.key").read_text().strip()
    port = int(config["adminPort"])
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                 headers={"X-PD-Key": key})
    with OPENER.open(req, timeout=3) as response:
        return json.load(response)


def process_ids(target):
    exe = str(target / "Contents/MacOS/pocketdesk")
    rows = command(["/bin/ps", "-axo", "pid=,comm="])
    return [int(row.split(None, 1)[0]) for row in rows.splitlines()
            if len(row.split(None, 1)) == 2 and row.split(None, 1)[1] == exe]


def stop_service(target, data):
    try:
        request(data, "/admin/api/quit", "POST")
    except (OSError, ValueError):
        pass
    for sig in (signal.SIGTERM, signal.SIGKILL):
        pids = process_ids(target)
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if not process_ids(target):
                return
            time.sleep(0.25)
    raise RuntimeError("旧进程未能退出，已停止替换应用")


def start_service(target, data, version, fingerprint):
    # 通过 LaunchServices 打开应用，由应用自带的启动器创建后台服务，保持权限归属。
    command(["/usr/bin/open", "-n", "--env", f"POCKETDESK_HOME={data}", target])
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            state = request(data)
            host = state["host"]
            if host["version"] == version and host["fingerprint"] == fingerprint:
                if process_ids(target):
                    return
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.5)
    raise RuntimeError(f"新服务未通过检查：预期版本 {version}，且证书指纹保持不变")


def status(run, phase, **fields):
    payload = {"phase": phase, "at": datetime.datetime.now().isoformat(), **fields}
    temporary = run / "status.json.tmp"
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(run / "status.json")


def install(args, run):
    version = bundle_version(args.app)
    previous = bundle_version(args.target)
    before = request(args.data_dir)["host"]
    fingerprint = before["fingerprint"]
    token = uuid.uuid4().hex[:10]
    staged = args.target.parent / f".PocketDesk.staged-{token}.app"
    old = args.target.parent / f".PocketDesk.previous-{token}.app"
    backup = run / "PocketDesk.previous.app"
    stopped = False
    try:
        status(run, "preparing", version=version, previous=previous)
        log(f"准备 {version}，备份当前版本 {previous}")
        command(["/usr/bin/ditto", args.app, staged], timeout=60)
        bundle_version(staged)
        command(["/usr/bin/ditto", args.target, backup], timeout=60)
        status(run, "installing", version=version, previous=previous)
        stopped = True
        stop_service(args.target, args.data_dir)
        args.target.rename(old)
        staged.rename(args.target)
        start_service(args.target, args.data_dir, version, fingerprint)
        status(run, "success", version=version, previous=previous, backup=str(backup),
               target=str(args.target), fingerprint=fingerprint)
        log(f"安装并重启成功：{version}；服务检查通过，证书指纹未改变")
    except Exception as error:
        log(f"安装失败：{error}")
        if stopped:
            try:
                stop_service(args.target, args.data_dir)
                if old.exists():
                    if args.target.exists():
                        args.target.rename(run / "PocketDesk.failed.app")
                    old.rename(args.target)
                start_service(args.target, args.data_dir, previous, fingerprint)
                status(run, "rolled_back", error=str(error), version=previous, backup=str(backup))
                log(f"已回退并恢复服务：{previous}")
            except Exception as rollback_error:
                status(run, "rollback_failed", error=str(error), rollbackError=str(rollback_error),
                       backup=str(backup), original=str(old))
                raise RuntimeError(f"回退失败：{rollback_error}；备份：{backup}") from error
        else:
            status(run, "failed", error=str(error))
        raise
    finally:
        if staged.exists():
            shutil.rmtree(staged)
    if old.exists():
        try:
            shutil.rmtree(old)
        except OSError as error:
            log(f"服务已恢复，但旧应用临时副本未能清理：{old}（{error}）")


def schedule(args, base, version):
    run = base / ("install-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6])
    run.mkdir(mode=0o700)
    # 把安装器与安装包都放到内置盘；PocketDesk 和外置盘目录不再是安装任务的依赖。
    staged = run / "PocketDesk.app"
    command(["/usr/bin/ditto", args.app, staged], timeout=60)
    bundle_version(staged)
    worker = run / "install-mac.py"
    shutil.copy2(Path(__file__).resolve(), worker)
    label = "com.pocketdesk.update." + uuid.uuid4().hex
    plist = run / "job.plist"
    job = {"Label": label, "RunAtLoad": True,
           "ProgramArguments": [sys.executable, "-u", str(worker), "--app", str(staged),
                                "--target", str(args.target), "--data-dir", str(args.data_dir),
                                "--delay", str(args.delay), "--run-dir", str(run)],
           "WorkingDirectory": str(run), "StandardOutPath": str(run / "install.log"),
           "StandardErrorPath": str(run / "install.log"),
           "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")}}
    with plist.open("wb") as file:
        plistlib.dump(job, file)
    status(run, "scheduled", version=version, delay=args.delay, label=label)
    try:
        command(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", plist])
    except Exception as error:
        status(run, "failed", error=str(error))
        raise
    log(f"已安排独立后台任务，{args.delay:g} 秒后开始安装 {version}")
    log(f"结果：{run / 'status.json'}")
    log(f"日志：{run / 'install.log'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app", type=Path, default=Path(__file__).resolve().parent.parent / "server/dist/PocketDesk.app")
    parser.add_argument("--target", type=Path, default=Path("/Applications/PocketDesk.app"))
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("POCKETDESK_HOME", str(Path.home() / "PocketDesk/data"))))
    parser.add_argument("--background", action="store_true", help="由独立 launchd 任务安装，连接中断后仍继续")
    parser.add_argument("--delay", type=float, default=0, help="开始前等待秒数，便于保存当前会话")
    parser.add_argument("--check", action="store_true", help="只检查安装包、权限及现有服务，不停止或替换应用")
    parser.add_argument("--run-dir", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("此脚本仅适用于 macOS")
    if args.delay < 0:
        parser.error("delay 不能为负数")
    try:
        execute(args)
    except Exception as error:
        if args.run_dir:
            result = args.run_dir / "status.json"
            phase = json.loads(result.read_text()).get("phase") if result.exists() else ""
            if phase not in ("failed", "rolled_back", "rollback_failed"):
                status(args.run_dir, "failed", error=str(error))
        raise


def execute(args):
    args.app = args.app.expanduser().resolve()
    args.target = args.target.expanduser().resolve()
    args.data_dir = args.data_dir.expanduser().resolve()
    if args.app == args.target:
        parser.error("安装包路径不能与目标应用相同")
    version = bundle_version(args.app)
    bundle_version(args.target)
    if not os.access(args.target.parent, os.W_OK | os.X_OK):
        raise RuntimeError(f"没有安装权限：{args.target.parent}")
    request(args.data_dir)
    if args.check:
        log(f"检查通过：{version}，目标 {args.target}，现有服务可访问")
        return
    base = Path.home() / "PocketDesk/updates"
    base.mkdir(parents=True, exist_ok=True)
    if args.background:
        schedule(args, base, version)
        return
    run = args.run_dir or base / ("install-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6])
    run.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.delay:
        log(f"等待 {args.delay:g} 秒后安装；当前连接可能短暂中断")
        time.sleep(args.delay)
    with (base / ".install.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        install(args, run)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(f"错误：{error}")
        sys.exit(1)
