# Agent Tools & Outcomes

In Leitwerk, AI agents interact with workspace repositories, process state, and external services through **Agent Tools**. Tools fall into four distinct categories:

1. **Built-in Primitives:** Core workspace tools (`read`, `bash`, `edit`, `write`) for inspecting files, running shell commands, and editing code.
2. **Integration Tools:** Extension-provided tools (such as Jira issue tools `jira_update_issue` or GitLab MR tools) for interacting directly with external services during execution.
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

Integration extensions define custom domain tools that allow AI agents to query or update external services (like Jira or GitLab) during execution:

```ts
// Registered inside setupServer(api) in an integration extension
api.tool({
  name: "jira_update_issue",
  description: "Update status, labels, or post comments to a Jira issue",
  parameters: {
    type: "object",
    properties: {
      issueKey: { type: "string", description: "Jira Issue Key (e.g. PROJ-123)" },
      comment: { type: "string", description: "Comment text to post" },
      status: { type: "string", description: "Target Jira status transition" },
    },
    required: ["issueKey"],
  },
  execute: async (ctx, params) => {
    await jiraClient.updateIssue(params);
    return { success: true, message: `Updated ${params.issueKey}` };
  },
});

flow.llm("update_issue")
  .description("Update the source issue")
  .integrationTools("issue_update");
```

Integration tools are registered and executed in the server process. `worker.start`
contains only their non-secret name, description, and JSON parameter schema. A worker
invocation crosses authenticated IPC and is accepted only for the active running turn,
an explicitly authorized tool name, and an optional project belonging to that process.
Provider tokens and clients never enter worker configuration or snapshots.

The server assigns a stable idempotency key from the process, turn record, Pi tool-call
identity, and tool name. Reconnects replay the same request. External writes must also
use `ensureWrite()` so replay remains safe across a server restart.

### Common Integration Tools

- **Jira Integration:** Fetching issue metadata (`jira_get_issue`), updating status (`jira_update_issue`), or posting comments.
- **GitLab Integration:** Reading merge request metadata, posting inline code review comments, or triggering pipeline re-runs.
- **Custom Service Integration:** Authors can register custom tools for internal APIs, database queries, or third-party webhooks.

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
