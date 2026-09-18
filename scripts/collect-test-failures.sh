#!/usr/bin/env bash
# Repeat the full validation gate until ten failed runs have been collected.
set -euo pipefail

usage() {
  echo "Usage: bash scripts/collect-test-failures.sh [--max-runs N] [--log-dir DIRECTORY]"
  echo "Default: collect 10 failed runs; create logs under TMPDIR. Passing runs do not count."
  echo "Exit: 0 collected 10 failures, 1 run limit reached, 2 usage/setup error, 130/143 interrupted."
}

max_runs=0
log_root="${TMPDIR:-/tmp}"
while (( $# )); do
  case "$1" in
    --max-runs)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ && ${#2} -le 9 ]] || { usage >&2; exit 2; }
      max_runs="$2"; shift 2 ;;
    --log-dir)
      [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }
      log_root="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

mkdir -p "$log_root" || exit 2
log_root="$(cd "$log_root" && pwd)" || exit 2
logs="$(mktemp -d "$log_root/leitwerk-failure-loop.XXXXXX")" || exit 2
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
printf 'Logs: %s\n' "$logs"
printf 'run\tstarted_utc\tduration_seconds\texit_code\tresult\n' > "$logs/summary.tsv"

# Match diagnostic error wording, not configuration names such as startup_timeout.
pattern='timed out|ETIMEDOUT|TimeoutError|Test timeout|Hook timeout|Timeout of [0-9]+ms exceeded'
run=0
failures=0
while (( max_runs == 0 || run < max_runs )); do
  run=$((run + 1))
  log="$logs/run-$(printf '%04d' "$run").log"
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  start_seconds=$SECONDS
  printf 'Run %s started at %s: %s\n' "$run" "$started" "$log"
  status=0
  npm run test:full > "$log" 2>&1 || status=$?
  duration=$((SECONDS - start_seconds))
  result=passed
  if (( status == 130 || status == 143 )); then
    result=interrupted
  elif (( status != 0 )); then
    failures=$((failures + 1))
    if grep -Ein "$pattern" "$log" > "$logs/run-$(printf '%04d' "$run").timeout-matches.txt"; then
      result=timeout
    else
      result=other_failure
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$run" "$started" "$duration" "$status" "$result" >> "$logs/summary.tsv"
  printf 'Run %s: %s (%ss, exit %s); failed runs: %s/10\n' "$run" "$result" "$duration" "$status" "$failures"
  if [[ "$result" == interrupted ]]; then exit "$status"; fi
  if (( failures == 10 )); then
    printf 'Collected 10 failed runs. Logs and summary: %s\n' "$logs"
    exit 0
  fi
done
printf 'Run limit reached with %s/10 failed runs. Logs: %s\n' "$failures" "$logs"
exit 1
