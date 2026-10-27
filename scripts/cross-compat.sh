#!/bin/sh
# Check that this TypeScript Ponte interoperates with the Python implementation
# (Ponte 0.1), which lives only in git history.
#
# It extracts that commit into a temp dir, installs it in a venv (uv if
# available, else python3 -m venv), runs its own test suite as a sanity check,
# then runs test/cross/*.test.js against it: crypto and invites both ways,
# a Python host with a TypeScript guest, a TypeScript host with a Python guest.
#
#   npm run test:cross            (builds first)
#   PONTE_PY_REF=<commit> sh scripts/cross-compat.sh
#
# In CI the checkout needs the history (actions/checkout with fetch-depth: 0);
# otherwise the commit is fetched from origin.

set -eu

REF="${PONTE_PY_REF:-6f0eb800cb243e12a96bde38be33b635767bdcc2}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ponte-cross.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

if ! git -C "$ROOT" cat-file -e "$REF^{commit}" 2>/dev/null; then
  echo "fetching $REF from origin"
  git -C "$ROOT" fetch --quiet --depth=1 origin "$REF"
fi

mkdir "$WORK/py"
git -C "$ROOT" archive "$REF" | tar -x -C "$WORK/py"

if command -v uv >/dev/null 2>&1; then
  uv venv --quiet "$WORK/venv"
  uv pip install --quiet --python "$WORK/venv/bin/python" -e "$WORK/py[dev]"
else
  python3 -m venv "$WORK/venv"
  "$WORK/venv/bin/pip" install --quiet -e "$WORK/py[dev]"
fi

echo "== Python reference ($REF): its own tests"
(cd "$WORK/py" && "$WORK/venv/bin/python" -m pytest -q -p no:cacheprovider)

echo "== cross-compatibility tests"
cd "$ROOT"
PONTE_PYTHON="$WORK/venv/bin/python" node --test --test-concurrency=1 --test-timeout=120000 test/cross/*.test.js
