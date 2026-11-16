"""Exercise the handoff's API boundary without contacting GitHub."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location(
    'handoff', Path(__file__).resolve().parents[1] / 'ci/wait-ios-artifact.py')
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


def artifact():
    return dict(name='ios-test-bundle', id=42, workflow_run={'id': 123}, expired=False)


def producer(conclusion=None):
    return {'name': 'ios-build', 'status': 'completed' if conclusion else 'in_progress',
            'conclusion': conclusion}


class HandoffTests(unittest.TestCase):
    def run_wait(self, responses, timeout=30):
        """A fake HTTP transport and clock; production owns all polling decisions."""
        clock = [0]
        requests = []
        pending = iter(responses)

        def get(request, timeout):
            requests.append(request.full_url)
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 10)
            self.assertEqual(request.get_header('Authorization'), 'Bearer private-token')
            expected, body = next(pending)
            self.assertTrue(request.full_url.endswith(expected), request.full_url)
            if isinstance(body, Exception):
                raise body
            return io.StringIO(json.dumps(body))

        def sleep(seconds):
            clock[0] += seconds

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            env = {'GITHUB_API_URL': 'https://api.example', 'GITHUB_REPOSITORY': 'owner/repo',
                   'GITHUB_RUN_ID': '123',
                   'GH_TOKEN': 'private-token', 'GITHUB_OUTPUT': str(output)}
            with patch.dict(os.environ, env), patch.object(handoff.urllib.request, 'urlopen', get), \
                    patch.object(handoff.time, 'monotonic', lambda: clock[0]), \
                    patch.object(handoff.time, 'sleep', sleep), contextlib.redirect_stdout(io.StringIO()):
                handoff.wait(timeout)
            return output.read_text(), requests

    def jobs(self, conclusion=None):
        return ('/jobs?per_page=100&page=1', {'jobs': [producer(conclusion)]})

    def artifacts(self, items):
        return ('/artifacts?per_page=100&page=1', {'artifacts': items})

    def test_waits_then_accepts_publication_before_producer_finishes(self):
        output, requests = self.run_wait([
            self.jobs(), self.artifacts([]),
            self.jobs(), self.artifacts([artifact()]),
        ])
        self.assertEqual(output, 'artifact-id=42\n')
        self.assertTrue(all('/repos/owner/repo/actions/runs/123/' in url for url in requests))

    def test_failure_and_cancellation_stop_without_waiting_for_artifact(self):
        for conclusion in ['failure', 'cancelled', 'skipped', 'timed_out']:
            with self.subTest(conclusion=conclusion), self.assertRaisesRegex(RuntimeError, conclusion):
                self.run_wait([self.jobs(conclusion)])

    def test_success_without_artifact_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'without ios-test-bundle'):
            self.run_wait([self.jobs('success'), self.artifacts([])])

    def test_expired_and_wrong_run_artifacts_fail(self):
        for field, value, message in [('expired', True, 'expired'),
                                       ('workflow_run', {'id': 999}, 'another workflow run')]:
            item = artifact()
            item[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, message):
                self.run_wait([self.jobs(), self.artifacts([item])])

    def test_missing_producer_and_artifact_are_bounded(self):
        for jobs in [[], [producer()]]:
            with self.subTest(jobs=jobs), self.assertRaisesRegex(RuntimeError, 'deadline'):
                self.run_wait([('/jobs?per_page=100&page=1', {'jobs': jobs}),
                               self.artifacts([])], timeout=1)

    def test_auth_and_transport_failures_fail_closed_without_payload(self):
        for error, message in [
            (urllib.error.HTTPError('url', 403, 'private-token', {}, io.BytesIO()), 'HTTP 403'),
            (urllib.error.URLError('private-token'), 'request failed'),
            (TimeoutError('private-token'), 'request failed'),
        ]:
            with self.subTest(error=type(error).__name__), self.assertRaisesRegex(RuntimeError, message) as raised:
                self.run_wait([('/jobs?per_page=100&page=1', error)])
            self.assertNotIn('private-token', str(raised.exception))

    def test_pagination_finds_producer_and_bundle_beyond_first_page(self):
        other_jobs = [{'name': 'other'}] * 100
        other_artifacts = [{'name': 'other'}] * 100
        output, _ = self.run_wait([
            ('/jobs?per_page=100&page=1', {'jobs': other_jobs}),
            ('/jobs?per_page=100&page=2', {'jobs': [producer()]}),
            self.artifacts(other_artifacts),
            ('/artifacts?per_page=100&page=2', {'artifacts': [artifact()]}),
        ])
        self.assertEqual(output, 'artifact-id=42\n')
