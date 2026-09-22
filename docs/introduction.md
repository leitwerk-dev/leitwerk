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

### Forgejo Repository Change (`forgejo_repo_change_process`)
The Forgejo Repo Change process automates coding tasks from a UI request or a labeled Forgejo issue.

- **Planning & Implementation:** Leitwerk creates a feature branch in a workspace clone, generates a plan, and implements the approved change.
- **Provider Delivery:** The process pushes the branch, opens a pull request, observes review and CI signals, and waits for the provider to report the terminal outcome.

### Process Analysis (`process-analysis`)
The Process Analysis extension inspects an existing process without changing it.

- **Deep Analysis:** A dedicated analysis process downloads a process snapshot, diagnoses failures, or drafts implementation guidance.
- **Read-Only Follow-Up:** Operators can refine the analysis, ask follow-up questions, or refresh the snapshot. The process does not launch a repository-change process.

### Showcase Processes & Watchers (`showcase-processes`)
The Showcase extension provides zero-dependency demo workflows for local testing when running `npm run dev`.

- **Watcher-Launched Tasks:** Demonstrates how external triggers start new processes automatically. For instance, a filesystem watcher monitors `/tmp/create-poem` and launches a new process instance the moment a prompt file is written.
- **External Action Triggers:** Shows how external files or tools steer active processes. Dropping feedback into `/tmp/poem-review-{instanceId}` triggers follow-up turns where operators can accept, request changes on, or dismiss incoming review notes.

## Next Steps

- **Run Leitwerk Locally:** Execute `npm run dev` to launch the local server, web dashboard, and showcase processes.
- **Build a Custom Process:** Use the [Process SDK](process-sdk.md) to define custom turn graphs and outcome tools.

Use **API tokens** in the account menu to connect HTTP clients with your existing application access. See [security](security.md#personal-and-anonymous-api-tokens) for ownership and credential boundaries.
