# Introduction

Leitwerk manages step-by-step AI workflows—from code implementation and pull requests to issue triage and review—for software engineering teams.

A central server saves task progress and streams live updates to a web dashboard. Workers run AI agents in isolated environments to execute code changes, manage tracker items, run tests, and update merge requests. Humans can watch progress, guide the agent, or retry failed steps.

## Key Features

- **Code-Defined Processes:** Build custom AI workflows using TypeScript, controlling exact step-by-step turns and transitions.
- **Pluggable Integrations:** Connect issue trackers, VCS providers, and internal APIs through extensions.
- **Custom Outcome Tools:** Give AI agents turn-specific tools to report results, request human feedback, or trigger next steps.
- **Automated Watchers:** Trigger new AI workflows automatically when external queues or pull requests change.
- **Flexible Execution:** Run workers locally, in Docker containers, or on Kubernetes pods.

## System Components

- **Server:** Owns durable state in SQLite, manages task coordination, and executes safe external API writes.
- **Worker:** Runs AI agents inside isolated workspace clones to write code and execute tests.
- **Browser UI:** Streams real-time WebSocket updates, task chronicles, and steering controls to operators.
- **Extensions:** TypeScript modules that define custom processes, external-system integrations, and turn outcome tools.

## Built-in Examples

### Local Repository Change (`local_repo_change_process`)
The Local Repo Change process automates end-to-end coding tasks directly on a local git repository.

- **Planning & Implementation:** An operator submits a prompt. Leitwerk creates a fresh working branch on a workspace clone, analyzes the repository, and generates a structured implementation plan.
- **Human Steering & Finalization:** The operator can approve the plan, request revisions, or trigger automated review turns. Once approved, the AI agent implements the code changes and tests. After final verification, Leitwerk automatically commits and merges the completed work.

### Process Analysis & Handover (`process-analysis`)
The Process Analysis extension handles complex tasks by separating architecture analysis from code execution.

- **Deep Analysis:** A dedicated analysis process inspects repository structure, diagnoses complex bugs, or drafts detailed technical plans.
- **Cross-Process Handover:** Once the analysis plan is approved, it hands off directly into `local_repo_change_process`. The implementation process imports the plan markdown, skips redundant plan generation, and immediately starts executing the code changes.

### Showcase Processes & Watchers (`showcase-processes`)
The Showcase extension provides zero-dependency demo workflows for local testing when running `npm run dev`.

- **Watcher-Launched Tasks:** Demonstrates how external triggers start new processes automatically. For instance, a filesystem watcher monitors `/tmp/create-poem` and launches a new process instance the moment a prompt file is written.
- **External Action Triggers:** Shows how external files or tools steer active processes. Dropping feedback into `/tmp/poem-review-{instanceId}` triggers follow-up turns where operators can accept, request changes on, or dismiss incoming review notes.

## Next Steps

- **Run Leitwerk Locally:** Execute `npm run dev` to launch the local server, web dashboard, and showcase processes.
- **Build a Custom Process:** Use the [Process SDK](process-sdk.md) to define custom turn graphs and outcome tools.

Use **API tokens** in the account menu to connect HTTP clients with your existing application access. See [security](security.md#personal-and-anonymous-api-tokens) for ownership and credential boundaries.
