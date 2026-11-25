/* <leitwerk-flow>: walks through one Leitwerk process step by step, as a diagram with a chapter timeline.

   Attributes
     flow           triage | implement | monitor (default triage)
     level          1 Overview, 2 Components, 3 Details (default 1)
     zoom-controls  show the zoom buttons and enable the 1–3 keys
     docs-base      base URL of the Leitwerk docs site; term links then point at its pages instead of GitHub
     color-scheme   light | dark; without it the element follows prefers-color-scheme

   Methods: play(), pause(), next(), back(), reset(), goTo(step). Property `flows` lists the flow ids and names.
   Event: "step" with detail {flow, level, step, total, playing}, after every change. step is -1 before the first step.

   Each chapter starts on a clean canvas: earlier arrows disappear and components that sit out the current
   chapter step back. Actor hues: people, outside tools, watcher, server, worker, AI model. */
(() => {
	if (customElements.get("leitwerk-flow")) return;

	const DOCS = "https://github.com/leitwerk-dev/leitwerk/blob/main/docs/";
	const FONT_URL =
		"https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";

	/* ---------- Leitwerk terms, each linked to its docs page ---------- */
	const C = {
		server: {
			label: "Server",
			path: "maintainers/architecture.md",
			def: "Keeps all durable state and every credential. Runs watchers and integration tools.",
		},
		worker: {
			label: "Worker",
			path: "maintainers/server-worker-lifecycle.md",
			def: "Short-lived sandbox that runs one step with an AI agent and its own repository copy. It never sees the database or service tokens.",
		},
		watcher: {
			label: "Watcher",
			path: "extensions/watchers.md",
			def: "Runs inside the server. Polls an outside system and starts a process when it finds new work.",
		},
		launch: {
			label: "Launch admission",
			path: "extensions/launchers-and-readiness.md#programmatic-launch-admission",
			def: "Starting a process with an idempotency key, so one event starts exactly one process.",
		},
		process: {
			label: "Process",
			path: "maintainers/terminology.md#process-and-execution",
			def: "One durable run of a workflow, e.g. one issue being implemented.",
		},
		turn: {
			label: "Turn",
			path: "extensions/process-sdk.md#process-definitions-and-turns",
			def: "One code-defined step of a process: AI, automatic, human, or external.",
		},
		llmTurn: {
			label: "LLM turn",
			path: "maintainers/llm-turn.md",
			def: "A step where the AI agent works with tools until it reports a typed result.",
		},
		humanTurn: {
			label: "Human turn",
			path: "extensions/process-sdk.md#human-turns-and-external-actions",
			def: "The process pauses until a person decides in the Leitwerk UI.",
		},
		externalAction: {
			label: "External action",
			path: "extensions/watchers.md#external-action-sources",
			def: "An outside event, like a failed CI check or a reply, that moves a waiting process on.",
		},
		input: {
			label: "Process input",
			path: "maintainers/terminology.md#process-and-execution",
			def: "A person's decision, queued in order on the process.",
		},
		product: {
			label: "Product",
			path: "extensions/process-sdk.md#products",
			def: "A named result, like a plan, that later steps and people can read.",
		},
		integrationTool: {
			label: "Integration tool",
			path: "extensions/agent-tools.md#integration-tools",
			def: "A tool that runs on the server. The worker only sends the request; credentials stay on the server.",
		},
		primitive: {
			label: "Workspace tools",
			path: "extensions/agent-tools.md#workspace-primitives",
			def: "read, edit, bash, grep and friends. They run inside the worker on its repository copy.",
		},
		outcomeTool: {
			label: "Outcome tool",
			path: "extensions/agent-tools.md#outcome-tools",
			def: "How the AI finishes a step: a typed result that also picks the next step.",
		},
		askQuestions: {
			label: "ask_questions",
			path: "extensions/agent-tools.md#interactive-questions",
			def: "Lets the AI pause mid-step and ask a person, then continue where it was.",
		},
		approval: {
			label: "Tool approval",
			path: "extensions/agent-tools.md#tool-approvals",
			def: "A person approves a tool call, such as creating a ticket, before it runs.",
		},
		externalWrite: {
			label: "External write",
			path: "extensions/external-writes-and-adapters.md#typed-external-writes",
			def: "Writes are recorded first with an idempotency key, so a retry never writes twice.",
		},
		wiki: {
			label: "Solution wiki",
			path: "users/solution-wiki.md",
			def: "Team knowledge Leitwerk keeps per topic, with evidence. Used as hints, never as instructions.",
		},
		workspace: {
			label: "Workspace clone",
			path: "maintainers/process-workspace.md",
			def: "A full git clone per repository, on the process's own branch.",
		},
		model: {
			label: "Model provider",
			path: "admin/models.md",
			def: "The LLM service the AI agent talks to.",
		},
		sqlite: {
			label: "SQLite",
			path: "admin/backup-and-upgrades.md",
			def: "The server's database. Only the server writes to it.",
		},
		engine: {
			label: "ProcessEngine",
			path: "maintainers/architecture.md#5-building-blocks",
			def: "Decides which step runs next and records every result, one change at a time per process.",
		},
		chronicle: {
			label: "Chronicle",
			path: "maintainers/ui-contracts.md#chronicle-and-turn-rail",
			def: "The process timeline in the Leitwerk UI, where people read results and decide.",
		},
	};

	/* ---------- Components ---------- */
	const ACT = {
		dev: { l: "Developer", s: "asks for the change", g: "person" },
		reviewer: { l: "Reviewer", s: "reviews pull requests", g: "person" },
		reporter: { l: "Bug reporter", s: "customer support", g: "person" },
		lead: { l: "Triage lead", s: "decides on fixes", g: "person" },
		oncall: { l: "On-call engineer", s: "approves new bugs", g: "person" },
		github: { l: "GitHub", s: "issues and pull requests", g: "ext" },
		jira: { l: "Jira", s: "bug tracker", g: "ext" },
		logs: { l: "Production logs", s: "log store", g: "ext" },
		lw: { l: "Leitwerk", s: "runs the process", g: "server", c: "server" },
		watcher: { l: "Watcher", s: "looks for new work", g: "watch", c: "watcher" },
		server: { l: "Core", s: "state, credentials, tools", g: "server", c: "server" },
		worker: { l: "Worker", s: "sandbox doing the work", g: "worker", c: "worker" },
		engine: { l: "Process engine", s: "decides the next step", g: "server", c: "engine" },
		tools: { l: "Integration tools", s: "hold the credentials", g: "server", c: "integrationTool" },
		db: { l: "Database", s: "history", g: "server", c: "sqlite" },
		wiki: { l: "Solution wiki", s: "team knowledge", g: "server", c: "wiki" },
		agent: { l: "AI agent", s: "inside the worker", g: "worker", c: "worker" },
		repo: { l: "Repository copy", s: "full git clone", g: "worker", c: "workspace" },
		model: { l: "AI model", s: "LLM provider", g: "model", c: "model" },
	};
	const col = (a) => `var(--c-${ACT[a].g})`;
	const GROUPS = ["person", "ext", "watch", "server", "worker", "model"];
	const EXT = new Set(["github", "jira", "logs"]);

	/* ---------- Flows: each step can open into more detailed steps ---------- */
	const S = (f, t, l, x, c = [], k = []) => ({ f, t, l, x, c: [].concat(c), k });

	const FLOWS = {
		triage: {
			name: "Triage a Jira bug",
			startText:
				"It starts when someone adds the label leitwerk-triage to a bug, or a Jira automation adds it to every new bug. From there it runs without anyone in Leitwerk: it assigns a team, completes the report and writes the fix options into the bug.",
			chapters: [
				["Pick up and route", 0],
				["Complete the report", 5],
				["Confirm and publish", 9],
			],
			chaptersDetail: [
				["Pick up", 0],
				["Read the bug", 2],
				["Assign team", 3],
				["Complete the report", 5],
				["Confirm in logs", 9],
				["Find fixes", 10],
				["Publish", 11],
			],
			state: {
				title: "Bug PAY-4821",
				sub: "Refund retry charges card twice",
				rows: ["Status", "Labels", "Team", "Report", "Severity", "Fix"],
				init: { Status: "New", Labels: "payments" },
				patch: {
					0: { Labels: "payments, leitwerk-triage" },
					1: { Status: "In triage" },
					3: { Team: "Payments Core (proposed)" },
					4: { Team: "Payments Core" },
					5: { Report: "no version, no request id" },
					6: { Status: "Waiting for reporter" },
					7: { Report: "complete" },
					8: { Status: "In triage" },
					9: { Severity: "S2, confirmed in logs" },
					10: { Fix: "2 options found" },
					11: { Fix: "both options in the bug", Status: "Triaged" },
				},
				files: { 0: ["statement-screenshot.png"], 7: ["app.har"], 11: ["log-excerpt.txt"] },
			},
			steps: [
				S(
					"reporter",
					"jira",
					"files bug with screenshot",
					"A support agent files PAY-4821 “Refund retry charges card twice”, attaches a screenshot of the customer's card statement, and adds the label leitwerk-triage.",
				),
				S(
					"lw",
					"jira",
					"looks for the label",
					"Leitwerk checks Jira regularly for bugs with the label. It finds PAY-4821 and starts triage.",
					["watcher", "launch"],
					[
						S(
							"watcher",
							"jira",
							"bugs labelled “leitwerk-triage”?",
							"The watcher is the part of the server that looks for new work. It finds PAY-4821.",
							["watcher"],
						),
						S(
							"watcher",
							"server",
							"start triage of PAY-4821",
							"The core starts one process for this bug. Seeing the bug again will not start another.",
							["launch", "process"],
						),
					],
				),
				S(
					"lw",
					"jira",
					"reads bug and screenshot",
					"Leitwerk reads the description, the steps to reproduce and the attached screenshot. The screenshot shows two charges of €48.90 for one refund.",
					["integrationTool"],
					[
						S(
							"server",
							"worker",
							"“read the bug”",
							"The server hands the first step to a worker.",
							["worker", "turn"],
						),
						S(
							"worker",
							"server",
							"get bug and attachments",
							"The worker has no Jira token, so it asks the server for the bug and its attachment.",
							["integrationTool"],
						),
						S(
							"server",
							"jira",
							"fetch issue + screenshot",
							"The server reads the issue and downloads statement-screenshot.png.",
							["integrationTool"],
						),
						S(
							"worker",
							"model",
							"what does the screenshot show?",
							"The AI model reads the screenshot: two identical charges, one refund.",
							["llmTurn"],
						),
					],
				),
				S(
					"lw",
					"lw",
					"picks the owning team",
					"The AI checks the code owners file and the team's notes: Payments Core owns refunds.",
					["llmTurn", "wiki"],
					[
						S(
							"worker",
							"server",
							"who owns refunds?",
							"The worker asks for the team-ownership notes in the solution wiki.",
							["wiki"],
						),
						S(
							"worker",
							"model",
							"decide the team",
							"The AI agent also reads the code owners file, then decides.",
							["llmTurn"],
							[
								S("agent", "repo", "read CODEOWNERS", "refunds/ belongs to @acme/payments-core.", [
									"primitive",
								]),
								S(
									"agent",
									"model",
									"which team?",
									"Wiki and code owners agree: Payments Core, high confidence.",
									["model"],
								),
							],
						),
					],
				),
				S(
					"lw",
					"jira",
					"sets team: Payments Core",
					"Leitwerk writes the team onto the bug.",
					["externalWrite"],
					[
						S("worker", "server", "set the team", "The worker asks the server to update the bug.", [
							"integrationTool",
						]),
						S(
							"server",
							"jira",
							"update the team field",
							"Recorded first, so a retry does not write twice.",
							["externalWrite"],
						),
					],
				),
				S(
					"lw",
					"lw",
					"checks the report",
					"Steps to reproduce: yes. Screenshot: yes. App version: missing. Request id: missing. Without those, nobody can find the logs.",
					["llmTurn"],
					[
						S(
							"worker",
							"model",
							"is the report complete?",
							"The AI compares the bug and its attachment against the team's checklist.",
							["llmTurn"],
						),
					],
				),
				S(
					"lw",
					"jira",
					"asks for the missing data",
					"Leitwerk comments on the bug and asks the reporter for the app version and a network recording (HAR file). Then it waits.",
					["externalWrite"],
					[
						S(
							"worker",
							"server",
							"comment on the bug",
							"The worker asks the server to post the comment.",
							["integrationTool"],
						),
						S("server", "jira", "post comment to reporter", "The comment mentions the reporter.", [
							"externalWrite",
						]),
					],
				),
				S(
					"reporter",
					"jira",
					"replies, attaches app.har",
					"The reporter answers with app version 4.18.2 and attaches app.har, a browser network recording that contains the request id.",
				),
				S(
					"jira",
					"lw",
					"reply arrives",
					"Leitwerk notices the reply and continues the triage.",
					["externalAction"],
					[
						S(
							"jira",
							"watcher",
							"new comment on PAY-4821",
							"The watcher sees the reply and the new attachment.",
							["externalAction"],
						),
						S("watcher", "server", "resume triage", "The waiting process moves on.", [
							"externalAction",
						]),
					],
				),
				S(
					"lw",
					"logs",
					"looks up the request",
					"Leitwerk takes the request id from app.har and finds two charges for one refund in the logs. The bug is confirmed as severity S2.",
					["integrationTool"],
					[
						S(
							"worker",
							"server",
							"download app.har",
							"The worker gets the new attachment through the server and reads the request id req_8f2c91 from it.",
							["integrationTool"],
						),
						S(
							"worker",
							"server",
							"search the logs",
							"The worker asks the server to search the logs.",
							["integrationTool"],
						),
						S("server", "logs", "search req_8f2c91", "Two charges for refund rf_5521.", [
							"integrationTool",
						]),
						S(
							"worker",
							"model",
							"confirm severity",
							"The AI rates it S2: customers are charged twice.",
							["llmTurn"],
						),
					],
				),
				S(
					"lw",
					"lw",
					"finds the cause, 2 fixes",
					"The AI finds that a retry re-sends the charge without the original idempotency key. It sees two possible fixes: reuse the stored key, or add a row lock.",
					["llmTurn"],
					[
						S(
							"worker",
							"model",
							"find the cause",
							"The AI agent finds that a retry re-sends the charge without the original key.",
							["llmTurn"],
							[
								S(
									"agent",
									"repo",
									"write a failing test",
									"The new test reproduces the double charge.",
									["primitive"],
								),
								S(
									"agent",
									"model",
									"find the cause",
									"The retry path ignores the stored idempotency key.",
									["model"],
								),
							],
						),
						S(
							"worker",
							"model",
							"compare the fix options",
							"Both fixes stop the double charge. Reusing the key is the smaller change; the row lock also protects other retry paths. The AI keeps both instead of choosing for the team.",
							["llmTurn"],
						),
					],
				),
				S(
					"lw",
					"jira",
					"posts triage + both fixes",
					"Leitwerk comments with the summary and both fix options with their trade-offs, attaches the matching log excerpt, and moves the bug to Triaged. The owning team picks the fix.",
					["externalWrite"],
					[
						S(
							"worker",
							"server",
							"post summary, attach logs",
							"The worker asks the server for the comment, the attachment and the status change.",
							["integrationTool"],
						),
						S(
							"server",
							"jira",
							"comment, attach, set Triaged",
							"All three writes are recorded first, so retries are safe.",
							["externalWrite"],
						),
					],
				),
			],
		},
		implement: {
			name: "Implement a GitHub issue",
			startText:
				"It starts when a developer adds the label use-leitwerk to an issue in a watched repository. Leitwerk does the rest and opens a pull request.",
			chapters: [
				["Pick up and plan", 0],
				["Build and open PR", 5],
				["Repair CI and merge", 7],
			],
			chaptersDetail: [
				["Pick up", 0],
				["Plan", 2],
				["Approve", 3],
				["Build", 5],
				["Open PR", 6],
				["Repair CI", 7],
				["Push update", 9],
				["Merge", 10],
			],
			state: {
				title: "Issue #312",
				sub: "team/service · Add CSV export for invoices",
				rows: ["Labels", "Status", "Plan", "Branch", "Pull request", "CI"],
				init: { Labels: "enhancement", Status: "open" },
				patch: {
					0: { Labels: "enhancement, use-leitwerk" },
					1: { Status: "Leitwerk working" },
					2: { Plan: "drafted, 4 steps", Branch: "leitwerk/issue-312" },
					3: { Plan: "waiting for approval" },
					4: { Plan: "approved" },
					5: { Branch: "leitwerk/issue-312, 1 commit" },
					6: { "Pull request": "#318 open", CI: "running" },
					7: { CI: "failed on Node 22" },
					8: { CI: "fix ready" },
					9: { CI: "running again", Branch: "leitwerk/issue-312, 2 commits" },
					10: { "Pull request": "#318 merged", CI: "passed" },
					11: { Labels: "enhancement, leitwerk-done", Status: "closed, done" },
				},
			},
			steps: [
				S(
					"dev",
					"github",
					"adds label “use-leitwerk”",
					"A developer adds the label use-leitwerk to issue #312 “Add CSV export for invoices”. That is the only thing needed to start.",
				),
				S(
					"lw",
					"github",
					"looks for the label",
					"Leitwerk checks the repository every 30 seconds for issues with the label. It finds #312 and starts working on it.",
					["watcher", "launch"],
					[
						S(
							"watcher",
							"github",
							"issues labelled “use-leitwerk”?",
							"The watcher is the part of the server that looks for new work. It asks GitHub for issues with the label and checks that the person who added it may start work.",
							["watcher"],
						),
						S(
							"watcher",
							"server",
							"start work on #312",
							"The watcher asks the server's core to start a process for #312. Seeing the same issue again later will not start a second one.",
							["launch", "process"],
							[
								S(
									"watcher",
									"engine",
									"start work on #312",
									"The watcher hands the new work to the process engine, together with a key that identifies issue #312.",
									["launch"],
								),
								S(
									"engine",
									"db",
									"save the new process",
									"The process is saved before anything else happens, so a restart never loses it.",
									["sqlite", "process"],
								),
							],
						),
					],
				),
				S(
					"lw",
					"lw",
					"plans the change",
					"Leitwerk's AI reads the code and writes a four-step plan.",
					["llmTurn", "product"],
					[
						S(
							"server",
							"worker",
							"“make a plan”",
							"The server hands the planning step to a worker: a short-lived sandbox with its own copy of the repository.",
							["worker", "turn"],
						),
						S(
							"worker",
							"github",
							"clone the repository",
							"The worker clones the repository onto a new branch, leitwerk/issue-312.",
							["workspace"],
							[
								S(
									"repo",
									"github",
									"git clone",
									"The repository copy lives inside the worker. Leitwerk delivers the SSH key for this one step.",
									["workspace"],
								),
							],
						),
						S(
							"worker",
							"model",
							"read code, draft a plan",
							"The worker's AI agent reads the code and asks the AI model to draft a plan.",
							["llmTurn", "model"],
							[
								S(
									"agent",
									"repo",
									"read guidance, search code",
									"The agent reads the repository's AGENTS.md and finds the existing PDF exporter. File tools like these run only inside the worker.",
									["primitive"],
								),
								S(
									"agent",
									"model",
									"draft the plan",
									"The agent sends what it found to the AI model and gets a plan back.",
									["model"],
								),
							],
						),
						S(
							"worker",
							"server",
							"the plan is ready",
							"The worker hands back the plan. The server saves it so people and later steps can read it.",
							["outcomeTool", "product"],
							[
								S(
									"agent",
									"engine",
									"submit the plan",
									"The AI finishes a step by sending a typed result. That result also decides what happens next.",
									["outcomeTool"],
								),
								S(
									"engine",
									"db",
									"save the plan",
									"The plan is stored as a named result of the process.",
									["product"],
								),
							],
						),
					],
				),
				S(
					"lw",
					"dev",
					"“please approve the plan”",
					"Leitwerk shows the plan to the developer and waits. Nothing runs while it waits.",
					["humanTurn", "chronicle"],
				),
				S(
					"dev",
					"lw",
					"approves",
					"The developer approves. They could also comment, and the AI would revise the plan.",
					["input"],
				),
				S(
					"lw",
					"lw",
					"writes the code",
					"The AI writes the code and tests, runs the tests, tidies its own work and writes a commit message.",
					["llmTurn"],
					[
						S(
							"server",
							"worker",
							"“implement the plan”",
							"A fresh step starts on a worker, with the approved plan as input.",
							["turn"],
						),
						S(
							"worker",
							"model",
							"write code and tests",
							"The AI agent writes the CSV exporter and its tests.",
							["llmTurn"],
							[
								S(
									"agent",
									"model",
									"write the CSV exporter",
									"The model proposes the code, one file at a time.",
									["model"],
								),
								S(
									"agent",
									"repo",
									"edit 4 files, run tests",
									"The agent edits files and runs the tests in its repository copy: 23 pass.",
									["primitive"],
								),
							],
						),
						S(
							"worker",
							"model",
							"simplify, commit message",
							"A second pass removes duplication and writes the message “feat(invoices): add CSV export”.",
							["llmTurn"],
						),
						S(
							"worker",
							"server",
							"the code is ready",
							"The worker reports the finished change back to the server.",
							["product"],
						),
					],
				),
				S(
					"lw",
					"github",
					"opens pull request #318",
					"Leitwerk pushes the branch and opens a pull request. If this step is ever retried, it finds #318 instead of opening a second PR.",
					["externalWrite"],
					[
						S(
							"worker",
							"github",
							"push the branch",
							"The worker pushes branch leitwerk/issue-312.",
							["workspace"],
							[
								S(
									"repo",
									"github",
									"git push",
									"The push only succeeds if nobody else changed the branch in the meantime.",
									["workspace"],
								),
							],
						),
						S(
							"worker",
							"server",
							"“open a PR for me”",
							"The worker has no GitHub token. It asks the server, which holds the credentials.",
							["integrationTool"],
						),
						S(
							"server",
							"github",
							"open PR #318",
							"The server opens the pull request with its own GitHub token.",
							["externalWrite"],
							[
								S(
									"tools",
									"db",
									"record the request first",
									"The request is recorded before it is sent. A retry finds this record and does not open a second PR.",
									["externalWrite"],
								),
								S("tools", "github", "open PR #318", "GitHub returns pull request #318.", [
									"externalWrite",
								]),
							],
						),
					],
				),
				S(
					"github",
					"lw",
					"a test fails",
					"Leitwerk keeps watching the pull request. One CI check fails on Node 22.",
					["externalAction"],
					[
						S(
							"github",
							"watcher",
							"check failed on Node 22",
							"The watcher sees the failed check on #318.",
							["externalAction"],
						),
						S(
							"watcher",
							"server",
							"resume: fix CI",
							"The process was waiting. The failure moves it on to a repair step.",
							["externalAction"],
						),
					],
				),
				S(
					"lw",
					"lw",
					"fixes the test",
					"The AI reads the CI log, finds a test that depends on the locale's sort order, fixes it and pushes.",
					["llmTurn"],
					[
						S(
							"worker",
							"server",
							"get the CI log",
							"Again the worker asks the server, because only the server may talk to GitHub.",
							["integrationTool"],
						),
						S(
							"server",
							"github",
							"fetch failure details",
							"The server reads the failed check's annotations and log tail from GitHub.",
							["integrationTool"],
						),
						S(
							"worker",
							"model",
							"find the cause, fix it",
							"The AI agent and the model work out the cause.",
							["llmTurn"],
							[
								S(
									"agent",
									"model",
									"why did it fail?",
									"Node 22 sorts strings differently, and the test assumed one order.",
									["model"],
								),
								S(
									"agent",
									"repo",
									"fix the test, run tests",
									"The agent fixes the test and runs it locally: 23 pass.",
									["primitive"],
								),
							],
						),
					],
				),
				S(
					"lw",
					"github",
					"pushes an update to #318",
					"Leitwerk pushes the fix to the same branch, so PR #318 updates and CI runs again. It also comments on the PR what it changed and why.",
					["workspace", "externalWrite"],
					[
						S(
							"worker",
							"github",
							"push the fix",
							"The worker pushes a second commit to leitwerk/issue-312.",
							["workspace"],
							[
								S(
									"repo",
									"github",
									"git push",
									"The push only succeeds if the branch still points where Leitwerk left it.",
									["workspace"],
								),
							],
						),
						S(
							"server",
							"github",
							"comment: what changed",
							"A short PR comment explains the CI fix. Recorded first, so a retry does not comment twice.",
							["externalWrite"],
						),
					],
				),
				S(
					"reviewer",
					"github",
					"reviews and merges",
					"CI passes. A reviewer approves and merges PR #318.",
				),
				S(
					"github",
					"lw",
					"PR merged",
					"Leitwerk sees the merge, labels the issue leitwerk-done and finishes.",
					["externalAction"],
					[
						S("github", "watcher", "PR #318 merged", "The watcher sees the merge.", [
							"externalAction",
						]),
						S(
							"server",
							"github",
							"label issue “leitwerk-done”",
							"The issue gets its done label, and the process completes. Written once, even if retried.",
							["externalWrite"],
						),
					],
				),
			],
		},
		monitor: {
			name: "Watch production",
			startText:
				"Nobody starts this flow, and nobody needs to approve anything. Leitwerk checks the checkout service's error rate every five minutes and starts when it jumps. It ends by filing a GitHub issue that starts “Implement a GitHub issue”.",
			chapters: [
				["Detect", 0],
				["Investigate", 2],
				["File and hand off", 5],
			],
			chaptersDetail: [
				["Detect", 0],
				["Collect errors", 2],
				["Analyse", 3],
				["Known?", 4],
				["File issues", 5],
				["Hand off", 7],
			],
			state: {
				title: "Incident · checkout",
				sub: "started 09:02",
				rows: ["Error rate", "Status", "Errors", "Problems", "Known issue", "New issue"],
				init: { "Error rate": "normal", Status: "watching" },
				patch: {
					1: { "Error rate": "4.1× normal", Status: "investigating" },
					2: { Errors: "3 groups, 1,904 events" },
					3: { Problems: "2 real, 1 noise" },
					4: { Problems: "1 known, 1 new" },
					5: { "Known issue": "#298, occurrence added" },
					6: { "New issue": "#341, use-leitwerk" },
					7: { Status: "handed off to #341" },
				},
			},
			steps: [
				S(
					"lw",
					"logs",
					"checks the error rate",
					"Every five minutes, Leitwerk asks the log store how many errors the checkout service produced.",
					["watcher"],
					[
						S(
							"watcher",
							"logs",
							"errors in checkout?",
							"The watcher is the part of the server that looks for new work. Here it watches an error rate.",
							["watcher"],
						),
					],
				),
				S(
					"logs",
					"lw",
					"4× more errors than usual",
					"At 09:02 the error rate jumps to 4.1 times its normal level. Leitwerk starts an investigation.",
					["launch"],
					[
						S("logs", "watcher", "4.1× normal since 09:02", "The spike crosses the threshold.", [
							"watcher",
						]),
						S(
							"watcher",
							"server",
							"start an investigation",
							"The core starts one process for this spike. The next check will not start a duplicate.",
							["launch", "process"],
						),
					],
				),
				S(
					"lw",
					"logs",
					"collects the top errors",
					"Leitwerk pulls the most frequent error groups from the last 30 minutes.",
					["integrationTool"],
					[
						S(
							"server",
							"worker",
							"“collect the errors”",
							"The server hands the first step to a worker.",
							["worker", "turn"],
						),
						S(
							"worker",
							"server",
							"query the logs",
							"The worker cannot reach the log store itself. It asks the server.",
							["integrationTool"],
						),
						S(
							"server",
							"logs",
							"top error groups, 30 min",
							"The log store returns three error groups, 1,904 events.",
							["integrationTool"],
						),
					],
				),
				S(
					"lw",
					"lw",
					"finds 2 real problems",
					"The AI sorts the errors into two real problems and dismisses client disconnects as noise.",
					["llmTurn"],
					[
						S(
							"worker",
							"model",
							"which errors matter?",
							"The AI agent looks at stack traces with the model.",
							["llmTurn"],
							[
								S(
									"agent",
									"repo",
									"read the failing code",
									"It opens TaxCalculator in its copy of the repository.",
									["primitive"],
								),
								S(
									"agent",
									"model",
									"which errors matter?",
									"Two problems started with the 09:00 deploy. One is noise.",
									["model"],
								),
							],
						),
					],
				),
				S(
					"lw",
					"github",
					"checks if they are known",
					"For each problem, Leitwerk checks the team's incident notes and the open GitHub issues. The first is already known as #298. The second is new.",
					["wiki", "integrationTool"],
					[
						S(
							"worker",
							"server",
							"seen this before?",
							"The worker asks the server to search the incident notes.",
							["wiki"],
						),
						S(
							"worker",
							"server",
							"search GitHub issues",
							"The worker asks the server for a GitHub search.",
							["integrationTool"],
						),
						S(
							"server",
							"github",
							"search open bugs",
							"#298 matches problem 1. Nothing matches problem 2.",
							["integrationTool"],
						),
					],
				),
				S(
					"lw",
					"github",
					"comments on #298",
					"Leitwerk adds the new occurrence to the known issue: 1,240 errors since 09:02.",
					["externalWrite"],
					[
						S(
							"worker",
							"server",
							"comment on #298",
							"The worker asks the server to post the comment.",
							["integrationTool"],
						),
						S(
							"server",
							"github",
							"post the occurrence",
							"Recorded first, so a retry does not comment twice.",
							["externalWrite"],
						),
					],
				),
				S(
					"lw",
					"github",
					"creates #341, label use-leitwerk",
					"Leitwerk files the timeout problem as a new GitHub issue with the evidence, and adds the label use-leitwerk.",
					["externalWrite"],
					[
						S(
							"worker",
							"server",
							"file the new bug",
							"The worker asks the server to create the issue with the label.",
							["integrationTool"],
						),
						S(
							"server",
							"github",
							"create #341 + label",
							"The issue is created once, with the label use-leitwerk.",
							["externalWrite"],
							[
								S(
									"tools",
									"db",
									"record the request first",
									"A retry finds this record and does not create a second issue.",
									["externalWrite"],
								),
								S(
									"tools",
									"github",
									"create #341 + label",
									"GitHub returns issue #341, labelled bug and use-leitwerk.",
									["externalWrite"],
								),
							],
						),
					],
				),
				S(
					"lw",
					"github",
					"label starts a fix",
					"use-leitwerk is the same label a developer would add. Leitwerk's GitHub watcher picks up #341 and starts “Implement a GitHub issue” as a new, separate process. This run is done.",
					["watcher", "launch"],
					[
						S(
							"watcher",
							"github",
							"issues labelled “use-leitwerk”?",
							"The GitHub watcher finds #341, exactly as it would find an issue a developer labelled.",
							["watcher"],
						),
						S(
							"watcher",
							"server",
							"start work on #341",
							"A new process starts for #341. The monitoring run completes.",
							["launch", "process"],
						),
					],
				),
			],
		},
	};

	/* Expand the tree into one step list per zoom level. A step with no children stays as it is when zooming in.
   At Details, "server" becomes the server part that actually handles it: integration tools, the wiki, or the engine. */
	function mapDown(a, other, L, c) {
		if (L === 2) return a === "lw" ? "server" : a;
		if (L === 3) {
			if (a === "worker") return "agent";
			if (a === "lw" || a === "server") {
				if (EXT.has(other)) return "tools";
				if (c.includes("wiki")) return "wiki";
				if (c.includes("integrationTool") || c.includes("externalWrite")) return "tools";
				return "engine";
			}
		}
		return a;
	}
	function flatten(flow) {
		flow.flat = {};
		flow.lastOf = {};
		for (let L = 1; L <= 3; L++) {
			const out = [];
			const walk = (nodes, d, path) =>
				nodes.forEach((n, i) => {
					const p = [...path, i];
					if (d === L || !n.k.length)
						out.push({ ...n, f: mapDown(n.f, n.t, L, n.c), t: mapDown(n.t, n.f, L, n.c), path: p });
					else walk(n.k, d + 1, p);
				});
			walk(flow.steps, 1, []);
			flow.flat[L] = out;
			// index of the last displayed step that belongs to each top-level step: its state change lands there
			flow.lastOf[L] = flow.steps.map((_, k) => {
				let last = -1;
				out.forEach((s, j) => {
					if (s.path[0] === k) last = j;
				});
				return last;
			});
		}
	}
	Object.values(FLOWS).forEach(flatten);

	/* ---------- Layout: people on top, outside tools on the left, Leitwerk in the middle, AI model on the right ---------- */
	const VB = { w: 1140, h: 600 };
	const FIXED = {
		1: { lw: { x: 560, y: 320, w: 250, h: 100 } },
		2: {
			watcher: { x: 465, y: 250, w: 160, h: 50 },
			server: { x: 465, y: 420, w: 160, h: 50 },
			worker: { x: 705, y: 335, w: 160, h: 52 },
			model: { x: 925, y: 335, w: 150, h: 50 },
		},
		3: {
			watcher: { x: 450, y: 236, w: 160, h: 46 },
			engine: { x: 450, y: 328, w: 160, h: 46 },
			tools: { x: 450, y: 420, w: 160, h: 46 },
			db: { x: 392, y: 514, w: 110, h: 46 },
			wiki: { x: 510, y: 514, w: 110, h: 46 },
			agent: { x: 712, y: 300, w: 160, h: 46 },
			repo: { x: 712, y: 415, w: 160, h: 46 },
			model: { x: 930, y: 300, w: 140, h: 48 },
		},
	};
	const FRAMES = {
		1: [],
		2: [
			{
				cls: "lw",
				label: "Leitwerk",
				x: 350,
				y: 150,
				w: 460,
				h: 360,
				m: ["watcher", "server", "worker"],
			},
			{ cls: "", label: "Server", x: 368, y: 190, w: 194, h: 300, m: ["watcher", "server"] },
		],
		3: [
			{
				cls: "lw",
				label: "Leitwerk",
				x: 315,
				y: 135,
				w: 495,
				h: 430,
				m: ["watcher", "engine", "tools", "db", "wiki", "agent", "repo"],
			},
			{
				cls: "",
				label: "Server",
				x: 330,
				y: 172,
				w: 250,
				h: 375,
				m: ["watcher", "engine", "tools", "db", "wiki"],
			},
			{ cls: "", label: "Worker", x: 620, y: 232, w: 180, h: 240, m: ["agent", "repo"] },
		],
	};
	function layout(flow, L) {
		const used = [];
		flow.flat[L].forEach((s) => {
			[s.f, s.t].forEach((a) => {
				if (!used.includes(a)) used.push(a);
			});
		});
		const P = {};
		const people = used.filter((a) => ACT[a].g === "person"),
			ext = used.filter((a) => ACT[a].g === "ext");
		const px = [[560], [420, 700], [340, 560, 780]][people.length - 1] || [];
		people.forEach((a, i) => {
			P[a] = { x: px[i], y: 50, w: 160, h: 46 };
		});
		const ey = [[320], [240, 420], [200, 320, 440]][ext.length - 1] || [];
		ext.forEach((a, i) => {
			P[a] = { x: 122, y: ey[i], w: 170, h: 52 };
		});
		used.forEach((a) => {
			if (FIXED[L][a]) P[a] = FIXED[L][a];
		});
		return { P, used, frames: FRAMES[L].filter((fr) => fr.m.some((m) => used.includes(m))) };
	}

	/* ---------- Geometry ---------- */
	function clip(n, toward) {
		const dx = toward.x - n.x,
			dy = toward.y - n.y;
		const s = Math.min((n.w / 2 + 5) / Math.abs(dx || 1e-6), (n.h / 2 + 5) / Math.abs(dy || 1e-6));
		return { x: n.x + dx * s, y: n.y + dy * s };
	}
	function quadAt(s, c, e, t) {
		return {
			x: (1 - t) * (1 - t) * s.x + 2 * (1 - t) * t * c.x + t * t * e.x,
			y: (1 - t) * (1 - t) * s.y + 2 * (1 - t) * t * c.y + t * t * e.y,
		};
	}
	function cubicAt(p0, p1, p2, p3, t) {
		const u = 1 - t;
		return {
			x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
			y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
		};
	}
	function arrowGeom(P, a, b, off) {
		const A = P[a],
			B = P[b];
		if (a === b) {
			const top = A.y - A.h / 2,
				h = 52 + off;
			const p0 = { x: A.x - 30, y: top - 2 },
				p1 = { x: A.x - 48, y: top - h },
				p2 = { x: A.x + 48, y: top - h },
				p3 = { x: A.x + 30, y: top - 4 };
			return {
				d: `M${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`,
				s: p0,
				at: (t) => cubicAt(p0, p1, p2, p3, t),
			};
		}
		const mx = (A.x + B.x) / 2,
			my = (A.y + B.y) / 2,
			dx = B.x - A.x,
			dy = B.y - A.y,
			L = Math.hypot(dx, dy) || 1;
		const c = { x: mx - (dy / L) * off, y: my + (dx / L) * off };
		const s = clip(A, c),
			e = clip(B, c);
		return { d: `M${s.x} ${s.y} Q${c.x} ${c.y} ${e.x} ${e.y}`, s, at: (t) => quadAt(s, c, e, t) };
	}
	/* Offsets so repeated arrows between the same pair fan out instead of overlapping */
	function geomFor(P, list) {
		const counts = {};
		const offs = list.map((s) => {
			const k = `${s.f}>${s.t}`;
			counts[k] = (counts[k] ?? -1) + 1;
			const n = counts[k];
			return s.f === s.t ? n * 20 : 18 + n * 30;
		});
		return (s, j) => arrowGeom(P, s.f, s.t, offs[j]);
	}

	/* ---------- Helpers ---------- */
	const prefix = (p, q) => p.length <= q.length && p.every((v, i) => v === q[i]);
	const esc = (s) =>
		String(s).replace(
			/[&<>"]/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
		);
	const who = (a) =>
		`<span class="who"><span class="dot" style="color:${col(a)}"></span>${esc(ACT[a].l)}</span>`;
	const textW = (s, px = 6.9) => s.length * px + 18;
	const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
	const marker = (id) => `url(#ah-${id})`;
	const LEVELS = [
		[1, "Overview"],
		[2, "Components"],
		[3, "Details"],
	];

	const DARK = `--bg: #0e131a; --surface: #151c25; --surface-2: #1a222c; --band: #222c38;
    --fg: #e5eaf0; --fg-2: #a3afbd; --fg-3: #7f8b99; --line: #2a3542; --line-2: #45525f; --hair: #3a4654;
    --accent: #7ea8ef; --accent-soft: rgba(126, 168, 239, 0.2); --on-accent: #0e131a; --ok: #4fc596;
    --c-person: #ee84ad; --c-ext: #cfa47c; --c-watch: #f0a73a; --c-server: #7ea8ef; --c-worker: #4fc596; --c-model: #ae95f2;
    color-scheme: dark;`;
	const STYLE = `
:host {
  display: block; text-align: left; letter-spacing: normal;
  --bg: #f4f6f9; --surface: #ffffff; --surface-2: #f8fafc; --band: #eef2f7;
  --fg: #18212b; --fg-2: #4c5968; --fg-3: #687483; --line: #d9dee5; --line-2: #aeb7c2; --hair: #c3cbd5;
  --accent: #2f61b7; --accent-soft: rgba(47, 97, 183, 0.14); --on-accent: #ffffff; --ok: #157a52;
  --c-person: #b03a6a; --c-ext: #7a5c3e; --c-watch: #b26a00; --c-server: #2f61b7; --c-worker: #157a52; --c-model: #6d4bc4;
  --sans: "Public Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace;
  --r: 10px;
  color: var(--fg); font: 14px/1.5 var(--sans);
}
@media (prefers-color-scheme: dark) { :host(:not([color-scheme="light"])) { ${DARK} } }
:host([color-scheme="dark"]) { ${DARK} }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
a { color: var(--accent); }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.panel:focus-visible { outline-offset: -2px; }
p { margin: 0; }

.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }

/* Deck: play button + chapter timeline (one rounded bar split into step segments, chapter names above) */
.deck { display: flex; gap: 10px 22px; align-items: center; padding: 8px 20px 7px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.tbtn.play { flex: none; width: 40px; height: 32px; display: inline-grid; place-items: center; border: 0; border-radius: 8px; background: var(--fg); color: var(--bg); cursor: pointer; }
.tbtn.play svg { width: 14px; height: 14px; }
.tl { position: relative; flex: 1 1 auto; min-width: 0; height: 40px; cursor: pointer; user-select: none; touch-action: none; }
.tl-cap { position: absolute; left: 0; top: 25px; width: 12px; height: 10px; border-radius: 5px 0 0 5px; background: var(--accent); }
.tl-cap:hover { box-shadow: 0 0 0 3px var(--accent-soft); }
.tl-steps { position: absolute; left: 13px; right: 0; top: 0; bottom: 0; }
.tl-name { position: absolute; top: 1px; height: 18px; display: flex; align-items: center; justify-content: center; }
.tl-name button { border: 0; background: none; padding: 0 6px; font-size: 12px; font-weight: 600; line-height: 18px; color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; cursor: pointer; }
.tl-name button:hover { color: var(--accent); }
.tl-name.cur button { color: var(--fg); }
.tl-div { position: absolute; top: 3px; height: 14px; width: 1px; background: var(--line-2); }
.tl-seg { position: absolute; top: 25px; height: 10px; background: var(--band); }
.tl-seg.on { background: var(--accent); }
.tl-seg.last:not(.on) { border-radius: 0 5px 5px 0; }
.tl-seg:hover { filter: brightness(0.95); }
/* the last filled piece ends in a pointed head instead of a square edge; it stays inside its own segment */
.tl-cap.tip, .tl-seg.tip { clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%); }
.tl-seg.hover:not(.on) { background: color-mix(in srgb, var(--accent) 22%, var(--band)); }
.tl-seg.hover.on { filter: brightness(1.12); }
#tl-tip { position: fixed; z-index: 30; max-width: calc(100vw - 16px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--fg); color: var(--bg); border-radius: 6px; padding: 3px 9px; font-size: 12px; line-height: 18px; pointer-events: none; box-shadow: 0 4px 14px rgba(15, 25, 40, .18); }
#tl-tip b { font: 600 11px var(--mono); opacity: .7; margin-right: 6px; }
#tl-tip .dot { width: 7px; height: 7px; margin: 0 4px 1px 0; vertical-align: middle; }
@media (max-width: 640px) { .deck { padding: 8px 12px; gap: 12px; } .tl-name button { font-size: 11px; padding: 0 2px; } }

.intro { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 20px; padding: 10px 16px 0; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--fg-2); margin-left: auto; }
.legend span { display: inline-flex; gap: 6px; align-items: center; }
.seg { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--surface); flex-wrap: wrap; }
.seg button { border: 0; background: transparent; padding: 5px 12px; cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--fg-2); border-right: 1px solid var(--line); white-space: nowrap; }
.seg button:last-child { border-right: 0; }
.seg button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); }
.seg button small { font-weight: 500; opacity: .75; margin-left: 5px; font-family: var(--mono); }
/* the diagram always scales to the panel width, so the element never needs a scrollbar */
.svg-wrap { padding: 4px 8px; }
.svg-wrap svg { display: block; width: 100%; height: auto; }
.svg-wrap text { font-family: var(--sans); }
.frame rect { fill: var(--surface-2); stroke: var(--line-2); stroke-dasharray: 5 4; }
.frame.lw rect { fill: color-mix(in srgb, var(--c-server) 4%, var(--surface)); stroke: color-mix(in srgb, var(--c-server) 45%, var(--line)); stroke-dasharray: none; }
.frame text { font-size: 12px; font-weight: 700; fill: var(--fg-2); letter-spacing: 0.08em; text-transform: uppercase; }
.frame, .node { transition: opacity .4s; }
.node { cursor: pointer; }
.node rect { fill: var(--surface); stroke-width: 1.6; transition: stroke-width .2s; }
.node .nl { font-size: 13.5px; font-weight: 700; fill: var(--fg); }
.node .ns { font-size: 10.5px; fill: var(--fg-3); }
.node.hot rect { stroke-width: 3.5; }
.node.quiet { opacity: .32; }
.gone { opacity: 0; pointer-events: none; }
.edge { fill: none; stroke-width: 2; stroke-linecap: round; }
.edge.cur { stroke-width: 3; }
.pill rect { fill: var(--surface); stroke-width: 1.4; }
.pill text { font-size: 12.5px; font-weight: 600; fill: var(--fg); }
.pill .num { font: 700 11px var(--mono); }
.pill.cur rect { stroke-width: 2.4; }
.lead { stroke-width: 1.2; stroke-dasharray: 2 2; }
.next { cursor: pointer; }
.next .ring { fill: none; stroke-width: 2.5; animation: ring 1.4s ease-out infinite; transform-box: fill-box; transform-origin: center; }
.next .core { stroke: var(--surface); stroke-width: 2.5; }
.next text { font-size: 12px; font-weight: 700; fill: var(--fg); }
.next .hint-bg { fill: var(--surface); stroke: var(--line-2); }
.next .key { fill: var(--surface-2); stroke: var(--line-2); stroke-width: 1.2; filter: drop-shadow(0 1.5px 0 var(--line-2)); }
.next .key-l { font: 600 12px var(--mono); fill: var(--fg); }
@keyframes ring { 0% { transform: scale(.6); opacity: 1; } 100% { transform: scale(1.8); opacity: 0; } }
.state rect.card { fill: var(--surface); stroke: var(--line-2); }
.state .st-t { font-size: 13px; font-weight: 700; fill: var(--fg); }
.state .st-s { font-size: 10.5px; fill: var(--fg-3); }
.state .st-k { font-size: 11.5px; fill: var(--fg-3); }
.state .st-v { font-size: 11.5px; font-weight: 600; fill: var(--fg); }
.state .st-v.empty { fill: var(--fg-3); font-weight: 400; }
.state .chg rect { fill: var(--accent-soft); }
.state .chg .st-v { fill: var(--accent); }
.state .file rect { fill: var(--surface-2); stroke: var(--line-2); }
.state .file.new rect { fill: var(--accent-soft); stroke: var(--accent); }
.state .file text { font: 10.5px var(--mono); fill: var(--fg-2); }
.state .file path { fill: none; stroke: var(--fg-3); stroke-width: 1.3; stroke-linecap: round; }
.caption { border-top: 1px solid var(--line); padding: 12px 16px 14px; display: flex; flex-direction: column; gap: 6px; }
.cap-top { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--fg-3); }
.cap-top .who { display: inline-flex; gap: 6px; align-items: center; font-weight: 600; color: var(--fg-2); }
.cap-title { font-size: 17px; font-weight: 700; margin: 0; text-wrap: balance; }
.cap-text { margin: 0; color: var(--fg-2); max-width: 78ch; }
.terms { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--fg-3); }
.terms a { font-weight: 600; text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 1px 9px; color: var(--fg-2); }
.terms a:hover { border-color: var(--accent); color: var(--accent); }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: currentColor; display: inline-block; }
#tip { position: fixed; z-index: 20; max-width: 300px; background: var(--fg); color: var(--bg); padding: 9px 11px; border-radius: 8px; font-size: 12.5px; line-height: 1.45; pointer-events: none; box-shadow: 0 6px 24px rgba(0,0,0,.2); }
#tip b { display: block; margin-bottom: 2px; }
#tip small { display: block; margin-top: 4px; opacity: .7; font-family: var(--mono); font-size: 11px; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
	const MARKUP = `
<section class="panel" tabindex="0" aria-label="Process walk-through. Use the arrow keys to step, space to play.">
  <div class="deck">
    <button class="tbtn play" id="t-play" aria-label="Play" title="Play / pause (space)"><svg viewBox="0 0 16 16"><path id="play-ico" d="M4 2l10 6-10 6z" fill="currentColor"/></svg></button>
    <div class="tl" id="tl" role="slider" tabindex="0" aria-label="Timeline: click the rounded start to go back to the beginning"></div>
  </div>
  <div class="intro"><div class="seg" id="zoom" role="group" aria-label="Zoom" hidden></div><div class="legend" id="legend"></div></div>
  <div class="svg-wrap" id="svg-wrap"></div>
  <div class="caption" aria-live="polite" id="caption"></div>
</section>
<div id="tip" hidden></div>
<div id="tl-tip" role="tooltip" hidden></div>`;

	/* One player per element. It owns the walk-through state and renders into the element's shadow root. */
	function createPlayer(host, root) {
		const $ = (s) => root.querySelector(s);
		const $$ = (s) => root.querySelectorAll(s);
		const st = {
			flow: "triage",
			level: 1,
			i: -1,
			path: null,
			prev: -2,
			playing: false,
			timer: null,
			cardRect: null,
		};
		const F = () => FLOWS[st.flow];
		const items = () => F().flat[st.level];
		const zoomable = () => host.hasAttribute("zoom-controls");
		const href = (path) => {
			const base = host.getAttribute("docs-base");
			if (base === null) return DOCS + path;
			const [file, hash] = path.split("#");
			const page = file.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "/");
			return new URL(page + (hash ? `#${hash}` : ""), new URL(base, document.baseURI)).href;
		};
		const term = (k) => {
			const c = C[k];
			return `<a href="${href(c.path)}" data-c="${k}">${esc(c.label)}</a>`;
		};
		const emit = () =>
			host.dispatchEvent(
				new CustomEvent("step", {
					detail: {
						flow: st.flow,
						level: st.level,
						step: st.i,
						total: items().length,
						playing: st.playing,
					},
				}),
			);

		/* ---------- Chapters ---------- */
		/* Components and Details get finer chapters, so no chapter turns into a wall of arrows */
		const chapters = () => (st.level >= 2 && F().chaptersDetail) || F().chapters;
		function chapterOf(s) {
			const ch = chapters();
			let c = 0;
			ch.forEach(([, from], i) => {
				if (s.path[0] >= from) c = i;
			});
			return c;
		}
		function chapterSpans() {
			const list = items();
			return chapters().map(([name], c) => {
				let first = -1,
					last = -1;
				list.forEach((s, j) => {
					if (chapterOf(s) === c) {
						if (first < 0) first = j;
						last = j;
					}
				});
				return { name, c, first, last };
			});
		}
		const curChapter = () => {
			const list = items();
			const s = list[Math.max(0, st.i)];
			return chapterOf(s);
		};

		/* ---------- Controls ---------- */
		function renderControls() {
			const z = $("#zoom");
			z.hidden = !zoomable();
			z.innerHTML = LEVELS.map(
				([l, n]) =>
					`<button data-l="${l}" aria-pressed="${l === st.level}">${n}<small>${F().flat[l].length}</small></button>`,
			).join("");
		}

		/* ---------- Timeline (movie-editor style) ---------- */
		function renderTimeline() {
			const list = items(),
				n = list.length,
				spans = chapterSpans(),
				cc = st.i >= 0 ? curChapter() : -1;
			let steps = "";
			spans.forEach((sp, k) => {
				const left = (sp.first / n) * 100,
					width = ((sp.last - sp.first + 1) / n) * 100;
				if (k > 0) steps += `<div class="tl-div" style="left:${left}%"></div>`;
				steps += `<div class="tl-name ${sp.c === cc ? "cur" : ""}" style="left:${left}%;width:${width}%"><button data-first="${sp.first}" data-c="${sp.c}" aria-label="Jump to the start of ${esc(sp.name)}">${esc(sp.name)}</button></div>`;
			});
			list.forEach((_s, j) => {
				steps += `<div class="tl-seg ${j <= st.i ? "on" : ""} ${j === st.i ? "tip" : ""} ${j === n - 1 ? "last" : ""}" style="left:calc(${(j / n) * 100}% + 1px);width:calc(${100 / n}% - 2px)"></div>`;
			});
			const tl = $("#tl");
			tl.innerHTML = `<div class="tl-cap ${st.i < 0 ? "tip" : ""}"></div><div class="tl-steps" id="tl-steps">${steps}</div>`;
			tl.setAttribute("aria-valuemin", 0);
			tl.setAttribute("aria-valuemax", n);
			tl.setAttribute("aria-valuenow", st.i + 1);
			tl.setAttribute(
				"aria-valuetext",
				st.i < 0 ? "Beginning" : `Step ${st.i + 1} of ${n}, ${spans[cc].name}`,
			);
			tl.querySelectorAll(".tl-name button").forEach((b) => {
				b.addEventListener("click", (e) => {
					e.stopPropagation();
					stop();
					setI(+b.dataset.first - 1);
				});
			});
			$("#play-ico").setAttribute("d", st.playing ? "M3 2h4v12H3zM9 2h4v12H9z" : "M4 2l10 6-10 6z");
			$("#t-play").setAttribute("aria-label", st.playing ? "Pause" : "Play");
		}
		/* Timeline tooltip: appears immediately, follows the pointer, works across the gaps between segments */
		function tlTarget(e) {
			const r = $("#tl-steps").getBoundingClientRect(),
				n = items().length;
			const name = e.target.closest?.(".tl-name button");
			if (name) {
				const b = name.getBoundingClientRect();
				return { kind: "chapter", c: +name.dataset.c, x: b.left + b.width / 2 };
			}
			if (e.clientX < r.left) {
				const cap = $("#tl .tl-cap").getBoundingClientRect();
				return { kind: "start", x: cap.left + cap.width / 2 };
			}
			const j = Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n));
			return { kind: "step", j, x: r.left + ((j + 0.5) / n) * r.width };
		}
		let tlPointer = null;
		function refreshTlTip() {
			if (!tlPointer || $("#tl-tip").hidden) return;
			const el = root.elementFromPoint(tlPointer.x, tlPointer.y);
			if (el?.closest("#tl")) showTlTip({ clientX: tlPointer.x, clientY: tlPointer.y, target: el });
			else hideTlTip();
		}
		function showTlTip(e) {
			tlPointer = { x: e.clientX, y: e.clientY };
			const t = tlTarget(e),
				list = items(),
				tip = $("#tl-tip");
			const d = (a) => `<span class="dot" style="color:${col(a)}"></span>`;
			let html;
			if (t.kind === "start") html = "Back to the beginning";
			else if (t.kind === "chapter") {
				const sp = chapterSpans()[t.c];
				html = `<b>${sp.first + 1}–${sp.last + 1}</b>${esc(sp.name)}`;
			} else {
				const s = list[t.j];
				html = `<b>${t.j + 1}</b>${d(s.f)}${esc(ACT[s.f].l)} ${s.f === s.t ? "" : `→ ${d(s.t)}${esc(ACT[s.t].l)} `}· ${esc(s.l)}`;
			}
			tip.innerHTML = html;
			tip.hidden = false;
			$$("#tl .tl-seg").forEach((el, k) => {
				el.classList.toggle("hover", t.kind === "step" && k === t.j);
			});
			const tl = $("#tl").getBoundingClientRect(),
				w = tip.offsetWidth;
			tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, t.x - w / 2))}px`;
			tip.style.top = `${tl.bottom + 4}px`;
		}
		function hideTlTip() {
			$("#tl-tip").hidden = true;
			$$("#tl .tl-seg.hover").forEach((el) => {
				el.classList.remove("hover");
			});
		}

		/* Clicking the rounded start (left of the first segment) resets; clicking a segment reveals up to that step */
		function scrubTo(e) {
			const r = $("#tl-steps").getBoundingClientRect(),
				n = items().length;
			const i =
				e.clientX < r.left ? -1 : Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n));
			if (i !== st.i) setI(i);
		}

		/* ---------- Caption ---------- */
		function renderCaption() {
			const list = items();
			if (st.i < 0) {
				const s = list[0];
				$("#caption").innerHTML =
					`<div class="cap-top"><span>How it starts</span></div><p class="cap-title">${esc(F().name)}</p><p class="cap-text">${esc(F().startText)} Click the pulsing dot on <b>${esc(ACT[s.f].l)}</b>, or press play.</p>`;
				return;
			}
			const s = list[st.i],
				sp = chapterSpans()[chapterOf(s)];
			const route = s.f === s.t ? who(s.f) : `${who(s.f)}<span>→</span>${who(s.t)}`;
			$("#caption").innerHTML =
				`<div class="cap-top"><span>${esc(sp.name)} · step ${st.i + 1} of ${list.length}</span>${route}</div>
      <p class="cap-title">${esc(ACT[s.f].l)} ${esc(s.l)}</p><p class="cap-text">${esc(s.x)}</p>
      ${s.c.length ? `<div class="terms">In Leitwerk terms: ${s.c.map(term).join("")}</div>` : ""}`;
		}
		function renderLegend() {
			const g = new Set(lay.used.map((a) => ACT[a].g));
			const names = {
				person: "People",
				ext: "Outside tools",
				watch: "Watcher",
				server: "Leitwerk server",
				worker: "Worker",
				model: "AI model",
			};
			$("#legend").innerHTML = GROUPS.filter((x) => g.has(x))
				.map((x) => `<span><span class="dot" style="color:var(--c-${x})"></span>${names[x]}</span>`)
				.join("");
		}

		/* ---------- Diagram skeleton ---------- */
		let lay = null;
		function renderDiagram() {
			lay = layout(F(), st.level);
			const { P, used, frames } = lay;
			$("#svg-wrap").innerHTML =
				`<svg viewBox="0 0 ${VB.w} ${VB.h}" role="img" aria-label="${esc(F().name)}: components and messages">
      <defs>${GROUPS.map((g) => `<marker id="ah-${g}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--c-${g})"/></marker>`).join("")}</defs>
      <g id="frames">${frames.map((fr) => `<g class="frame ${fr.cls}" data-m="${fr.m.join(" ")}"><rect x="${fr.x}" y="${fr.y}" width="${fr.w}" height="${fr.h}" rx="16"/><text x="${fr.x + 14}" y="${fr.y + 21}">${fr.label}</text></g>`).join("")}</g>
      <g id="state"></g>
      <g id="edges"></g>
      <g id="nodes">${used
				.map((a) => {
					const n = P[a],
						A = ACT[a],
						person = A.g === "person";
					return `<g class="node" data-n="${a}" ${A.c ? `tabindex="0" role="link"` : ""} aria-label="${esc(A.l)}"><rect x="${n.x - n.w / 2}" y="${n.y - n.h / 2}" width="${n.w}" height="${n.h}" rx="${person ? n.h / 2 : a === "lw" ? 18 : 10}" stroke="${col(a)}"/>
          <text class="nl" x="${n.x}" y="${n.y - 2}" text-anchor="middle">${esc(A.l)}</text><text class="ns" x="${n.x}" y="${n.y + 14}" text-anchor="middle">${esc(A.s)}</text></g>`;
				})
				.join("")}</g>
      <g id="labels"></g>
      <g id="next"></g>
    </svg>`;
			$$("#nodes .node").forEach((g) => {
				const A = ACT[g.dataset.n];
				if (!A.c) return;
				const open = () => {
					location.href = href(C[A.c].path);
				};
				g.addEventListener("click", open);
				g.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.stopPropagation();
						open();
					}
				});
				g.addEventListener("mouseenter", (e) => showTip(A.c, e));
				g.addEventListener("mouseleave", hideTip);
			});
			renderLegend();
			st.prev = -2;
		}

		/* Ticket state card, bottom-right inside the canvas */
		const CLIP = "M3 7.5 7.2 3.3a2.1 2.1 0 0 1 3 3L5.6 10.9a1.2 1.2 0 0 1-1.7-1.7L8 5.1";
		function renderState() {
			const S0 = F().state,
				lastOf = F().lastOf[st.level];
			const val = { ...S0.init },
				changed = new Set(),
				files = [],
				newFiles = new Set();
			Object.entries(S0.patch).forEach(([k, p]) => {
				const at = lastOf[+k];
				if (at >= 0 && at <= st.i) {
					Object.assign(val, p);
					if (at === st.i)
						Object.keys(p).forEach((x) => {
							changed.add(x);
						});
				}
			});
			Object.entries(S0.files || {}).forEach(([k, fs]) => {
				const at = lastOf[+k];
				if (at >= 0 && at <= st.i) {
					files.push(...fs);
					if (at === st.i)
						fs.forEach((f) => {
							newFiles.add(f);
						});
				}
			});
			const W = 280,
				RH = 20,
				hasFiles = !!S0.files;
			// lay file chips out in rows inside the card
			const chips = [];
			let cx = 0,
				rowsF = files.length ? 1 : 0;
			files.forEach((f) => {
				const w = f.length * 6.3 + 28;
				if (cx + w > W - 28 && cx > 0) {
					rowsF++;
					cx = 0;
				}
				chips.push({ f, x: cx, row: rowsF - 1, w });
				cx += w + 6;
			});
			const filesH = hasFiles ? 26 + Math.max(1, rowsF) * 26 : 0;
			const H = 52 + S0.rows.length * RH + filesH,
				x = VB.w - W - 8,
				y = VB.h - H - 8;
			st.cardRect = { x, y, w: W, h: H };
			let g = `<rect class="card" x="${x}" y="${y}" width="${W}" height="${H}" rx="12"/>
      <text class="st-t" x="${x + 14}" y="${y + 22}">${esc(S0.title)}</text><text class="st-s" x="${x + 14}" y="${y + 38}">${esc(S0.sub)}</text>`;
			S0.rows.forEach((r, ri) => {
				const ry = y + 48 + ri * RH,
					v = val[r],
					chg = changed.has(r);
				g += `<g class="${chg ? "chg" : ""}">${chg ? `<rect x="${x + 6}" y="${ry}" width="${W - 12}" height="${RH - 2}" rx="5"/>` : ""}<text class="st-k" x="${x + 14}" y="${ry + 13.5}">${esc(r)}</text><text class="st-v ${v ? "" : "empty"}" x="${x + 96}" y="${ry + 13.5}">${esc(v || "—")}</text></g>`;
			});
			if (hasFiles) {
				const fy = y + 52 + S0.rows.length * RH;
				g += `<text class="st-k" x="${x + 14}" y="${fy + 16}">Attachments</text>`;
				if (!files.length)
					g += `<text class="st-v empty" x="${x + 14}" y="${fy + 38}">none yet</text>`;
				chips.forEach((ch) => {
					const cx0 = x + 14 + ch.x,
						cy0 = fy + 24 + ch.row * 26;
					g += `<g class="file ${newFiles.has(ch.f) ? "new" : ""}"><rect x="${cx0}" y="${cy0}" width="${ch.w}" height="20" rx="5"/><path transform="translate(${cx0 + 5} ${cy0 + 3})" d="${CLIP}"/><text x="${cx0 + 21}" y="${cy0 + 14}">${esc(ch.f)}</text></g>`;
				});
			}
			$("#state").innerHTML = `<g class="state">${g}</g>`;
		}

		/* Which components are visible: everything involved so far, plus whoever acts next */
		function showNodes(revealed, quietExcept) {
			const list = items(),
				shown = new Set();
			revealed.forEach((s) => {
				shown.add(s.f);
				shown.add(s.t);
			});
			if (list[st.i + 1]) shown.add(list[st.i + 1].f);
			const cur = list[st.i];
			$$("#nodes .node").forEach((g) => {
				const n = g.dataset.n;
				g.classList.toggle("gone", !shown.has(n));
				g.classList.toggle("hot", !!cur && (n === cur.f || n === cur.t));
				g.classList.toggle("quiet", !quietExcept.has(n));
			});
			$$("#frames .frame").forEach((fr) => {
				fr.classList.toggle("gone", !fr.dataset.m.split(" ").some((m) => shown.has(m)));
			});
			return shown;
		}

		/* ---------- Label placement: each label sits on its own arrow, never on another label or a component ---------- */
		function overlaps(a, b, m = 3) {
			return (
				a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m
			);
		}
		function placeLabels(entries, shown) {
			const obstacles = [];
			shown.forEach((n) => {
				const p = lay.P[n];
				obstacles.push({ x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h });
			});
			if (st.cardRect) obstacles.push(st.cardRect);
			const placed = [];
			let out = "";
			entries.forEach((e) => {
				const text = e.text,
					w = textW(text) + 18,
					h = 24;
				const free = (r) =>
					r.x >= 2 &&
					r.y >= 2 &&
					r.x + r.w <= VB.w - 2 &&
					r.y + r.h <= VB.h - 2 &&
					!placed.some((p) => overlaps(r, p)) &&
					!obstacles.some((o) => overlaps(r, o, 1));
				let best = null;
				for (const t of [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75, 0.18, 0.82]) {
					const p = e.g.at(t),
						r = { x: p.x - w / 2, y: p.y - h / 2, w, h };
					if (free(r)) {
						best = { r, anchor: null };
						break;
					}
				}
				if (!best) {
					const a = e.g.at(0.5),
						a2 = e.g.at(0.52),
						dx = a2.x - a.x,
						dy = a2.y - a.y,
						L = Math.hypot(dx, dy) || 1,
						nx = -dy / L,
						ny = dx / L;
					const ds = [];
					for (let d = 34; d <= 260; d += 26) ds.push(d, -d);
					outer: for (const d of ds)
						for (const t of [0.5, 0.35, 0.65, 0.22, 0.78]) {
							const p = e.g.at(t),
								c = { x: p.x + nx * d, y: p.y + ny * d },
								r = { x: c.x - w / 2, y: c.y - h / 2, w, h };
							if (free(r)) {
								best = { r, anchor: p };
								break outer;
							}
						}
				}
				if (!best) {
					// last resort: nearest free spot on a grid around the arrow's middle
					const p = e.g.at(0.5);
					let bestD = Infinity;
					for (let gx = -360; gx <= 360; gx += 20)
						for (let gy = -300; gy <= 300; gy += 14) {
							const r = { x: p.x + gx - w / 2, y: p.y + gy - h / 2, w, h },
								d = gx * gx + gy * gy;
							if (d < bestD && free(r)) {
								bestD = d;
								best = { r, anchor: p };
							}
						}
				}
				if (!best) {
					const p = e.g.at(0.5);
					best = {
						r: { x: Math.max(2, Math.min(VB.w - w - 2, p.x - w / 2)), y: p.y - h / 2, w, h },
						anchor: null,
					};
				}
				placed.push(best.r);
				const { r } = best;
				let lead = "";
				if (best.anchor) {
					const cx = Math.max(r.x, Math.min(r.x + r.w, best.anchor.x)),
						cy = Math.max(r.y, Math.min(r.y + r.h, best.anchor.y));
					lead = `<line class="lead" x1="${cx}" y1="${cy}" x2="${best.anchor.x}" y2="${best.anchor.y}" stroke="${e.color}"/><circle cx="${best.anchor.x}" cy="${best.anchor.y}" r="3.5" fill="${e.color}"/>`;
				}
				out += `<g class="pill ${e.cur ? "cur" : ""}" data-j="${e.j}">${lead}<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="12" stroke="${e.color}"/>
        <text x="${r.x + 12}" y="${r.y + 16.5}"><tspan class="num" fill="${e.color}">${e.j + 1}</tspan><tspan dx="7">${esc(text)}</tspan></text></g>`;
			});
			return out;
		}

		/* Pulsing dot at the start of the next arrow */
		function renderNext(gf) {
			const list = items(),
				s = list[st.i + 1];
			if (!s) {
				$("#next").innerHTML = "";
				return;
			}
			const p = gf(s, st.i + 1).s,
				c = col(s.f);
			let hint = "";
			if (st.i < 0) {
				// "Click or press [→] to start", with the arrow drawn as a keyboard key
				const a = "Click or press",
					b = "to start",
					aw = a.length * 6.6,
					bw = b.length * 6.6,
					kw = 24,
					gap = 6,
					pad = 12;
				const w = pad + aw + gap + kw + gap + bw + pad,
					hx = Math.min(VB.w - w - 6, p.x + 18),
					hy = p.y - 14,
					kx = hx + pad + aw + gap;
				hint = `<g class="hint" data-hx="${hx}" data-p="${p.x}"><rect class="hint-bg" x="${hx}" y="${hy}" width="${w}" height="28" rx="14"/>
        <text class="h-a" x="${hx + pad}" y="${hy + 18}">${a}</text>
        <rect class="key" x="${kx}" y="${hy + 4}" width="${kw}" height="20" rx="4"/><text class="key-l" x="${kx + kw / 2}" y="${hy + 18}" text-anchor="middle">→</text>
        <text class="h-b" x="${kx + kw + gap}" y="${hy + 18}">${b}</text></g>`;
			}
			$("#next").innerHTML =
				`<g class="next" tabindex="0" role="button" aria-label="Reveal next step"><circle class="ring" cx="${p.x}" cy="${p.y}" r="10" stroke="${c}"/><circle class="core" cx="${p.x}" cy="${p.y}" r="8" fill="${c}"/>${hint}<title>Next: ${esc(ACT[s.f].l)} ${esc(s.l)}</title></g>`;
			fitHint();
			const n = $("#next .next");
			n.addEventListener("click", () => {
				stop();
				next();
			});
			n.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					e.stopPropagation();
					stop();
					next();
				}
			});
		}

		/* Lay the start hint out from the real text widths, so the key sits right after "Click or press" */
		function fitHint() {
			const g = $("#next .hint"),
				ta = g?.querySelector(".h-a");
			if (!ta?.getComputedTextLength) return;
			const pad = 12,
				gap = 6,
				kw = 24;
			const aw = g.querySelector(".h-a").getComputedTextLength(),
				bw = g.querySelector(".h-b").getComputedTextLength();
			if (!aw) return;
			const w = pad + aw + gap + kw + gap + bw + pad,
				hx = Math.min(VB.w - w - 6, +g.dataset.p + 18),
				kx = hx + pad + aw + gap;
			const bg = g.querySelector(".hint-bg"),
				key = g.querySelector(".key");
			bg.setAttribute("x", hx);
			bg.setAttribute("width", w);
			g.querySelector(".h-a").setAttribute("x", hx + pad);
			key.setAttribute("x", kx);
			g.querySelector(".key-l").setAttribute("x", kx + kw / 2);
			g.querySelector(".h-b").setAttribute("x", kx + kw + gap);
		}

		/* New arrow draws itself from the sender to the receiver, then its label fades in */
		function animateNew(markerId) {
			const path = $("#cur-edge"),
				lbl = $("#labels .pill.cur");
			const finish = () => {
				if (path) path.setAttribute("marker-end", marker(markerId));
				if (lbl) {
					lbl.style.transition = "opacity .25s";
					lbl.style.opacity = 1;
				}
			};
			if (!path || reduced() || st.i !== st.prev + 1) {
				finish();
				return;
			}
			const len = path.getTotalLength();
			path.style.strokeDasharray = len;
			path.style.strokeDashoffset = len;
			if (lbl) lbl.style.opacity = 0;
			path.getBoundingClientRect();
			path.style.transition = "stroke-dashoffset 480ms ease-out";
			path.style.strokeDashoffset = 0;
			setTimeout(() => {
				path.style.strokeDasharray = "";
				path.style.transition = "";
				finish();
			}, 500);
		}

		/* One chapter at a time: earlier chapters' arrows disappear, components outside the current chapter step back */
		function renderChapterView() {
			const list = items(),
				{ P } = lay,
				revealed = list.slice(0, st.i + 1),
				gf = geomFor(P, list);
			const cc = st.i >= 0 ? curChapter() : list[0] ? chapterOf(list[0]) : 0;
			let edges = "";
			const labelEntries = [];
			revealed.forEach((s, j) => {
				if (chapterOf(s) < cc) return;
				const g = gf(s, j),
					cur = j === st.i;
				edges += `<path class="edge ${cur ? "cur" : ""}" ${cur ? 'id="cur-edge"' : ""} d="${g.d}" stroke="${col(s.f)}" ${cur ? "" : `marker-end="${marker(ACT[s.f].g)}"`}/>`;
				labelEntries.push({ g, text: s.l, color: col(s.f), j, cur });
			});
			$("#edges").innerHTML = edges;
			const active = new Set();
			list.forEach((s, j) => {
				if (chapterOf(s) === cc && j <= st.i + 1) {
					active.add(s.f);
					if (j <= st.i) active.add(s.t);
				}
			});
			const shown = showNodes(revealed, active);
			$("#labels").innerHTML = placeLabels(labelEntries, shown);
			if (st.i >= 0) animateNew(ACT[list[st.i].f].g);
			renderNext(gf);
		}

		/* ---------- Orchestration ---------- */
		function update() {
			renderTimeline();
			refreshTlTip();
			renderState();
			renderChapterView();
			renderCaption();
			$$("#labels .pill").forEach((p) => {
				p.addEventListener("click", () => {
					stop();
					setI(+p.dataset.j);
				});
			});
			st.prev = st.i;
			emit();
		}
		function render() {
			renderControls();
			renderDiagram();
			update();
		}
		function setI(i) {
			const list = items();
			st.i = Math.max(-1, Math.min(list.length - 1, i));
			st.path = st.i >= 0 ? list[st.i].path : null;
			update();
		}
		function next() {
			setI(st.i + 1);
		}
		function back() {
			setI(st.i - 1);
		}
		function play() {
			if (st.i >= items().length - 1) setI(-1);
			st.playing = true;
			renderTimeline();
			emit();
			tick();
		}
		function stop() {
			if (!st.playing) return;
			st.playing = false;
			clearTimeout(st.timer);
			renderTimeline();
			emit();
		}
		function tick() {
			clearTimeout(st.timer);
			if (!st.playing) return;
			st.timer = setTimeout(() => {
				if (st.i >= items().length - 1) {
					stop();
					return;
				}
				next();
				tick();
			}, [0, 2200, 1700, 1400][st.level]);
		}
		function setLevel(l) {
			if (l === st.level) return;
			const keep = st.path;
			st.level = l;
			const list = items();
			if (keep) {
				let j = -1;
				list.forEach((s, k) => {
					if (prefix(keep, s.path)) j = k;
				}); // zooming in: reveal all detail of the current step
				if (j < 0) j = list.findIndex((s) => prefix(s.path, keep)); // zooming out: its parent step
				st.i = j;
				st.path = list[j].path;
			} else st.i = -1;
			render();
		}
		function setFlow(f) {
			if (f === st.flow) return;
			stop();
			st.flow = f;
			st.i = -1;
			st.path = null;
			render();
		}

		/* ---------- Tooltip ---------- */
		const tip = $("#tip");
		function showTip(k, e) {
			const c = C[k];
			if (!c) return;
			tip.innerHTML = `<b>${esc(c.label)}</b>${esc(c.def)}<small>docs/${esc(c.path)}</small>`;
			tip.hidden = false;
			moveTip(e);
		}
		function moveTip(e) {
			const r = tip.getBoundingClientRect();
			let x = e.clientX + 14,
				y = e.clientY + 16;
			if (x + r.width > innerWidth - 8) x = innerWidth - r.width - 8;
			if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 12;
			tip.style.left = `${x}px`;
			tip.style.top = `${y}px`;
		}
		function hideTip() {
			tip.hidden = true;
		}
		root.addEventListener("mouseover", (e) => {
			const a = e.target.closest("a[data-c]");
			if (a) showTip(a.dataset.c, e);
		});
		root.addEventListener("mousemove", (e) => {
			if (!tip.hidden) moveTip(e);
		});
		root.addEventListener("mouseout", (e) => {
			const a = e.target.closest("a[data-c]");
			if (a && !a.contains(e.relatedTarget)) hideTip();
		});

		/* ---------- Events ---------- */
		$("#zoom").addEventListener("click", (e) => {
			const b = e.target.closest("button");
			if (b) setLevel(+b.dataset.l);
		});
		$("#t-play").onclick = () => (st.playing ? stop() : play());
		const tl = $("#tl");
		tl.addEventListener("pointerdown", (e) => {
			if (e.target.closest(".tl-name button")) return;
			stop();
			tl.setPointerCapture(e.pointerId);
			scrubTo(e);
		});
		tl.addEventListener("pointermove", (e) => {
			if (tl.hasPointerCapture(e.pointerId)) scrubTo(e);
			if (e.pointerType !== "touch") showTlTip(e);
		});
		tl.addEventListener("pointerleave", hideTlTip);
		tl.addEventListener("pointerup", (e) => {
			if (e.pointerType === "touch") hideTlTip();
		});
		// keys only act while focus is inside the element, so the page around it keeps scrolling normally
		root.addEventListener("keydown", (e) => {
			if (e.key === "ArrowRight") {
				stop();
				next();
				e.preventDefault();
			} else if (e.key === "ArrowLeft") {
				stop();
				back();
				e.preventDefault();
			} else if (e.key === "Home") {
				stop();
				setI(-1);
				e.preventDefault();
			} else if (e.key === "End") {
				stop();
				setI(items().length - 1);
				e.preventDefault();
			} else if (e.key === " " && !e.target.closest("button")) {
				st.playing ? stop() : play();
				e.preventDefault();
			} else if (zoomable() && ["1", "2", "3"].includes(e.key)) setLevel(+e.key);
		});

		return {
			st,
			render,
			renderControls,
			renderCaption,
			setI,
			next,
			back,
			play,
			stop,
			setLevel,
			setFlow,
			hideTlTip,
			fitHint,
			get total() {
				return items().length;
			},
		};
	}

	class LeitwerkFlow extends HTMLElement {
		static observedAttributes = ["flow", "level", "zoom-controls", "docs-base"];

		connectedCallback() {
			if (!this.player) {
				if (!document.querySelector(`link[href="${FONT_URL}"]`)) {
					const link = document.createElement("link");
					link.rel = "stylesheet";
					link.href = FONT_URL;
					document.head.append(link);
				}
				const root = this.attachShadow({ mode: "open", delegatesFocus: true });
				root.innerHTML = `<style>${STYLE}</style>${MARKUP}`;
				this.player = createPlayer(this, root);
				this.player.st.flow = FLOWS[this.getAttribute("flow")]
					? this.getAttribute("flow")
					: "triage";
				this.player.st.level = this.#levelAttr();
				this.player.render();
				document.fonts?.ready.then(() => this.player.fitHint());
			}
			this.onScroll = () => this.player.hideTlTip();
			addEventListener("scroll", this.onScroll, { passive: true });
		}
		disconnectedCallback() {
			this.player?.stop();
			removeEventListener("scroll", this.onScroll);
		}
		attributeChangedCallback(name) {
			const p = this.player;
			if (!p) return;
			if (name === "flow") {
				const f = this.getAttribute("flow");
				p.setFlow(FLOWS[f] ? f : "triage");
			} else if (name === "level") p.setLevel(this.#levelAttr());
			else if (name === "zoom-controls") p.renderControls();
			else if (name === "docs-base") p.renderCaption();
		}
		#levelAttr() {
			const l = +this.getAttribute("level");
			return [1, 2, 3].includes(l) ? l : 1;
		}

		get flow() {
			return this.player?.st.flow ?? this.getAttribute("flow") ?? "triage";
		}
		set flow(v) {
			this.setAttribute("flow", v);
		}
		get level() {
			return this.player?.st.level ?? this.#levelAttr();
		}
		set level(v) {
			this.setAttribute("level", String(v));
		}
		get step() {
			return this.player?.st.i ?? -1;
		}
		get steps() {
			return this.player?.total ?? 0;
		}
		get playing() {
			return !!this.player?.st.playing;
		}
		get flows() {
			return Object.entries(FLOWS).map(([id, f]) => ({ id, name: f.name }));
		}
		play() {
			this.player?.play();
		}
		pause() {
			this.player?.stop();
		}
		next() {
			this.player?.stop();
			this.player?.next();
		}
		back() {
			this.player?.stop();
			this.player?.back();
		}
		reset() {
			this.player?.stop();
			this.player?.setI(-1);
		}
		goTo(step) {
			this.player?.stop();
			this.player?.setI(step);
		}
	}
	customElements.define("leitwerk-flow", LeitwerkFlow);
})();
