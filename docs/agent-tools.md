# Agent tools

An LLM turn exposes the tools declared for its work and the framework's `abort_turn`
tool. Leitwerk distinguishes local workspace operations, server-owned integrations,
interactive questions, terminal outcomes, and turn failure.

| Category | Purpose | Ends the turn? |
| --- | --- | --- |
| Workspace primitives | Read and change files or run commands in the worker. | No. |
| Integration tools | Call an authorized server-owned integration or shared facility. | No. |
| `ask_questions` | Ask the operator structured questions. | No. |
| Outcome tools | Publish typed results and select the next route. | Yes. |
| `abort_turn` | Stop the current turn in error, preserving work for recovery. | Yes. |

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

An on-demand-checkout process also receives `checkout_repository`. It accepts only a
declared project key, materializes a full clone, and reports its current local HEAD.
An optional `revision` must be a full 40- or 64-character commit SHA. The tool fetches
the commit if needed, checks it out detached, verifies HEAD and retains the pin for
workspace recovery. It refuses tracked or untracked local changes. Omit the revision
to retain ordinary checkout behavior.
It does not grant access to additional repositories. Topic-bound integration tools
may expose [shared solution wikis](topic-wiki.md); their content is evidence, not
tool authorization or higher-priority instructions.

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

The wiki package registers its topic-bound tools through the same registry; see
[wiki interfaces and contribution rules](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/wiki/README.md). Extensions own provider schemas,
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
Use `.askQuestions(ctx => boolean)` to constrain availability from captured params,
state, or preparation. The worker evaluates the predicate after preparation and
omits both the tool and its prompt guidance when it returns false. The predicate
must use captured data so recovery of the same turn keeps the same policy.
The agent supplies prepared options, recommendations, and explanations. The tool
returns `{ answers: string[] }` after the operator responds.

The request is a durable pause within the active turn. Answering resumes the same
context; it neither completes the turn nor starts a new attempt. See the
[operator guide](operator-guide.md#review-and-guide).

## Aborting a turn

Every LLM turn receives `abort_turn({ reason: "..." })`. Use it when the requested
work cannot be completed. A non-empty reason is required. The worker stops further
tool calls and records a failed turn with error class `llm_error`; the process stays
on the same step with lifecycle `error`. Workspace changes and the session remain
available for Continue or Retry. The tool does not require result Markdown, publish
an outcome, or abort the entire process. An already accepted outcome cannot be replaced.

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

Object outcome parameters can declare `properties`, `requiredProperties`, and
`additionalProperties`. `required: true` requires the parameter itself;
`requiredProperties` lists required keys inside it. Nested objects and array items
use JSON Schema `required` arrays and support string `enum` and `minLength`.
The model receives the nested schema. Worker and server use the same structural
validator before accepting the outcome. Business constraints still belong in `.validateOutcome(...)`.

Rejected submissions leave the process turn open but end the current Pi model/tool
loop before another model request. This includes JSON-schema rejections before tool
execution. Recovery includes the latest validation errors and continues from the
latest attempt, preserving earlier corrections.
Automatic recovery allows at most three continuations and stops early after two
continuations repeat the same rejection. The rejected draft remains in the Pi
session; it is not published as an accepted result.

Outcome parameters support recursive `anyOf` alternatives, including objects and
arrays. Use a required single-value string enum in each object alternative to name
its operation. Validation reports errors from the named alternative, or lists the
available tags. Each alternative can require exactly the fields its operation uses.

`.strictSchema()` opts an outcome into provider enforcement. Every property must be
required and every object must set `additionalProperties: false`, including inside
alternatives. Incompatible declarations fail validation; they are not rewritten.
Strict outcomes omit the automatically injected optional `resultSummary` argument;
required result Markdown remains. OpenAI Responses and Chat Completions enforce the
native schema. Other provider APIs emit an unsupported-enforcement diagnostic and
retain worker and server validation. Provider rejection never silently downgrades
an opted-in tool. Inspection records the schema and enforcement mode.

Integration definitions may set `modelVisible: false` to reserve a tool for runtime
callbacks. The tool remains subject to the turn's integration-tool authorization.
It is omitted from model declarations and cannot be selected by the model.
