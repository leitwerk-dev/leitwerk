#!/usr/bin/env bash
set -euo pipefail

for reference in "$@"; do
  manifest="$(docker buildx imagetools inspect "$reference" --format '{{json .Manifest}}')"
  for architecture in amd64 arm64; do
    jq -e --arg architecture "$architecture" \
      'any(.manifests[]; .platform.os == "linux" and .platform.architecture == $architecture)' \
      <<<"$manifest" >/dev/null || {
        echo "$reference does not contain linux/$architecture" >&2
        exit 1
      }
    format="{{json (index .Image \"linux/$architecture\")}}"
    image="$(docker buildx imagetools inspect "$reference" --format "$format")"
    jq -e --arg revision "$RELEASE_GIT_SHA" --arg version "$RELEASE_VERSION" '
      .config.Labels["org.opencontainers.image.revision"] == $revision and
      .config.Labels["org.opencontainers.image.version"] == $version
    ' <<<"$image" >/dev/null || {
      echo "$reference linux/$architecture belongs to another release" >&2
      exit 1
    }
  done
done
