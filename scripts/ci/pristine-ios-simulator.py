#!/usr/bin/env python3
"""Temporary same-run, same-identity blank simulator experiment; remove before merge.

Only invoked as test preparation on disposable GitHub macos-26 runners. This is
not a cache format: CoreSimulator cross-host compatibility remains unproven.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import subprocess
import sys
import tarfile
import time

LIMIT = 500 * 1024 * 1024
PREFIX = 'com.vladyslavnalyvaiko.memnoter'


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def run(*args, timeout=60):
    print('+', *args, flush=True)
    return subprocess.check_output(args, timeout=timeout)


def sha256(path):
    with path.open('rb') as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
        return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def inventory(raw):
    apps = plistlib.loads(raw)
    require(isinstance(apps, dict), 'app inventory is not a dictionary')
    for key, app in apps.items():
        require(isinstance(key, str) and isinstance(app, dict), 'invalid app inventory entry')
        bundle = app.get('CFBundleIdentifier')
        require(isinstance(bundle, str) and bundle, 'app inventory missing bundle identifier')
        require(PREFIX not in key.lower() and PREFIX not in bundle.lower(),
                'Memnoter or test runner installed in baseline')
    require(bool(apps), 'empty app inventory cannot establish pristine OS apps')


def metadata(output):
    image = {key: os.environ.get(key, '') for key in ('ImageOS', 'ImageVersion')}
    require(all(image.values()), 'missing runner image identity')
    sdk = run('xcrun', '--sdk', 'iphonesimulator', '--show-sdk-version').decode().strip()
    require(sdk == '26.5', f'expected SDK 26.5, got {sdk}')
    devices = json.loads(run('xcrun', 'simctl', 'list', 'devices', 'available', '--json'))
    write_json(output / 'simulators.json', devices)
    runtime_id = 'com.apple.CoreSimulator.SimRuntime.iOS-' + sdk.replace('.', '-')
    # Identical selection to boot-ios-simulator.sh, without booting the fresh host.
    matches = sorted((d for d in devices['devices'].get(runtime_id, [])
                      if d['name'].startswith('iPad')), key=lambda d: (d['name'], d['udid']))
    require(bool(matches), 'no matching iPad')
    device = matches[0]
    uuid = device['udid']
    require(re.fullmatch(r'[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}', uuid), 'invalid UUID')
    parent = Path.home() / 'Library/Developer/CoreSimulator/Devices'
    folder = parent / uuid
    require(parent.resolve() == parent and folder.resolve() == folder, 'device parent/folder is a symlink')
    require(device.get('dataPath') == str(folder / 'data'), 'nonstandard device dataPath')
    require((folder / 'data').is_dir() and not (folder / 'data').is_symlink(), 'invalid device data directory')
    with (folder / 'device.plist').open('rb') as stream:
        registered = plistlib.load(stream)
    for key, expected in [('UDID', uuid), ('name', device['name']), ('runtime', runtime_id),
                          ('deviceType', device.get('deviceTypeIdentifier'))]:
        require(bool(expected) and registered.get(key) == expected, f'device.plist mismatch: {key}')
    runtimes = json.loads(run('xcrun', 'simctl', 'list', 'runtimes', '--json'))
    write_json(output / 'runtimes.json', runtimes)
    runtime = next((r for r in runtimes['runtimes'] if r['identifier'] == runtime_id), None)
    require(runtime and runtime.get('isAvailable') and runtime.get('buildversion'), 'runtime metadata missing')
    frameworks = [Path(os.environ['DEVELOPER_DIR']) / 'Library/PrivateFrameworks/CoreSimulator.framework',
                  Path('/Library/Developer/PrivateFrameworks/CoreSimulator.framework')]
    framework = next((p for p in frameworks if (p / 'Resources/Info.plist').is_file()), None)
    require(framework is not None, 'CoreSimulator framework metadata missing')
    with (framework / 'Resources/Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    require(info.get('CFBundleVersion') and info.get('CFBundleShortVersionString'), 'CoreSimulator version missing')
    identity = dict(image=image, architecture=run('uname', '-m').decode().strip(),
                    xcode=run('xcodebuild', '-version').decode().strip(), sdk=sdk,
                    coreSimulator=dict(path=str(framework.resolve()), version=info['CFBundleVersion'],
                                       shortVersion=info['CFBundleShortVersionString']),
                    runtime=dict(identifier=runtime_id, build=runtime['buildversion']),
                    device=dict(uuid=uuid, type=device['deviceTypeIdentifier'], name=device['name'],
                                dataPath=device['dataPath']))
    require(identity['architecture'] and identity['xcode'], 'missing toolchain identity')
    write_json(output / 'host.json', identity)
    return identity, folder, device['state']


def compare(manifest, actual):
    require(manifest.get('schema') == 1, 'unknown manifest schema')
    require(manifest.get('run') == {k: os.environ.get(k) for k in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')},
            'baseline belongs to another run/attempt')
    for key in ('image', 'architecture', 'xcode', 'sdk', 'coreSimulator', 'runtime', 'device'):
        require(manifest.get('identity', {}).get(key) == actual[key], f'identity mismatch: {key}')


def validate_archive(archive, manifest):
    require(archive.stat().st_size <= LIMIT, 'archive exceeds 500 MiB transfer cap')
    require(archive.stat().st_size == manifest['compressedBytes'], 'archive size mismatch')
    digest = sha256(archive)
    require(digest == manifest['sha256'], 'archive digest mismatch')
    uuid = manifest['identity']['device']['uuid']
    paths = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = member.name.rstrip('/')
            parts = PurePosixPath(name).parts
            require(name and not name.startswith('/') and '..' not in parts and
                    name == '/'.join(parts), f'unsafe archive path: {name}')
            require(parts == (uuid,) or parts[:2] == (uuid, 'data') or parts == (uuid, 'device.plist'),
                    f'archive outside selected device: {name}')
            require(name not in paths, f'duplicate archive path: {name}')
            require(member.isfile() or member.isdir() or member.issym() or member.islnk(),
                    f'unsupported archive entry: {name}')
            paths[name] = member
        require(uuid in paths and paths[uuid].isdir(), 'missing device directory')
        require(f'{uuid}/device.plist' in paths and paths[f'{uuid}/device.plist'].isfile(), 'missing device.plist')
        require(f'{uuid}/data' in paths and paths[f'{uuid}/data'].isdir(), 'missing data directory')
        for name, member in paths.items():
            for parent in PurePosixPath(name).parents:
                require(str(parent) not in paths or paths[str(parent)].isdir(),
                        f'archive traverses non-directory: {name}')
            if member.islnk():
                require(member.linkname in paths and paths[member.linkname].isfile(),
                        f'unsafe archive hardlink: {name}')
        # Leaf symlinks (including absolute OS links) are preserved, never followed.
        with tar.extractfile(f'{uuid}/device.plist') as stream:
            device = plistlib.load(stream)
        expected = manifest['identity']
        for key, value in [('UDID', uuid), ('name', expected['device']['name']),
                           ('deviceType', expected['device']['type']), ('runtime', expected['runtime']['identifier'])]:
            require(device.get(key) == value, f'archived device.plist mismatch: {key}')


def capture(output):
    started = time.monotonic()
    identity, folder, state = metadata(output)
    uuid = identity['device']['uuid']
    require(os.environ.get('IOS_SIMULATOR_ID') == uuid and state == 'Booted', 'boot helper selection mismatch')
    raw = run('xcrun', 'simctl', 'listapps', uuid)
    (output / 'apps.plist').write_bytes(raw)
    inventory(raw)
    run('xcrun', 'simctl', 'shutdown', uuid)
    deadline = time.monotonic() + 60
    while True:
        devices = json.loads(run('xcrun', 'simctl', 'list', 'devices', '--json'))
        device = next(d for ds in devices['devices'].values() for d in ds if d['udid'] == uuid)
        if device['state'] == 'Shutdown':
            break
        require(time.monotonic() < deadline, 'selected simulator did not shut down')
        time.sleep(1)  # Poll selected shutdown state; no warmup delay.
    write_json(output / 'shutdown.json', devices)
    original = sum(int(line.split()[0]) * 1024 for line in
                   run('du', '-sk', str(folder / 'device.plist'), str(folder / 'data')).decode().splitlines())
    require({p.name for p in folder.iterdir()} == {'device.plist', 'data'},
            'device folder has unexpected entries; refusing broader archive')
    archive = output / 'device.tar.gz'
    archive_started = time.monotonic()
    run('tar', '-czpf', str(archive), '-C', str(folder.parent),
        uuid, timeout=180)
    manifest = dict(schema=1, run={k: os.environ[k] for k in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')},
                    identity=identity, originalAllocatedBytes=original, compressedBytes=archive.stat().st_size,
                    sha256=sha256(archive),
                    bootToArchiveSeconds=time.time() - float(os.environ['IOS_PRISTINE_BOOT_STARTED']),
                    archiveSeconds=time.monotonic() - archive_started,
                    preparationSeconds=time.monotonic() - started)
    write_json(output / 'manifest.json', manifest)
    (output / 'device.sha256').write_text(f"{manifest['sha256']}  device.tar.gz\n")
    validate_archive(archive, manifest)


def restore(source, output):
    started = time.monotonic()
    manifest = json.loads((source / 'manifest.json').read_text())
    identity, folder, state = metadata(output)
    compare(manifest, identity)
    require(state == 'Shutdown', 'fresh registered device is not shut down')
    inventory((source / 'apps.plist').read_bytes())
    archive = source / 'device.tar.gz'
    validate_archive(archive, manifest)
    require((source / 'device.sha256').read_text() == f"{manifest['sha256']}  device.tar.gz\n", 'SHA256 receipt mismatch')
    staging = output / 'staging'
    staging.mkdir()
    run('tar', '-xzpf', str(archive), '-C', str(staging), timeout=180)
    backup = output / 'fresh-device-backup'
    require(not backup.exists(), 'fresh backup already exists')
    folder.rename(backup)
    # No device-set edits, UUID rewriting, service restart or cold fallback.
    # A failed move intentionally fails the candidate and retains its backup.
    (staging / identity['device']['uuid']).rename(folder)
    write_json(output / 'restore.json', dict(seconds=time.monotonic() - started, backup=str(backup), restored=str(folder)))


def main():
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_OS') == 'macOS',
            'native provisioning is restricted to GitHub macOS CI')
    require(os.environ.get('DEVELOPER_DIR') == '/Applications/Xcode_26.6.app/Contents/Developer', 'unexpected Xcode path')
    require(all(os.environ.get(k) for k in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')), 'missing run identity')
    mode, directory = sys.argv[1:]
    output = Path(directory)
    output.mkdir(parents=True, exist_ok=True)
    if mode == 'capture':
        capture(output)
    elif mode == 'restore':
        restore(Path(os.environ['RUNNER_TEMP']) / 'ios-pristine-baseline', output)
    else:
        raise RuntimeError('expected capture or restore')


if __name__ == '__main__':
    main()
