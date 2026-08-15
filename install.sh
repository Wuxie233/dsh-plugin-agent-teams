#!/usr/bin/env bash
# Deploy this fork into the dsh profiles' shared node_modules (copy, never
# symlink: Node ESM resolves symlinks to real paths and then fails to resolve
# @deepseek-ai/* peers from the profile). Source of truth is this repo; the
# runtime copy is disposable — re-run after a dsh upgrade or profile heal.
# After deploying: restart dsh web (host half) and refresh the page (client half).
set -euo pipefail
cd "$(dirname "$0")"
name=$(node -p "require('./package.json').name")
target="${DSH_HOME:-$HOME/.dsh}/profiles/node_modules/$name"
rm -rf "$target"
mkdir -p "$target"
cp -r package.json lib assets "$target/"
echo "deployed: $name -> $target"
