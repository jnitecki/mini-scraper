#!/usr/bin/env bash
# Computes the image version and prints it to stdout.
#
# major.minor are taken from the nearest reachable vMAJOR.MINOR.PATCH tag.
# - Clean tree, HEAD exactly on that tag: use the tag as-is.
# - Clean tree, HEAD past that tag: PATCH is bumped by the commit count since the tag.
# - Dirty tree (staged or unstaged tracked changes): same as above, but the
#   revision becomes "devN" where N is the next revision after the one computed.
# - No matching tag reachable yet: baseline v0.1.0, revision counted from all commits.
set -euo pipefail

git fetch --tags --force >/dev/null 2>&1 || true

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  DIRTY=true
else
  DIRTY=false
fi

if DESCRIBE=$(git describe --tags --long --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null); then
  TAG=$(echo "$DESCRIBE" | sed -E 's/^(.*)-([0-9]+)-g[0-9a-f]+$/\1/')
  COMMITS_SINCE=$(echo "$DESCRIBE" | sed -E 's/^(.*)-([0-9]+)-g[0-9a-f]+$/\2/')
  MAJOR=$(echo "$TAG" | sed -E 's/^v([0-9]+)\.([0-9]+)\.([0-9]+)$/\1/')
  MINOR=$(echo "$TAG" | sed -E 's/^v([0-9]+)\.([0-9]+)\.([0-9]+)$/\2/')
  PATCH=$(echo "$TAG" | sed -E 's/^v([0-9]+)\.([0-9]+)\.([0-9]+)$/\3/')
else
  MAJOR=0
  MINOR=1
  PATCH=0
  COMMITS_SINCE=$(git rev-list --count HEAD)
fi

REVISION=$((PATCH + COMMITS_SINCE))

if [ "$DIRTY" = "true" ]; then
  NEXT=$((REVISION + 1))
  VERSION="v${MAJOR}.${MINOR}.dev${NEXT}"
elif [ "$COMMITS_SINCE" -eq 0 ]; then
  VERSION="v${MAJOR}.${MINOR}.${PATCH}"
else
  VERSION="v${MAJOR}.${MINOR}.${REVISION}"
fi

echo "$VERSION"
