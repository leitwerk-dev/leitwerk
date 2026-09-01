#!/usr/bin/env bash
set -euo pipefail

: "${LEITWERK_DOCKER_CONTEXT:?Set LEITWERK_DOCKER_CONTEXT to an explicitly selected disposable Docker context}"
if [[ "$LEITWERK_DOCKER_CONTEXT" == "default" ]]; then
  echo "Refusing to use the default Docker context" >&2
  exit 1
fi

for command_name in docker mktemp; do
  command -v "$command_name" >/dev/null || { echo "Missing command: $command_name" >&2; exit 1; }
done

docker_cmd=(docker --context "$LEITWERK_DOCKER_CONTEXT")
"${docker_cmd[@]}" info >/dev/null
work="$(mktemp -d)"
tag="leitwerk-local-docker-canary:$(date +%s)-$$"
cleanup() {
  "${docker_cmd[@]}" image rm -f "$tag" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
printf 'FROM alpine:3.21\nCMD ["sh", "-c", "test nested-local = nested-local"]\n' > "$work/Dockerfile"
"${docker_cmd[@]}" build -q -t "$tag" "$work" >/dev/null
"${docker_cmd[@]}" run --rm --pull=never "$tag"
echo "Local Docker runtime canary passed with context $LEITWERK_DOCKER_CONTEXT"
