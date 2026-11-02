#!/usr/bin/env bash
set -euo pipefail

directory="$(mktemp -d)"
trap 'rm -rf "$directory"' EXIT
mkdir "$directory/expected" "$directory/existing"
tar -xzf "$1" -C "$directory/expected"
tar -xzf "$2" -C "$directory/existing"
diff -ru "$directory/expected" "$directory/existing"
