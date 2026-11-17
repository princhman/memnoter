#!/usr/bin/env python3
"""TEMPORARY DIAGNOSTIC: remove before review merge; timings are instrumented."""

import datetime
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time


TARGETS = {"MemnoterUITests-Runner", "testmanagerd", "diagnosticd"}
PS = "/bin/ps"
SAMPLE = "/usr/bin/sample"
SUDO = "/usr/bin/sudo"
BUDGET = 240
PHASES = (0, 30, 75)
STOP = threading.Event()


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def log(message):
    print(f"{timestamp()} {message}", flush=True)


def run(command, deadline, timeout=15):
    """One child group at a time, including termination/reaping on cancellation."""
    remaining = min(timeout, deadline - time.monotonic() - 1)
    if STOP.is_set() or remaining <= 0:
        return None
    try:
        # File-backed output avoids pipe deadlocks and keeps memory bounded.
        with tempfile.TemporaryFile(mode="w+") as output:
            child = subprocess.Popen(
                command, stdout=output, stderr=output, start_new_session=True
            )
            try:
                end = time.monotonic() + remaining
                while child.poll() is None:
                    if STOP.is_set() or time.monotonic() >= end:
                        log(f"command stopped executable={command[0]} pid={child.pid}")
                        output.seek(0)
                        progress = output.read(4096).strip()
                        if progress:
                            log(f"partial command output: {progress}")
                        # Signal sudo directly as well, so its monitor forwards TERM
                        # to a root-owned sample before group cleanup.
                        child.terminate()
                        try:
                            os.killpg(child.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        try:
                            child.wait(timeout=0.3)
                        except subprocess.TimeoutExpired:
                            pass
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except (ProcessLookupError, PermissionError):
                            pass
                        child.wait(timeout=0.3)
                        return None
                    STOP.wait(min(0.1, max(0, end - time.monotonic())))
                output.seek(0)
                content = output.read()
                log(f"command executable={command[0]} status={child.returncode}")
                if child.returncode:
                    log(f"command error: {content.strip()}")
                    return None
                return content
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=0.3)
    except (OSError, subprocess.SubprocessError) as error:
        log(f"command failure executable={command[0]} error={error}")
        return None


def processes_from(output):
    processes = {}
    for line in output.splitlines():
        fields = line.strip().split(None, 3)
        if len(fields) != 4 or not all(field.isdigit() for field in fields[:3]):
            continue
        pid, ppid, uid = map(int, fields[:3])
        processes[pid] = (ppid, uid, fields[3])
    return processes


def snapshot(deadline):
    # ucomm comes from kernel process metadata; comm reads each process's argv.
    output = run([PS, "-axo", "pid,ppid,uid,ucomm"], deadline)
    if output is None:
        return None
    processes = processes_from(output)
    log("process snapshot BEGIN (pid ppid uid kernel name; no arguments)")
    for pid, (ppid, uid, name) in processes.items():
        log(f"process pid={pid} ppid={ppid} uid={uid} name={name}")
    log("process snapshot END")
    # The kernel name may truncate the runner; verify its full path below.
    candidates = sorted(
        (pid for pid, (_, _, name) in processes.items()
         if Path(name).name in TARGETS or Path(name).name.startswith("MemnoterUITests")),
        key=lambda pid: (not Path(processes[pid][2]).name.startswith("MemnoterUITests"), pid),
    )
    if not candidates:
        return {}
    if len(candidates) > 6:
        log(f"omitted {len(candidates) - 6} PIDs due to discovery cap")
    candidates = candidates[:6]
    output = run([PS, "-p", ",".join(map(str, candidates)), "-o", "pid,ppid,uid,comm"], deadline)
    if output is None:
        return None
    targets = {pid: record for pid, record in processes_from(output).items()
               if pid in candidates and Path(record[2]).name in TARGETS}
    for pid, (ppid, uid, path) in targets.items():
        log(f"target pid={pid} ppid={ppid} uid={uid} path={path}")
    return targets


def capture(directory):
    deadline = time.monotonic() + BUDGET
    first_runner = None
    phase = 0
    attempts = 0
    next_snapshot = 0
    log("DIAGNOSTIC — instrumented run, no speed conclusions; remove before review merge")
    log("limits: 240s wall, 15s/command, ~5s snapshots, rounds +0/+30/+75s, 6 PIDs/round, 18 samples total, serial 1s samples")
    try:
        while not STOP.is_set() and time.monotonic() < deadline - 1:
            now = time.monotonic()
            if now < next_snapshot:
                STOP.wait(min(0.1, next_snapshot - now))
                continue
            processes = snapshot(deadline)
            next_snapshot = time.monotonic() + 5
            if processes is None:
                continue
            targets = sorted(
                ((pid, *record) for pid, record in processes.items()
                 if Path(record[2]).name in TARGETS),
                key=lambda row: (Path(row[3]).name != "MemnoterUITests-Runner", row[0]),
            )
            if first_runner is None and any(
                Path(path).name == "MemnoterUITests-Runner"
                for _, _, _, path in targets
            ):
                first_runner = time.monotonic()
                log("first UITest runner observed; phase clock starts (discovery precision ~5s)")
            if first_runner is None:
                continue
            due = first_runner + PHASES[phase]
            if time.monotonic() < due:
                next_snapshot = min(next_snapshot, due)
                continue
            offset = PHASES[phase]
            phase += 1
            log(f"round +{offset}s actual_offset={time.monotonic() - first_runner:.3f}s targets={len(targets)}")
            for name in sorted(TARGETS):
                if not any(Path(row[3]).name == name for row in targets):
                    log(f"round +{offset}s missing target={name}")
            if len(targets) > 6:
                log(f"round +{offset}s omitted {len(targets) - 6} PIDs due to cap")
            for pid, ppid, uid, path in targets[:6]:
                if STOP.is_set() or time.monotonic() >= deadline - 1:
                    log(f"round +{offset}s incomplete: cancelled or wall budget")
                    break
                attempts += 1
                destination = directory / f"round-{offset}-pid-{pid}.txt"
                log(f"sample BEGIN round=+{offset}s pid={pid} ppid={ppid} uid={uid} path={path} file={destination.name}")
                command = [SAMPLE, str(pid), "1", "-file", str(destination)]
                if uid == 0:
                    command = [SUDO, "-n", *command]
                result = run(command, deadline)
                log(f"sample END pid={pid} status={'completed' if result is not None else 'failed/stopped'} file_exists={destination.exists()}")
            if phase == len(PHASES):
                break
            next_snapshot = min(next_snapshot, first_runner + PHASES[phase])
    finally:
        if first_runner is None:
            log("missed all phases: UITest runner never observed")
        for offset in PHASES[phase:]:
            log(f"missed round +{offset}s: cancelled or wall budget")
        log(f"capture END attempts={attempts} cancelled={STOP.is_set()}")


def main():
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    directory = Path(sys.argv[1])
    directory.mkdir(parents=True, exist_ok=True)
    capture(directory)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(f"diagnostic failure: {type(error).__name__}: {error}")
        sys.exit(1)
