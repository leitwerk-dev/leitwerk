# Local validation

Use a recorded pass only for its exact SHA. Check the recorded command, Node version, platform, and time against the current validation conditions; changed code or conditions require a new run. Hosted checks remain separate evidence.

For a clean checkout, run:

```bash
npm run review:stack -- validate
```

Add `--checkout /path/to/clone` to select another clone. This runs `npm run test:full` and stores the command, SHA, environment, times, and result under the Git directory at `stack-review/validations/<sha>.json`. Every invocation runs the full gate.

Account for every dirty file under the maintainer's instructions before recording a commit result. If the task calls for keeping edits uncommitted, run `npm run test:full` directly and report a working-tree result; it cannot establish a pass for the unchanged HEAD.

A changed HEAD or dirty checkout after the run invalidates the record. Interrupted runs remain `running`; failed and invalidated records are not passes. Existing plain-text logs are not imported automatically.

**Complete when:** the result names the validated local SHA or uncommitted working tree, its status, and any failure. When a PR exists, refresh the stack report and match the result to its head; identify an unpublished local commit explicitly.
