# Local Shell Extension

`@leitwerk-dev/local-shell` provides `local_shell_process`, a no-LLM process for running trusted shell commands on the local leitwerk server machine.

## Safety model

This extension executes operator-provided commands with the same OS permissions as the leitwerk server process. Load it only in trusted local/operator environments. It is not sandboxed and is not intended for untrusted multi-user deployments.

Commands are trusted operator side effects, not idempotent automation. If the server dies mid-command, the interrupted command turn is failed during reconciliation instead of being replayed automatically. Active command process-group metadata is persisted in a per-user temp registry so a later server start can send a best-effort `SIGKILL` to stale local-shell commands before background reconciliation; this cannot protect against every OS-level hard-failure scenario.

## Loading the extension

Add the extension source to the local config that should expose the launcher:

```yaml
extension_loading:
  sources:
    - ./extensions/local-shell
```

The extension currently has no `extensions.local-shell` config block. Loading it is enough to expose the `Local Shell` UI launcher.

## Process graph

```text
open_shell  [server_automatic/active]
  ├─ opened      -> command_console
  └─ run_initial -> execute_command

command_console  [human/waiting]
  ├─ run_command  -> execute_command
  └─ close_shell  -> completed

execute_command  [server_automatic/active]
  ├─ command_finished -> command_console
  ├─ command_timed_out -> command_console
  └─ runner_error     -> command_console
```

No LLM turn is declared. The open and command execution turns are `server_automatic`, so they run in the server process and do not start a worker or Pi session.

## Operator flow

1. Launch `Local Shell` from the UI.
2. Optionally provide a default working directory, an initial command, and a default command timeout.
3. The process starts on `open_shell`, which routes to `execute_command` when an initial command is present or to `command_console` otherwise.
4. Use `Run command` to execute additional commands for as long as desired. Commands use the launcher default timeout unless the action supplies a per-command override.
5. Each command result is recorded as turn-result markdown, then the process returns to `command_console`.
6. Finish with `Close shell`, or abort/cancel the process.

## Command semantics

- Commands run as non-interactive `bash -lc <command>` on the leitwerk server machine.
- Each action runs one command. This is not a persistent PTY/shell session.
- `cd <dir>` inside a command does not affect later commands. Use the action's `Working directory` field to change the process default cwd.
- Non-zero exit codes are normal `command_finished` results, not process errors.
- The launcher timeout is the default for all commands in the shell; the `Run command` action can override it for one command.
- Timeouts are normal `command_timed_out` results.
- Runner setup failures and operator aborts produce `runner_error` outcomes.
- Command text is length-limited before it is stored in process state or result markdown.
- Stdout and stderr are capped to retained tails before being stored in markdown.

Command result markdown includes:

- command text
- cwd
- outcome
- exit code or signal
- duration and timeout
- retained stdout
- retained stderr

Metadata values are rendered as inline code with control characters escaped; command text and captured output are fenced blocks.

## State model

Large command output is not stored in process state. It is stored on the durable turn record as markdown. When controlled through Telegram, submitted command details and the resulting command-output markdown are posted in the process topic before the next command prompt.

State tracks only:

- `pendingCommand` while `execute_command` is selected
- `defaultCwd`
- `nextSequence`

## Abort behavior

The process cleanup hook aborts any active command for the process before the abort is committed. Late command outcomes are rejected by normal selected-turn / turn-record stale correlation. The extension also registers a server stop hook that aborts active local-shell commands during normal server shutdown, and a process-exit guard sends a best-effort kill to any still-active command process groups.

## Tests

Unit coverage lives in:

- `src/process-definition.test.ts`

Integration coverage lives in:

- `src/command-runner.integration.test.ts`
- `src/process-definition.integration.test.ts`

The integration tests use real local commands for command-runner behavior and avoid string change-detector assertions for operator-facing prose.
