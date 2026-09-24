# Agent tools

A turn exposes only the tools declared for its work. Leitwerk distinguishes local
workspace operations, server-owned integrations, interactive questions, and terminal
outcomes.

| Category | Purpose | Ends the turn? |
| --- | --- | --- |
| Workspace primitives | Read and change files or run commands in the worker. | No. |
| Integration tools | Call an extension-owned external service through the server. | No. |
| `ask_questions` | Ask the operator structured questions. | No. |
| Outcome tools | Publish typed results and select the next route. | Yes. |

## Workspace primitives {#1-built-in-primitives}

An LLM turn opts into `read`, `bash`, `edit`, and `write` with `.tools(...)`:

```ts
flow.llm<Params, State>("implement")
  .description("Implement the change")
  .tools("read", "bash", "edit", "write")
  .buildPrompt((ctx) => ctx.params.prompt);
```

This and subsequent snippets show individual APIs, not complete processes. See
[Write your first process](first-process.md) for packaging and graph construction.

Grant only the required tools. Shell access is authority to execute commands, not
a read-only guarantee. Local execution has no container isolation. Ordinary tool
environments exclude worker IPC credentials and managed Git authentication settings.
They do not inherit the worker service's `NODE_ENV`; commands can set it explicitly.
See [security boundaries](security.md).

## Integration tools {#2-integration-tools}

Register tools in the owning extension's `setupServer`:

```ts
api.tool({
  name: "tracker_get_issue",
  description: "Read an external issue",
  parameters: {
    type: "object",
    properties: { issueKey: { type: "string" } },
    required: ["issueKey"],
  },
  execute: async (ctx, args) =>
    trackerClient.getIssue(args.issueKey, { signal: ctx.signal }),
});
```

A turn authorizes names with `.integrationTools(...)`. Names must be lowercase
snake case, globally unique, registered at startup, and distinct from Pi built-ins,
framework tools, and the turn's outcome tools. Workers receive names, descriptions,
and schemas; provider credentials stay on the server.

The server checks the current turn record, selected turn, project, and authorization
before dispatch. Reconnect replays the same invocation identity. Mutating tools must
use the [external-write contract](process-sdk.md#typed-external-writes); replay must
not duplicate provider writes.

When a turn stops, the server aborts `ctx.signal`. Pass it to cancellable provider
operations. A provider write already committed cannot be rolled back by cancellation.
Automatic turns and LLM preparation use `ctx.callIntegrationTool(name, args)` with
the same authorization, replay, and cancellation rules.

There is no fixed core integration catalog. Extensions own provider schemas,
authorization policy, response validation, and provider-specific behavior.

### Tool approvals

Approvals belong to the accepted turn record. Ending that turn cancels open approvals,
including when a worker exits without sending cancellation. Decisions for an older
attempt are rejected. Declining an approval aborts only its still-current process;
a stale decision cannot abort a concurrent retry.

A capability-marked ticket tool can create a reviewed draft process. Its enabled
capability must identify an existing process and entry turn at startup. Destinations
are server-resolved, and the final receipt must identify the remote ticket. See
[ticket adapters](process-sdk.md#ticket-creation-adapters).

## Interactive questions {#3-interactive-tools-ask_questions}

Enable `.askQuestions()` on an LLM turn to expose sequential `ask_questions` calls.
The agent supplies prepared options, recommendations, and explanations. The tool
returns `{ answers: string[] }` after the operator responds.

The request is a durable pause within the active turn. Answering resumes the same
context; it neither completes the turn nor starts a new attempt. See the
[operator guide](operator-guide.md#review-and-guide).

## Outcome tools {#4-terminal-outcome-tools}

An outcome tool finishes the LLM turn with typed parameters and a declared route:

```ts
flow.llm<Params, State>("verify_build")
  .description("Verify the build")
  .buildPrompt(() => "Check the build and report its outcome.")
  .tools("read", "bash")
  .outcomeTool("build_passing", (tool) =>
    tool.description("Build and tests pass").complete(),
  )
  .outcomeTool("build_failing", (tool) =>
    tool.description("Build or tests failed")
      .requiredString("summary", "Failure summary")
      .to("fix_build"),
  );
```

The surrounding process must define `fix_build`. Outcome tools are registered only
while their turn is active. After accepting an outcome, the worker records the
parameters and result, gives the agent a bounded terminal acknowledgement instruction,
and ends the turn. Successful execution then follows `.to(...)`, `.complete()`, or
the other declared route.

This agent acknowledgement is distinct from the server's durable
`worker.turn_terminal_recorded` acknowledgement. See
[turn publication](server-worker-lifecycle.md#5-start-acceptance-recovery-invariants).
