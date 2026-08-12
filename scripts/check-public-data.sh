#!/usr/bin/env bash
# Checks that no project-specific data is present in the public surface.
#
# Two layers:
#  - structural patterns, in this file: things that look like real data
#    without naming any (Figma file keys and node ids at production scale,
#    editor-generated layer names with large counters, home-directory paths,
#    oversized JSON, capture manifests without synthetic provenance)
#  - a denylist of known identifiers, kept OUTSIDE the repository: the list of
#    what must not appear is itself what must not appear, so it lives in a
#    private file and is read by path. Set FIGMA_IR_DENYLIST, or place it at
#    scripts/check-public-data.deny (gitignored). One extended regex per line;
#    blank lines and lines starting with # are ignored.
#
# Run against the working tree by default; --archive checks what
# `git archive HEAD` would actually publish, which is the surface that
# matters; --history scans every object reachable from any ref.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target="$root"
mode="${1:-tree}"

denyfile="${FIGMA_IR_DENYLIST:-$root/scripts/check-public-data.deny}"
DENY=''
if [ -f "$denyfile" ]; then
  DENY=$(grep -vE '^[[:space:]]*(#|$)' "$denyfile" | paste -sd '|' -)
fi

if [ "$mode" = "--archive" ]; then
  target=$(mktemp -d)
  trap 'rm -rf "$target"' EXIT
  git -C "$root" archive HEAD | tar -x -C "$target"
fi

# --history scans every object reachable from any ref. The working tree being
# clean says nothing about what a clone carries: deleted captures are still
# addressable in this repository's history, which is why publication means a
# clean root in a fresh repository. This mode is the proof that the fresh one
# really is fresh — run it there, expect silence.
if [ "$mode" = "--history" ]; then
  pattern='fixtures/|capture'
  [ -n "$DENY" ] && pattern="$pattern|$DENY"
  hits=$(git -C "$root" rev-list --objects --all | grep -iE "$pattern" || true)
  if [ -n "$hits" ]; then
    printf 'check-public-data: objects reachable in history:\n%s\n' "$hits" >&2
    echo 'check-public-data: FAILED (history)' >&2
    exit 1
  fi
  # A name is not the content: a blob at an innocent path can still hold a
  # key. Every tree reachable from any ref is grepped for the private list and
  # for anything shaped like a Figma file key, the guard itself excluded.
  content="api\.figma\.com/v1/files/[A-Za-z0-9]{20,}|fileKey\('[A-Za-z0-9]{20,}'\)"
  [ -n "$DENY" ] && content="$content|$DENY"
  # shellcheck disable=SC2046
  blobs=$(git -C "$root" grep -n -I -iE "$content" $(git -C "$root" rev-list --all) \
    -- . ':!scripts/check-public-data.sh' ':!scripts/check-public-data.deny' 2>/dev/null \
    | grep -v 'SYNTHETICFILEKEY' | cut -d: -f2 | sort -u || true)
  if [ -n "$blobs" ]; then
    printf 'check-public-data: content reachable in history (path, any commit):\n%s\n' "$blobs" >&2
    echo 'check-public-data: FAILED (history)' >&2
    exit 1
  fi
  echo 'check-public-data: clean (history)'
  exit 0
fi

fail=0
report() { printf 'check-public-data: %s\n' "$1" >&2; fail=1; }

scan() {
  # $1: pattern, $2...: extra grep args. Text files only; the guard and its
  # private list are excluded from their own scan.
  grep -RInE "$1" "$target" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude=check-public-data.sh --exclude=check-public-data.deny \
    "${@:2}" 2>/dev/null || true
}

# --- Layer 1: known identifiers (private list) -----------------------------
if [ -n "$DENY" ]; then
  hits=$(scan "$DENY")
  if [ -n "$hits" ]; then
    report "known project identifiers found:"
    printf '%s\n' "$hits" | head -20 >&2
  fi
else
  echo 'check-public-data: no denylist configured (structural checks only)' >&2
