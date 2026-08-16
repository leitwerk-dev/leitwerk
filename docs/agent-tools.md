# Agent Tools & Outcomes

In Leitwerk, AI agents interact with workspace repositories, process state, and external services through **Agent Tools**. Tools fall into four distinct categories:

1. **Built-in Primitives:** Core workspace tools (`read`, `bash`, `edit`, `write`) for inspecting files, running shell commands, and editing code.
2. **Integration Tools:** Extension-provided tools for interacting with external services during execution (authored by an extension; not a fixed in-tree catalog).
3. **Interactive Tools:** The `ask_questions` tool, used by agents to pause execution and ask human operators structured questions during a turn.
4. **Outcome Tools:** Terminal tools that return typed data, publish markdown products, and transition process state to the next step.

## 1. Built-in Primitives

Each LLM turn explicitly declares which built-in workspace primitives the AI agent can invoke while running:

```ts
const implement = flow
  .llm<Params, State>("implement")
  .tools("read", "bash", "edit", "write") // Active built-in primitives for this turn
  .buildPrompt((ctx) => `Implement task: ${ctx.params.prompt}`);
```

The four built-in primitives control workspace access:

- **`read`:** Reads file contents within the workspace repository.
- **`bash`:** Executes shell commands (such as `git diff`, `rg`, `tree`, or test commands). Used in read-only mode during inspection turns (planning, code review, triage).
- **`edit`:** Modifies existing files within the workspace repository.
- **`write`:** Creates new files or overwrites existing files.

## 2. Integration Tools

Integration extensions define server tools for external services. The example below is an
extension-author pattern, not a fixed in-tree provider catalog:

```ts
// Registered inside setupServer(api) in an integration extension
api.tool({
  name: "tracker_get_issue",
  description: "Read an external issue",
  parameters: {
    type: "object",
    properties: {
      issueKey: { type: "string", description: "External issue key" },
    },
    required: ["issueKey"],
  },
  execute: async (ctx, params) =>
    trackerClient.getIssue(params.issueKey, { signal: ctx.signal }),
});

flow.llm("inspect_issue")
  .description("Inspect the source issue")
  .integrationTools("tracker_get_issue");
```

Integration tools run in the server process. LLM and worker automatic turns declare
authorized names with `.integrationTools(...)`. Workers receive only each tool's name,
description, and parameter schema. The server accepts a call only from the current turn
record and only for a tool authorized by that turn. Provider credentials stay on the server.
Names must not collide with Pi built-ins, framework tools, or an outcome tool on the turn.

Reconnects replay a call with the same idempotency key. Mutating tools must use
`ensureWrite()` so replay remains safe across server restarts. When a turn stops, the
server aborts `ctx.signal`; tool implementations must pass it to cancellable provider calls.

Authors register tools for the external systems their extension owns, such as issue trackers,
VCS providers, and internal APIs. The monorepo does not define a fixed integration catalog.
Automatic turns invoke a declared tool with `ctx.callIntegrationTool(name, args)`. Calls use
the same turn-record authorization, replay identity, cancellation, and credential isolation
as LLM integration-tool calls.

## 3. Interactive Tools (`ask_questions`)

Unlike terminal outcome tools, **Interactive Tools** do not end the turn. They allow agents to pause and gather operator feedback mid-execution.

Call `.askQuestions()` on an LLM turn builder to enable the sequential `ask_questions` tool:

```ts
const planTurn = flow
  .llm<Params, State>("plan")
  .askQuestions() // Opt-in to interactive human Q&A
  .publish("plan")
  .to("plan_decision");
```

- **Structured Options:** The agent specifies prepared options with recommended choices and explanations for each question.
- **Operator Selection:** The tool returns `{ answers: string[] }` chosen by the human operator on the web dashboard.
- **In-Turn Resume:** Execution resumes within the same turn without resetting context or completing the turn.

## 4. Terminal Outcome Tools

An **Outcome Tool** finishes an LLM turn by returning typed data, publishing markdown results, and selecting the next process route:

```ts
const verifyBuild = flow
  .llm<Params, State>("verify_build")
  .outcomeTool("build_passing", (tool) =>
    tool
      .description("Build and unit tests pass cleanly")
      .complete(), // Completes the process instance
  )
  .outcomeTool("build_failing", (tool) =>
    tool
      .description("Build or tests failed")
      .requiredString("summary", "Summary of test failures")
      .to("fix_build"), // Transitions to fix_build turn
  );
```

### Terminal Acknowledgement

When an outcome tool is called successfully:
1. The worker records the typed parameters and published markdown.
2. The agent receives a terminal instruction (`Outcome accepted successfully. Reply only with "done"`).
3. The turn ends deterministically and triggers the declared transition (`.to(...)` or `.complete()`).
