import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'check_pr_description', Path(__file__).resolve().parents[1] / 'ci' / 'check-pr-description.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

GOOD = """## Linear issue

Fixes PRI-12
Refs PRI-13

Acceptance: Tab moves to the next answer field on Mac.
Evidence: L2 recording of the desktop app on the Mac.
"""


class Description(unittest.TestCase):
    def test_complete_description_passes(self):
        self.assertEqual(check.problems(GOOD), [])

    def test_untouched_template_fails_every_rule(self):
        template = (Path(__file__).resolve().parents[2] / '.github' / 'pull_request_template.md').read_text()
        self.assertEqual(len(check.problems(template)), 3)

    def test_evidence_needs_a_level(self):
        body = GOOD.replace('Evidence: L2 recording', 'Evidence: installed on the iPad')
        self.assertEqual(len(check.problems(body)), 1)
        self.assertEqual(len(check.problems(GOOD.replace('L2 recording', 'L4 recording'))), 1)

    def test_only_closing_keywords_count(self):
        self.assertEqual(check.fixed_issues(GOOD + '\nCloses pri-7\n'), ['PRI-7', 'PRI-12'])

    def test_waiting_label_blocks_fixes(self):
        labels = {'PRI-12': ['Bug', 'Needs input']}
        found = check.label_problems(['PRI-12'], lambda issue: labels[issue])
        self.assertEqual(len(found), 1)
        self.assertIn('Refs PRI-12', found[0])
        self.assertEqual(check.label_problems(['PRI-12'], lambda issue: ['Bug']), [])


if __name__ == '__main__':
    unittest.main()