fi

# --- Layer 2: structure ----------------------------------------------------
# A fixtures/ entry must declare itself synthetic. A capture of a real file
# has a manifest with a fileKey; a synthetic fixture declares provenance.
if [ -d "$target/fixtures" ]; then
  for manifest in "$target"/fixtures/*/manifest.json; do
    [ -e "$manifest" ] || continue
    if ! grep -q '"provenance"[[:space:]]*:[[:space:]]*"synthetic"' "$manifest"; then
      report "fixture without synthetic provenance: ${manifest#"$target"/}"
    fi
  done
  # Real captures are large; synthetic witnesses are not. Size is a tripwire,
  # not a rule — an oversized synthetic fixture needs an explicit look.
  big=$(find "$target/fixtures" -type f -size +100k 2>/dev/null || true)
  if [ -n "$big" ]; then
    report "oversized files under fixtures/ (real captures are large, witnesses are not):"
    printf '%s\n' "$big" >&2
  fi
fi

# Figma file keys are 20+ mixed-case alphanumerics. Two contexts count: a full
# API URL anywhere, and a fileKey(...) literal in source. The synthetic key the
# tests use is allowed by name, which keeps the check honest — anything else
# that looks like a real key needs a reason to be here.
# ERE has no lookahead, so match broadly and subtract the allowed synthetic
# key in a second pass — a pattern that silently fails to compile is worse
# than a plain one, and this exact mistake made the check pass a planted key.
keyhits=$(scan "api\.figma\.com/v1/files/[A-Za-z0-9]{20,}|fileKey\('[A-Za-z0-9]{20,}'\)" \
  --include='*.ts' --include='*.js' --include='*.md' --include='*.json' --include='*.yaml' --include='*.yml' --include='*.sh' \
  | grep -v 'SYNTHETICFILEKEY' || true)
if [ -n "$keyhits" ]; then
  report "literal Figma file keys found:"
  printf '%s\n' "$keyhits" | head -10 >&2
fi

# Node ids in a production file run to thousands on both sides of the colon
# ("4554:59216"); synthetic ones stay small ("1:2"). Editor-generated layer
# names carry the same tell ("Frame 629858"). Either one in the tree is a
# value copied from a real file, whatever the surrounding prose says.
idhits=$(scan '(^|[^A-Za-z0-9])[0-9]{3,}:[0-9]{3,}([^0-9]|$)|(Frame|Group|Vector|Rectangle|Ellipse|Line|Component|Instance) [0-9]{4,}' \
  --include='*.ts' --include='*.js' --include='*.md' --include='*.json' --include='*.yaml' --include='*.yml')
if [ -n "$idhits" ]; then
  report "node ids or layer names at production scale (copied from a real file?):"
  printf '%s\n' "$idhits" | head -10 >&2
fi

# A path under someone's home directory names a machine, a user, or a private
# checkout. Nothing published should need one.
pathhits=$(scan '(/Users/[A-Za-z]|/home/[a-z]|[A-Za-z]:\\Users\\|~/[A-Za-z.])' \
  --include='*.ts' --include='*.js' --include='*.md' --include='*.json' --include='*.yaml' --include='*.yml' --include='*.sh')
if [ -n "$pathhits" ]; then
  report "home-directory paths found:"
  printf '%s\n' "$pathhits" | head -10 >&2
fi

# A real capture is a large JSON wherever it sits; fixtures/ is merely where
# one used to live. Any tracked JSON over 100k needs an explicit look.
bigjson=$(find "$target" -name '*.json' -size +100k \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' 2>/dev/null || true)
if [ -n "$bigjson" ]; then
  report "oversized JSON outside any allowlist (real captures are large):"
  printf '%s\n' "$bigjson" >&2
fi

if [ "$fail" -ne 0 ]; then
  echo 'check-public-data: FAILED' >&2
  exit 1
fi
echo "check-public-data: clean ($mode)"
