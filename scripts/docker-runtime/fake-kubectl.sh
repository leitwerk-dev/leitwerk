#!/bin/bash
# Test-only protocol fixture. Keep each kubectl invocation free of Node startup.
set -euo pipefail
root="${CANARY_FIXTURE_ROOT:?}"
generation=0
live=false
marker=''
if [[ -f "$root/state" ]]; then read -r generation live marker < "$root/state"; fi
persist() { printf '%s %s %s\n' "$generation" "$live" "$marker" > "$root/state"; }
has() { local arg; for arg in "${args[@]}"; do [[ "$arg" != "$1" ]] || return 0; done; return 1; }
args=("$@")
input=''
if has apply || has build; then IFS= read -r -d '' input || true; fi
# NUL framing preserves multiline manifests and command arguments without JSON encoding.
printf 'start\0%s\0%s\0' "$$" "$#" >> "$root/calls"
printf '%s\0' "$@" "$input" >> "$root/calls"
trap 'printf "exit\0%s\0%s\0" "$$" "$?" >> "$root/calls"' EXIT
if has create; then persist
elif has apply; then
  if [[ "$input" == *'kind: Pod'* ]]; then
    [[ "$live" == false ]] || { echo 'Replacement started before deletion' >&2; exit 1; }
    generation=$((generation + 1)); live=true; persist
  fi
elif has delete; then
  if has pod; then live=false; persist; fi
elif has wait; then
  if has --for=delete && [[ "$live" == true ]]; then echo 'Pod still exists' >&2; exit 1; fi
elif has get; then
  if has pod; then cat "$root/pod-$generation.json"
  elif has pvc; then
    if [[ "$*" == *jsonpath=* ]]; then echo pv-a; else cat "$root/pvc-$generation.json"; fi
  elif has pv; then cat "$root/pv-$generation.json"
  else echo 'Unexpected get' >&2; exit 1
  fi
elif has exec; then
  if has docker && has info; then
    if has '{{.Driver}}'; then echo overlay2
    else echo '{"Driver":"overlay2","DockerRootDir":"/state/tooling/docker","ServerVersion":"example-version"}'; fi
  elif has docker && has inspect; then printf 'sha256:%064d\n' 0 | tr 0 a
  elif has node && [[ "$*" == *randomUUID* ]]; then marker=retained-workspace; persist
  elif has node; then echo '[8080]'
  elif has cat; then echo "$marker"
  fi
else echo "Unexpected kubectl call: $*" >&2; exit 1
fi
