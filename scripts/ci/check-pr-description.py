#!/usr/bin/env python3
"""Check a PR description against the template rules in AGENTS.md.

Reads the body from PR_BODY. With LINEAR_API_KEY set, it also refuses
`Fixes PRI-n` for an issue still labelled as waiting on investigation or input,
because merging would close it.
"""
import json
import os
import re
import sys
import urllib.request

BLOCKING_LABELS = {'needs investigation', 'needs input'}
FIXES = re.compile(r'\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+(PRI-\d+)\b', re.IGNORECASE)


def strip_comments(body):
    return re.sub(r'<!--.*?-->', '', body, flags=re.DOTALL)


def problems(body):
    body = strip_comments(body)
    found = []
    acceptance = re.search(r'^Acceptance:[ \t]*(\S.*)$', body, re.MULTILINE)
    if not acceptance:
        found.append('Missing "Acceptance:" line: the outcome this PR delivers, '
                     'from the issue\'s "Done means" or the user\'s words.')
    evidence = re.search(r'^Evidence:[ \t]*(\S.*)$', body, re.MULTILINE)
    if not evidence or not re.match(r'L[1-4]\b', evidence.group(1)):
        found.append('Missing "Evidence: L<1-4> ..." line: the level reached and on which '
                     'platform (see "Evidence" in AGENTS.md).')
    if re.search(r'^Fixes PRI-\s*$', body, re.MULTILINE):
        found.append('The template\'s empty "Fixes PRI-" line is still there: fill it in or delete it.')
    return found


def fixed_issues(body):
    return sorted(set(m.upper() for m in FIXES.findall(strip_comments(body))), key=lambda i: int(i[4:]))


def linear_labels(issue, key):
    query = 'query($id: String!) { issue(id: $id) { labels { nodes { name } } } }'
    request = urllib.request.Request(
        'https://api.linear.app/graphql',
        data=json.dumps({'query': query, 'variables': {'id': issue}}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': key})
    with urllib.request.urlopen(request, timeout=15) as response:
        data = json.load(response)
    node = (data.get('data') or {}).get('issue')
    if node is None:
        raise LookupError(f'{issue} not found in Linear')
    return [label['name'] for label in node['labels']['nodes']]


def label_problems(issues, labels_of):
    found = []
    for issue in issues:
        blocking = [l for l in labels_of(issue) if l.lower() in BLOCKING_LABELS]
        if blocking:
            found.append(f'{issue} is labelled {", ".join(blocking)}, so merging must not close it. '
                         f'Write "Refs {issue}" instead, or remove the label once it is resolved.')
    return found


def main():
    body = os.environ.get('PR_BODY', '')
    found = problems(body)
    issues = fixed_issues(body)
    key = os.environ.get('LINEAR_API_KEY')
    if issues and key:
        found += label_problems(issues, lambda issue: linear_labels(issue, key))
    elif issues:
        print('LINEAR_API_KEY is not set; skipped the label check for ' + ', '.join(issues))
    for problem in found:
        print('::error::' + problem)
    if found:
        sys.exit(1)
    print('PR description OK')


if __name__ == '__main__':
    main()
