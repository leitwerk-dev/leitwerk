# Pi session transfer for Leitwerk

Copy a retained Leitwerk process workspace and its primary Pi conversation into local Pi.
The import keeps the conversation tree and workspace files. Future turns use the local Pi
installation's models, credentials, extensions, skills, and tools.

## Install

```bash
pi install npm:@leitwerk-dev/pi-session-transfer
```

Update or remove it through Pi:

```bash
pi update npm:@leitwerk-dev/pi-session-transfer
pi remove npm:@leitwerk-dev/pi-session-transfer
```

## Use

Create a link from **More actions → Create local transfer link** in Leitwerk. Then run in
interactive Pi:

```text
/leitwerk-transfer https://leitwerk.example/api/session-transfers/agt_…/trg_…#token=…
```

With no argument, the command asks for the link. It defaults the new destination to
`<current-directory>/<process-instance-id>`. The destination must not exist.

The link is a bearer credential. Do not paste it into logs, tickets, or chat. Confirm the exact
Leitwerk origin shown by Pi before claiming it. A transfer must start within one hour. Press
`Esc` before the final local commit to cancel; the link can be explicitly retried while its grant
remains valid.

## What is copied

The transfer contains:

- the complete portable process workspace, including nested Git directories, index and dirty
  state, untracked and ignored files, executable bits, timestamps, and safe relative symlinks;
- the primary Pi JSONL conversation tree.

The transfer excludes Pi agent state, provider and repository credentials, dependency and mise
caches outside the workspace, private Docker state, temporary process state, and all unrelated
process-volume paths. Ownership, ACLs, extended attributes, devices, sockets, FIFOs, and hard-link
identity are not preserved.

The importer accepts Pi session format V3 only. It verifies the compressed stream digest and byte
count, validates Git branch and HEAD evidence, rewrites only the session cwd, removes source
`parentSession` metadata, places the validated JSONL in Pi's normal session store without running
Pi migration code, and then offers to switch to it.

Each import uses one mode-0600 recovery record. The record transitions atomically from temporary
import state to a token-free completion receipt. Pi removes only stale incomplete paths that still
carry the matching ownership marker. Completed records let acknowledgement and session switching
be retried safely.

V1 supports interactive TUI mode only.
