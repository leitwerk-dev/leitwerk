# Agent tools

Every LLM turn exposes its declared tools plus the framework's `abort_turn` tool.

| Category | Purpose | Ends turn |
| --- | --- | --- |
| Workspace primitives | Read/edit files or run commands inside the worker. | No |
| Integration tools | Call an authorized server-owned integration or shared facility. | No |
| `ask_questions` | Pause for structured operator answers mid-turn. | No |
| Outcome tools | Publish typed results and choose the next route. | Yes |
| `abort_turn` | Stop the turn in `error`, preserving workspace and session for recovery. | Yes |

## Workspace primitives

Opt into Pi built-in workspace primitives (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) per LLM turn with `.tools(...)`:

```ts
flow.llm<Params, State>("implement")
  .description("Implement the change")
  .tools("read", "bash", "edit", "write", "grep", "find", "ls")
  .buildPrompt((ctx) => ctx.params.prompt);
```

Grant only required tools. `bash` executes arbitrary commands in the worker; local workers have no container boundary. Tool subprocesses strip worker IPC credentials, managed Git auth, and `NODE_ENV`. See [Security](../admin/security.md).

Processes using `.runtime({ repositoryCheckout: "on_demand" })` also receive `checkout_repository({ projectKey, revision? })`. It materializes a declared project's full clone and reports local `HEAD`. An optional full 40- or 64-character commit SHA checks out detached, verifies `HEAD`, pins the checkout for recovery, and rejects dirty workspaces.

## Integration tools

Register server-owned tools in `setupServer`:

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

- Authorize tools on turns via `.integrationTools(...)` or dynamically at worker start via `.resolveIntegrationTools((params, state) => names)`.
- Names must be globally unique lowercase `snake_case` and cannot collide with Pi built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), reserved framework tools (`abort_turn`, `ask_questions`, `markdown_result`, `upload_result_images`), or the turn's outcome tools.
- Set `modelVisible: false` to reserve an authorized tool for `.prepare(...)` or automatic turns (`ctx.callIntegrationTool(name, args)`) without exposing it to the model.
- Workers receive only names, descriptions, and JSON schemas; provider credentials stay on the server.
- Before dispatch, the server verifies the active turn record, selected turn, project, and authorization. Reconnect replays keep the same `ctx.idempotencyKey`. Mutating tools must use [Typed external writes](external-writes-and-adapters.md#typed-external-writes).
- Pass `ctx.signal` to cancellable I/O; turning off or stopping a turn aborts it (already-committed remote writes cannot be rolled back).
- Topic-bound wiki tools register through the same server registry ([wiki package reference](../../packages/wiki/README.md)); wiki text is untrusted evidence, never tool authority.

### Tool approvals

Tool approvals bind to the accepted turn record. Ending a turn cancels open approvals even if a worker exits ungracefully. Decisions for stale attempts are rejected; declining an approval aborts only the still-current process. For ticket-creation capabilities (`capability.kind: "ticket_creation"`), see [Ticket creation adapters](external-writes-and-adapters.md#ticket-creation-adapters).

## Interactive questions

Call `.askQuestions()` or `.askQuestions(ctx => boolean)` on an LLM turn to expose `ask_questions`. The optional predicate runs after preparation on captured params, state, and `ctx.prepared` so recovery preserves availability. Calling `ask_questions` pauses the active turn durably and returns `{ answers: string[] }` when the operator answers, resuming the same context without starting a new attempt.

## Aborting a turn

Every LLM turn exposes `abort_turn({ reason })` (non-empty `reason` required). When called, the worker halts further tool calls and records a failed turn (`llm_error`), keeping the process on the same turn with `lifecycleStatus = error` so workspace edits and the session remain available for Continue or Retry. It does not publish an outcome or abort the process, and cannot replace an already accepted outcome.

## Outcome tools

An outcome tool ends the LLM turn with validated typed arguments and selects a declared route:

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

Outcome tools register only while their turn is active. When a turn publishes a product, `.outcomeTool(...)` auto-injects a required `markdown` argument unless you explicitly declare `.markdown(name, { publish: true })`. After acceptance, the worker records parameters and Markdown, issues a bounded terminal acknowledgement instruction to the agent, uploads the session snapshot, and waits for durable server confirmation.

### Parameter schemas and validation

- **Nested objects & arrays:** Object parameters support `properties`, `requiredProperties`, and `additionalProperties`. Nested objects/items support JSON Schema `required`, string `enum`, and `minLength`. Presence (`required: true`) is distinct from cardinality (`minItems`); `requiredArray` and `requiredStringArray` default to `minItems: 1` (override with `minItems: 0` to allow `[]`).
- **Unions (`anyOf`):** `.union(name, variants, options)` emits recursive JSON Schema `anyOf`. Tag object variants with a required single-value string enum so validation pinpoints the chosen variant's errors.
- **Strict provider schemas:** `.strictSchema()` opts into native provider enforcement (OpenAI Responses / Chat Completions). Every property must be required and every object must set `additionalProperties: false`, including inside `anyOf` branches; invalid schemas fail definition validation rather than being rewritten. Strict outcomes omit the auto-injected optional `resultSummary` parameter while retaining required result Markdown. Unsupported providers log a diagnostic and enforce worker/server validation; provider rejection never silently downgrades strict mode.
- **Contextual parameters:** `.resolveParameters(ctx => specs)` overrides declared parameters synchronously from immutable decoded `params`, `state`, and mapped item context (no worker preparation or tool access). Resolved contracts are persisted at turn-start preparation and reused across replacements; explicit Retry and Continue resolve fresh contracts.
- **Worker-side validation:** `.validateOutcome((ctx, submission) => errors)` checks business rules inside the active turn (with access to `prepared` and authorized integration tools). Return `[]` to accept or actionable error strings to reject (thrown errors become feedback). Authoritative checks still belong in server effects or mapped `yield`.
- **Bounded rejection recovery:** Any schema or `.validateOutcome` rejection ends the current Pi model/tool loop and triggers bounded continuation with the errors, allowing at most three continuations and stopping early if two continuations repeat the same rejection. Rejected drafts remain in the session tree and are never published.
