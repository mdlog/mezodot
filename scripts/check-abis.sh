#!/usr/bin/env bash
# Fails when packages/sdk/src/abis differs from what `pnpm --filter @mezodot/sdk gen:abis` would generate from the
# current forge build, i.e. when contracts changed without regenerating (and committing) the SDK ABIs.
# Regenerates into a temporary directory, so the working tree is never touched.
#
#   forge build --root contracts && scripts/check-abis.sh        (or: pnpm check:abis)
#   FORGE_OUT=/tmp/out scripts/check-abis.sh                       (artifacts built with forge build --out /tmp/out)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${FORGE_OUT:-$ROOT/contracts/out}"
GEN="$ROOT/packages/sdk/scripts/gen-abis.mjs"
PRETTIER="$ROOT/node_modules/.bin/prettier"

[ -d "$OUT" ] || { echo "${OUT#"$ROOT"/} not found: run 'forge build --root contracts' first" >&2; exit 2; }
[ -x "$PRETTIER" ] || { echo "prettier not installed: run 'pnpm install' first" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# gen-abis.mjs resolves contracts/out and src/abis relative to its own location: mirror that layout.
mkdir -p "$TMP/packages/sdk/scripts" "$TMP/contracts"
cp "$GEN" "$TMP/packages/sdk/scripts/"
ln -s "$OUT" "$TMP/contracts/out"
node "$TMP/packages/sdk/scripts/gen-abis.mjs" >/dev/null
# The committed files are prettier-formatted (pnpm format); format the fresh ones the same way.
(cd "$TMP" && "$PRETTIER" --config "$ROOT/.prettierrc.json" --write packages/sdk/src/abis >/dev/null)

if diff -ru "$ROOT/packages/sdk/src/abis" "$TMP/packages/sdk/src/abis" >"$TMP/abis.diff"; then
  echo "SDK ABIs match the forge build ($(ls "$TMP/packages/sdk/src/abis" | wc -l | tr -d ' ') files)"
  exit 0
fi
echo "SDK ABIs are out of date with ${OUT#"$ROOT"/}. Regenerate and commit them with the contract change:" >&2
echo "  forge build --root contracts && pnpm --filter @mezodot/sdk gen:abis && pnpm exec prettier --write packages/sdk/src/abis" >&2
# "-" lines are the committed files, "+" lines what the current build generates.
sed "s|$TMP/|generated/|g; s|$ROOT/||g" "$TMP/abis.diff" | head -200 >&2
exit 1
