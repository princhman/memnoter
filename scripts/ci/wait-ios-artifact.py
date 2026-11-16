#!/usr/bin/env python3
"""Wait for this run's producer or bundle; never allocate a Mac runner here."""
import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request


def log(message):
    print(f"{datetime.datetime.now(datetime.timezone.utc).isoformat()} {message}", flush=True)


def wait(timeout, producer_started=False):
    api = os.environ['GITHUB_API_URL'].rstrip('/')
    repo = os.environ['GITHUB_REPOSITORY']
    run = os.environ['GITHUB_RUN_ID']
    token = os.environ['GH_TOKEN']
    deadline = time.monotonic() + timeout
    base = f'{api}/repos/{repo}/actions/runs/{run}'

    def get(url):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Artifact deadline exceeded')
        request = urllib.request.Request(url, headers={
            'Authorization': f'Bearer {token}',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        })
        try:
            with urllib.request.urlopen(request, timeout=min(10, remaining)) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Do not print response bodies, URLs or credentials.
            status = error.code
            error.close()
            raise RuntimeError(f'GitHub API HTTP {status}') from None
        except (OSError, ValueError):
            raise RuntimeError('GitHub API request failed') from None

    def pages(url, key):
        page = 1
        while True:
            items = get(f'{url}?per_page=100&page={page}')[key]
            yield from items
            if len(items) < 100:
                return
            page += 1

    target = 'ios-build runner allocation' if producer_started else 'ios-test-bundle'
    log(f'Waiting up to {timeout:g}s for {target} (run {run})')
    # Four consumers share a read-only token's API quota during long builds.
    interval = 2
    while True:
        producer = next((job for job in pages(f'{base}/jobs', 'jobs')
                         if job['name'] == 'ios-build'), None)
        if producer and producer['status'] == 'completed' and producer['conclusion'] != 'success':
            raise RuntimeError(f"ios-build ended with {producer['conclusion']}")
        if producer_started and producer and producer['status'] in ('in_progress', 'completed'):
            log(f"ios-build has a runner or already succeeded ({producer['status']})")
            return
        if not producer_started:
            for artifact in pages(f'{base}/artifacts', 'artifacts'):
                if artifact['name'] != 'ios-test-bundle':
                    continue
                if str(artifact['workflow_run']['id']) != run:
                    raise RuntimeError('Artifact belongs to another workflow run')
                if artifact['expired']:
                    raise RuntimeError('ios-test-bundle has expired')
                with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                    output.write(f"artifact-id={int(artifact['id'])}\n")
                log(f"ios-test-bundle ready (artifact {artifact['id']}); producer status {producer['status'] if producer else 'pending'}")
                return
            if producer and producer['status'] == 'completed':
                raise RuntimeError('ios-build succeeded without ios-test-bundle')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Artifact deadline exceeded')
        time.sleep(min(interval, remaining))
        interval = min(30, interval * 2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('timeout', type=float, nargs='?', default=2400)
    parser.add_argument('--producer-started', action='store_true')
    args = parser.parse_args()
    try:
        wait(args.timeout, args.producer_started)
    except (RuntimeError, KeyError, ValueError) as error:
        # Schema errors name only the missing field, never the API payload.
        print(f'Artifact handoff failed: {error}', file=sys.stderr)
        sys.exit(1)
