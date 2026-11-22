#!/usr/bin/env bash
# Tag a release with its notes: scripts/tag-release.sh v1.2.3 notes.md
# The tag message becomes the GitHub and Linear release notes (release.yml
# refuses a tag without them). Run on the merged release commit on main.
set -euo pipefail
tag=${1:?usage: scripts/tag-release.sh v1.2.3 notes.md}
notes=${2:?usage: scripts/tag-release.sh v1.2.3 notes.md}
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Tag must look like v1.2.3" >&2; exit 1; }
[[ -n "$(tr -d '[:space:]' < "$notes")" ]] || { echo "$notes is empty" >&2; exit 1; }
version=$(node -p "require('./package.json').version")
[[ "${tag#v}" == "$version" ]] || { echo "package.json is $version, not ${tag#v}" >&2; exit 1; }
# verbatim: the default cleanup drops Markdown "## Heading" lines as comments.
{ printf 'Memnoter %s\n\n' "$tag"; cat "$notes"; } | git tag -a --cleanup=verbatim "$tag" -F -
git for-each-ref --format='%(contents:body)' "refs/tags/$tag"
git push origin "refs/tags/$tag"
