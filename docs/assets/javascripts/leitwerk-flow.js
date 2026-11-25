/* Homepage process walkthroughs. The diagram shows the current transition. */
(() => {
	if (customElements.get("leitwerk-flow")) return;

	/* ---------- Leitwerk terms, each linked to its docs page ---------- */
	const C = {
		server: {
			label: "Server",
			path: "maintainers/architecture.md",
			def: "Keeps all durable state and every credential. Runs watchers and integration tools.",
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
		github: { l: "GitHub", s: "issues and pull requests", g: "ext" },
		jira: { l: "Jira", s: "bug tracker", g: "ext" },
		logs: { l: "Production logs", s: "log store", g: "ext" },
		lw: { l: "Leitwerk", s: "runs the process", g: "server", c: "server" },
	};
	const col = (a) => `var(--c-${ACT[a].g})`;
	const GROUPS = { person: "People", ext: "Outside tools", server: "Leitwerk server" };
	const S = (f, t, l, x, detail) => ({ f, t, l, x, ...detail });

	const FLOWS = {
		triage: {
			name: "Triage a Jira bug",
			startText:
				"It starts when someone adds the label leitwerk-triage to a bug, or a Jira automation adds it to every new bug. From there it runs without anyone in Leitwerk: it assigns a team, completes the report and writes the fix options into the bug.",
			state: {
				title: "Bug PAY-4821",
				sub: "Refund retry charges card twice",
				rows: ["Status", "Labels", "Team", "Report", "Severity", "Fix"],
				init: { Status: "New", Labels: "payments" },
			},
			steps: [
				S(
					"reporter",
					"jira",
					"files bug with screenshot",
					"A support agent files PAY-4821 “Refund retry charges card twice”, attaches a screenshot of the customer's card statement, and adds the label leitwerk-triage.",
					{
						chapter: "Pick up and route",
						patch: { Labels: "payments, leitwerk-triage" },
						attachment: "statement-screenshot.png",
					},
				),
				S(
					"lw",
					"jira",
					"looks for the label",
					"Leitwerk checks Jira regularly for bugs with the label. It finds PAY-4821 and starts triage.",
					{ terms: ["watcher", "launch"], patch: { Status: "In triage" } },
				),
				S(
					"lw",
					"jira",
					"reads bug and screenshot",
					"Leitwerk reads the description, the steps to reproduce and the attached screenshot. The screenshot shows two charges of €48.90 for one refund.",
					{ terms: ["integrationTool"] },
				),
				S(
					"lw",
					"lw",
					"picks the owning team",
					"The AI checks the code owners file and the team's notes: Payments Core owns refunds.",
					{ terms: ["llmTurn", "wiki"], patch: { Team: "Payments Core (proposed)" } },
				),
				S("lw", "jira", "sets team: Payments Core", "Leitwerk writes the team onto the bug.", {
					terms: ["externalWrite"],
					patch: { Team: "Payments Core" },
				}),
				S(
					"lw",
					"lw",
					"checks the report",
					"Steps to reproduce: yes. Screenshot: yes. App version: missing. Request id: missing. Without those, nobody can find the logs.",
					{
						chapter: "Complete the report",
						terms: ["llmTurn"],
						patch: { Report: "no version, no request id" },
					},
				),
				S(
					"lw",
					"jira",
					"asks for the missing data",
					"Leitwerk comments on the bug and asks the reporter for the app version and a network recording (HAR file). Then it waits.",
					{ terms: ["externalWrite"], patch: { Status: "Waiting for reporter" } },
				),
				S(
					"reporter",
					"jira",
					"replies, attaches app.har",
					"The reporter answers with app version 4.18.2 and attaches app.har, a browser network recording that contains the request id.",
					{ patch: { Report: "complete" }, attachment: "app.har" },
				),
				S("jira", "lw", "reply arrives", "Leitwerk notices the reply and continues the triage.", {
					terms: ["externalAction"],
					patch: { Status: "In triage" },
				}),
				S(
					"lw",
					"logs",
					"looks up the request",
					"Leitwerk takes the request id from app.har and finds two charges for one refund in the logs. The bug is confirmed as severity S2.",
					{
						chapter: "Confirm and publish",
						terms: ["integrationTool"],
						patch: { Severity: "S2, confirmed in logs" },
					},
				),
				S(
					"lw",
					"lw",
					"finds the cause, 2 fixes",
					"The AI finds that a retry re-sends the charge without the original idempotency key. It sees two possible fixes: reuse the stored key, or add a row lock.",
					{ terms: ["llmTurn"], patch: { Fix: "2 options found" } },
				),
				S(
					"lw",
					"jira",
					"posts triage + both fixes",
					"Leitwerk comments with the summary and both fix options with their trade-offs, attaches the matching log excerpt, and moves the bug to Triaged. The owning team picks the fix.",
					{
						terms: ["externalWrite"],
						patch: { Fix: "both options in the bug", Status: "Triaged" },
						attachment: "log-excerpt.txt",
					},
				),
			],
		},
		implement: {
			name: "Implement a GitHub issue",
			startText:
				"It starts when a developer adds the label use-leitwerk to an issue in a watched repository. Leitwerk does the rest and opens a pull request.",
			state: {
				title: "Issue #312",
				sub: "team/service · Add CSV export for invoices",
				rows: ["Labels", "Status", "Plan", "Branch", "Pull request", "CI"],
				init: { Labels: "enhancement", Status: "open" },
			},
			steps: [
				S(
					"dev",
					"github",
					"adds label “use-leitwerk”",
					"A developer adds the label use-leitwerk to issue #312 “Add CSV export for invoices”. That is the only thing needed to start.",
					{ chapter: "Pick up and plan", patch: { Labels: "enhancement, use-leitwerk" } },
				),
				S(
					"lw",
					"github",
					"looks for the label",
					"Leitwerk checks the repository every 30 seconds for issues with the label. It finds #312 and starts working on it.",
					{ terms: ["watcher", "launch"], patch: { Status: "Leitwerk working" } },
				),
				S(
					"lw",
					"lw",
					"plans the change",
					"Leitwerk's AI reads the code and writes a four-step plan.",
					{
						terms: ["llmTurn", "product"],
						patch: { Plan: "drafted, 4 steps", Branch: "leitwerk/issue-312" },
					},
				),
				S(
					"lw",
					"dev",
					"“please approve the plan”",
					"Leitwerk shows the plan to the developer and waits. Nothing runs while it waits.",
					{ terms: ["humanTurn", "chronicle"], patch: { Plan: "waiting for approval" } },
				),
				S(
					"dev",
					"lw",
					"approves",
					"The developer approves. They could also comment, and the AI would revise the plan.",
					{ terms: ["input"], patch: { Plan: "approved" } },
				),
				S(
					"lw",
					"lw",
					"writes the code",
					"The AI writes the code and tests, runs the tests, tidies its own work and writes a commit message.",
					{
						chapter: "Build and open PR",
						terms: ["llmTurn"],
						patch: { Branch: "leitwerk/issue-312, 1 commit" },
					},
				),
				S(
					"lw",
					"github",
					"opens pull request #318",
					"Leitwerk pushes the branch and opens a pull request. If this step is ever retried, it finds #318 instead of opening a second PR.",
					{ terms: ["externalWrite"], patch: { "Pull request": "#318 open", CI: "running" } },
				),
				S(
					"github",
					"lw",
					"a test fails",
					"Leitwerk keeps watching the pull request. One CI check fails on Node 22.",
					{
						chapter: "Repair CI and merge",
						terms: ["externalAction"],
						patch: { CI: "failed on Node 22" },
					},
				),
				S(
					"lw",
					"lw",
					"fixes the test",
					"The AI reads the CI log, finds a test that depends on the locale's sort order, fixes it and pushes.",
					{ terms: ["llmTurn"], patch: { CI: "fix ready" } },
				),
				S(
					"lw",
					"github",
					"pushes an update to #318",
					"Leitwerk pushes the fix to the same branch, so PR #318 updates and CI runs again. It also comments on the PR what it changed and why.",
					{
						terms: ["workspace", "externalWrite"],
						patch: { CI: "running again", Branch: "leitwerk/issue-312, 2 commits" },
					},
				),
				S(
					"reviewer",
					"github",
					"reviews and merges",
					"CI passes. A reviewer approves and merges PR #318.",
					{ patch: { "Pull request": "#318 merged", CI: "passed" } },
				),
				S(
					"github",
					"lw",
					"PR merged",
					"Leitwerk sees the merge, labels the issue leitwerk-done and finishes.",
					{
						terms: ["externalAction"],
						patch: { Labels: "enhancement, leitwerk-done", Status: "closed, done" },
					},
				),
			],
		},
		monitor: {
			name: "Watch production",
			startText:
				"Nobody starts this flow, and nobody needs to approve anything. Leitwerk checks the checkout service's error rate every five minutes and starts when it jumps. It ends by filing a GitHub issue that starts “Implement a GitHub issue”.",
			state: {
				title: "Incident · checkout",
				sub: "started 09:02",
				rows: ["Error rate", "Status", "Errors", "Problems", "Known issue", "New issue"],
				init: { "Error rate": "normal", Status: "watching" },
			},
			steps: [
				S(
					"lw",
					"logs",
					"checks the error rate",
					"Every five minutes, Leitwerk asks the log store how many errors the checkout service produced.",
					{ chapter: "Detect", terms: ["watcher"] },
				),
				S(
					"logs",
					"lw",
					"4× more errors than usual",
					"At 09:02 the error rate jumps to 4.1 times its normal level. Leitwerk starts an investigation.",
					{ terms: ["launch"], patch: { "Error rate": "4.1× normal", Status: "investigating" } },
				),
				S(
					"lw",
					"logs",
					"collects the top errors",
					"Leitwerk pulls the most frequent error groups from the last 30 minutes.",
					{
						chapter: "Investigate",
						terms: ["integrationTool"],
						patch: { Errors: "3 groups, 1,904 events" },
					},
				),
				S(
					"lw",
					"lw",
					"finds 2 real problems",
					"The AI sorts the errors into two real problems and dismisses client disconnects as noise.",
					{ terms: ["llmTurn"], patch: { Problems: "2 real, 1 noise" } },
				),
				S(
					"lw",
					"github",
					"checks if they are known",
					"For each problem, Leitwerk checks the team's incident notes and the open GitHub issues. The first is already known as #298. The second is new.",
					{ terms: ["wiki", "integrationTool"], patch: { Problems: "1 known, 1 new" } },
				),
				S(
					"lw",
					"github",
					"comments on #298",
					"Leitwerk adds the new occurrence to the known issue: 1,240 errors since 09:02.",
					{
						chapter: "File and hand off",
						terms: ["externalWrite"],
						patch: { "Known issue": "#298, occurrence added" },
					},
				),
				S(
					"lw",
					"github",
					"creates #341, label use-leitwerk",
					"Leitwerk files the timeout problem as a new GitHub issue with the evidence, and adds the label use-leitwerk.",
					{ terms: ["externalWrite"], patch: { "New issue": "#341, use-leitwerk" } },
				),
				S(
					"lw",
					"github",
					"label starts a fix",
					"use-leitwerk is the same label a developer would add. Leitwerk's GitHub watcher picks up #341 and starts “Implement a GitHub issue” as a new, separate process. This run is done.",
					{ terms: ["watcher", "launch"], patch: { Status: "handed off to #341" } },
				),
			],
		},
	};

	const BOXES = {
		dev: { x: 420, y: 50, w: 160, h: 46 },
		reviewer: { x: 700, y: 50, w: 160, h: 46 },
		reporter: { x: 560, y: 50, w: 160, h: 46 },
		github: { x: 122, y: 240, w: 170, h: 52 },
		jira: { x: 122, y: 240, w: 170, h: 52 },
		logs: { x: 122, y: 420, w: 170, h: 52 },
		lw: { x: 560, y: 320, w: 250, h: 100 },
	};
	const actors = (steps) => new Set(steps.flatMap(({ f, t }) => [f, t]));

	/* ---------- Geometry ---------- */
	function clip(n, toward) {
		const dx = toward.x - n.x,
			dy = toward.y - n.y;
		const s = Math.min((n.w / 2 + 5) / Math.abs(dx || 1e-6), (n.h / 2 + 5) / Math.abs(dy || 1e-6));
		return { x: n.x + dx * s, y: n.y + dy * s };
	}
	function arrowGeom({ f, t }) {
		const a = BOXES[f],
			b = BOXES[t];
		if (f === t) {
			const top = a.y - a.h / 2;
			const s = { x: a.x - 30, y: top - 5 };
			return {
				d: `M${s.x} ${s.y} C${a.x - 48} ${top - 60}, ${a.x + 48} ${top - 60}, ${a.x + 30} ${s.y}`,
				s,
			};
		}
		const s = clip(a, b),
			e = clip(b, a);
		return { d: `M${s.x} ${s.y} L${e.x} ${e.y}`, s };
	}

	/* ---------- Helpers ---------- */
	const esc = (s) =>
		String(s).replace(
			/[&<>"]/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
		);
	const who = (a) =>
		`<span class="who"><span class="dot" style="color:${col(a)}"></span>${esc(ACT[a].l)}</span>`;
	const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
	const marker = (id) => `url(#ah-${id})`;
	const STYLE = `
:host {
  display: block; text-align: left; letter-spacing: normal;
  --surface: var(--md-default-bg-color); --surface-2: var(--leitwerk-surface-subtle);
  --fg: var(--md-default-fg-color); --fg-2: var(--md-default-fg-color--light); --fg-3: var(--fg-2);
  --line: var(--leitwerk-border); --accent: var(--md-typeset-a-color);
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
  --c-person: light-dark(#b03a6a, #ee84ad); --c-ext: light-dark(#7a5c3e, #cfa47c); --c-server: var(--accent);
  color: var(--fg); font-size: 14px; line-height: 1.5;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
a { color: var(--accent); }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.panel:focus-visible { outline-offset: -2px; }
p { margin: 0; }

.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }

/* Native step slider with chapter shortcuts. */
.deck { display: flex; gap: 12px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.tbtn.play { flex: none; width: 40px; height: 32px; display: inline-grid; place-items: center; border: 0; border-radius: 8px; background: var(--fg); color: var(--surface); cursor: pointer; }
.tbtn.play svg { width: 14px; height: 14px; }
.timeline { flex: 1; min-width: 0; }
#tl { width: 100%; margin: 4px 0 0; accent-color: var(--accent); cursor: pointer; }
.chapters { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.chapters button { border: 0; padding: 2px 0; background: none; font-size: 12px; color: var(--fg-2); cursor: pointer; }
.chapters button[aria-current="step"], .chapters button:hover { color: var(--accent); text-decoration: underline; }

.intro { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 20px; padding: 10px 16px 0; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--fg-2); margin-left: auto; }
.legend span { display: inline-flex; gap: 6px; align-items: center; }
/* the diagram always scales to the panel width, so the element never needs a scrollbar */
.svg-wrap { padding: 4px 8px; }
.svg-wrap svg { display: block; width: 100%; height: auto; }
.node { transition: opacity .4s; }
a.node { cursor: pointer; }
.node rect { fill: var(--surface); stroke-width: 1.6; }
.node .nl { font-size: 13.5px; font-weight: 700; fill: var(--fg); }
.node .ns { font-size: 10.5px; fill: var(--fg-3); }
.node.hot rect { stroke-width: 3.5; }
.node.quiet { opacity: .32; }
.gone { visibility: hidden; }
.edge { fill: none; stroke-width: 3; stroke-linecap: round; }
.next { cursor: pointer; }
.next .ring { fill: none; stroke-width: 2.5; animation: ring 1.4s ease-out infinite; transform-box: fill-box; transform-origin: center; }
.next .core { stroke: var(--surface); stroke-width: 2.5; }
@keyframes ring { 0% { transform: scale(.6); opacity: 1; } 100% { transform: scale(1.8); opacity: 0; } }
.state { border-top: 1px solid var(--line); padding: 12px 16px; background: var(--surface-2); }
.state small { color: var(--fg-2); }
.state dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 145px), 1fr)); gap: 6px; margin: 8px 0 0; }
.state dl > div { padding: 4px 8px; border-radius: 5px; overflow-wrap: anywhere; }
.state dt { font-size: 12px; color: var(--fg-2); }
.state dd { margin: 0; }
.files { display: flex; flex-wrap: wrap; gap: 4px 8px; padding: 0; margin: 8px 0 0; list-style: none; }
.files li { padding: 2px 6px; border-radius: 5px; overflow-wrap: anywhere; }
.state .chg { background: var(--accent-soft); font-weight: 600; }
.caption { border-top: 1px solid var(--line); padding: 12px 16px 14px; display: flex; flex-direction: column; gap: 6px; }
.cap-top { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--fg-3); }
.cap-top .who { display: inline-flex; gap: 6px; align-items: center; font-weight: 600; color: var(--fg-2); }
.cap-title { font-size: 17px; font-weight: 700; margin: 0; text-wrap: balance; }
.cap-text { margin: 0; color: var(--fg-2); max-width: 78ch; }
.terms { margin: 0; padding-left: 1.3em; font-size: 12px; color: var(--fg-2); }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: currentColor; display: inline-block; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
	const MARKUP = `
<section class="panel" tabindex="0" aria-label="Process walk-through. Use the arrow keys to step, space to play.">
  <div class="deck">
    <button class="tbtn play" id="t-play" aria-label="Play" title="Play / pause (space)"><svg viewBox="0 0 16 16"><path id="play-ico" d="M4 2l10 6-10 6z" fill="currentColor"/></svg></button>
    <div class="timeline">
      <div class="chapters" id="chapters" role="group" aria-label="Chapters"></div>
      <input id="tl" type="range" min="0" aria-label="Walkthrough step">
    </div>
  </div>
  <div class="intro"><div class="legend" id="legend"></div></div>
  <div class="svg-wrap" id="svg-wrap"></div>
  <div class="caption" aria-live="polite" id="caption"></div>
  <section class="state" id="state" aria-label="Tracked state"></section>
</section>`;

	/* One player per element. It owns the walk-through state and renders into the element's shadow root. */
	function createPlayer(root) {
		const $ = (s) => root.querySelector(s);
		const $$ = (s) => root.querySelectorAll(s);
		const st = {
			flow: "triage",
			i: -1,
			prev: -2,
			playing: false,
			timer: null,
		};
		const F = () => FLOWS[st.flow];
		const items = () => F().steps;
		const href = (path) => path.replace(/\.md(?=#|$)/, "/");
		const term = (k) => {
			const c = C[k];
			return `<li><a href="${href(c.path)}">${esc(c.label)}</a> — ${esc(c.def)}</li>`;
		};
		let chapters;
		const chapterOf = (i) => chapters.findLastIndex(([, from]) => from <= i);
		const tl = $("#tl");
		const chapterButtons = $("#chapters");
		function renderTimeline() {
			const c = chapterOf(st.i);
			tl.value = st.i + 1;
			tl.setAttribute(
				"aria-valuetext",
				c < 0 ? "Beginning" : `Step ${st.i + 1} of ${items().length}, ${chapters[c][0]}`,
			);
			Array.from(chapterButtons.children).forEach((button, i) => {
				button.setAttribute("aria-current", i === c ? "step" : "false");
			});
			$("#play-ico").setAttribute("d", st.playing ? "M3 2h4v12H3zM9 2h4v12H9z" : "M4 2l10 6-10 6z");
			$("#t-play").setAttribute("aria-label", st.playing ? "Pause" : "Play");
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
				sp = chapters[chapterOf(st.i)];
			const route = s.f === s.t ? who(s.f) : `${who(s.f)}<span>→</span>${who(s.t)}`;
			$("#caption").innerHTML =
				`<div class="cap-top"><span>${esc(sp[0])} · step ${st.i + 1} of ${list.length}</span>${route}</div>
      <p class="cap-title">${esc(ACT[s.f].l)} ${esc(s.l)}</p><p class="cap-text">${esc(s.x)}</p>
      ${s.terms ? `<ul class="terms" aria-label="Leitwerk terms">${s.terms.map(term).join("")}</ul>` : ""}`;
		}
		function renderLegend(used) {
			const g = new Set(used.map((a) => ACT[a].g));
			$("#legend").innerHTML = Object.entries(GROUPS)
				.filter(([x]) => g.has(x))
				.map(
					([x, name]) =>
						`<span><span class="dot" style="color:var(--c-${x})"></span>${name}</span>`,
				)
				.join("");
		}

		/* ---------- Diagram skeleton ---------- */
		function renderDiagram() {
			const used = [...actors(items())];
			$("#svg-wrap").innerHTML =
				`<svg viewBox="0 0 850 465" role="group" aria-label="${esc(F().name)}: components and messages">
      <defs>${Object.keys(GROUPS)
				.map(
					(g) =>
						`<marker id="ah-${g}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--c-${g})"/></marker>`,
				)
				.join("")}</defs>
      <g id="edge"></g>
      <g id="nodes">${used
				.map((a) => {
					const n = BOXES[a],
						A = ACT[a],
						tag = A.c ? "a" : "g";
					return `<${tag} class="node" data-n="${a}" ${A.c ? `href="${href(C[A.c].path)}"` : ""} aria-label="${esc(A.l)}"><rect x="${n.x - n.w / 2}" y="${n.y - n.h / 2}" width="${n.w}" height="${n.h}" rx="${A.g === "person" ? n.h / 2 : a === "lw" ? 18 : 10}" stroke="${col(a)}"/>
          <text class="nl" x="${n.x}" y="${n.y - 2}" text-anchor="middle">${esc(A.l)}</text><text class="ns" x="${n.x}" y="${n.y + 14}" text-anchor="middle">${esc(A.s)}</text></${tag}>`;
				})
				.join("")}</g>
      <g id="next"></g>
    </svg>`;
			renderLegend(used);
			st.prev = -2;
		}

		function renderState() {
			const { title, sub, rows, init } = F().state;
			const { i } = st;
			const shown = items().slice(0, i + 1);
			const val = Object.assign({}, init, ...shown.map((step) => step.patch));
			const patch = items()[i]?.patch ?? {};
			const fields = rows.map(
				(r) =>
					`<div class="${Object.hasOwn(patch, r) ? "chg" : ""}"><dt>${esc(r)}</dt><dd>${esc(val[r] ?? "—")}</dd></div>`,
			);
			const attachments = shown.map(({ attachment }, j) =>
				attachment ? `<li class="${j === i ? "chg" : ""}">${esc(attachment)}</li>` : "",
			);
			$("#state").innerHTML = `<p><strong>${esc(title)}</strong> <small>${esc(sub)}</small></p>
      <dl>${fields.join("")}</dl>${items().some((step) => step.attachment) ? `<ul class="files" aria-label="Attachments"><li><small>Attachments:</small></li>${attachments.join("") || "<li>None yet</li>"}</ul>` : ""}`;
		}

		/* Pulsing dot at the start of the next arrow */
		function renderNext() {
			const nextStep = st.i + 1;
			const s = items()[nextStep];
			if (!s) {
				$("#next").innerHTML = "";
				return;
			}
			const p = arrowGeom(s).s,
				c = col(s.f);
			$("#next").innerHTML =
				`<g class="next" tabindex="0" role="button" aria-label="Reveal next step"><circle class="ring" cx="${p.x}" cy="${p.y}" r="10" stroke="${c}"/><circle class="core" cx="${p.x}" cy="${p.y}" r="8" fill="${c}"/><title>Next: ${esc(ACT[s.f].l)} ${esc(s.l)}</title></g>`;
			const n = $("#next .next");
			n.addEventListener("click", () => seek(nextStep));
			n.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					e.stopPropagation();
					seek(nextStep);
				}
			});
		}

		/* Draw the current arrow when stepping forward. */
		function animateNew() {
			if (reduced() || st.i !== st.prev + 1) return;
			const path = $(".edge");
			const length = path.getTotalLength();
			path.animate(
				[
					{ strokeDasharray: length, strokeDashoffset: length },
					{ strokeDasharray: length, strokeDashoffset: 0 },
				],
				{ duration: 480, easing: "ease-out" },
			);
		}

		function renderTransition() {
			const list = items(),
				cur = list[st.i],
				next = list[st.i + 1];
			const shown = actors(list.slice(0, st.i + 1));
			if (next) shown.add(next.f);
			$$("#nodes .node").forEach((g) => {
				const n = g.dataset.n;
				const hot = n === cur?.f || n === cur?.t;
				g.classList.toggle("gone", !shown.has(n));
				g.classList.toggle("hot", hot);
				g.classList.toggle("quiet", !hot && n !== next?.f);
			});
			$("#edge").innerHTML = cur
				? `<path class="edge" d="${arrowGeom(cur).d}" stroke="${col(cur.f)}" marker-end="${marker(ACT[cur.f].g)}"/>`
				: "";
			if (cur) animateNew();
			renderNext();
		}

		/* ---------- Orchestration ---------- */
		function update() {
			renderTimeline();
			renderState();
			renderTransition();
			renderCaption();
			st.prev = st.i;
		}
		function render() {
			chapters = items().flatMap(({ chapter }, i) => (chapter ? [[chapter, i]] : []));
			tl.max = items().length;
			chapterButtons.innerHTML = chapters
				.map(([name, first]) => `<button type="button" data-first="${first}">${esc(name)}</button>`)
				.join("");
			renderDiagram();
			update();
		}
		function setI(i) {
			const list = items();
			st.i = Math.max(-1, Math.min(list.length - 1, i));
			update();
		}
		function seek(i) {
			stop();
			setI(i);
		}
		function play() {
			if (st.i >= items().length - 1) setI(-1);
			st.playing = true;
			renderTimeline();
			tick();
		}
		function stop() {
			if (!st.playing) return;
			st.playing = false;
			clearTimeout(st.timer);
			renderTimeline();
		}
		function tick() {
			clearTimeout(st.timer);
			if (!st.playing) return;
			st.timer = setTimeout(() => {
				if (st.i >= items().length - 1) {
					stop();
					return;
				}
				setI(st.i + 1);
				tick();
			}, 2200);
		}
		function start(flow) {
			stop();
			st.flow = flow;
			st.i = -1;
			render();
			play();
		}

		/* ---------- Events ---------- */
		$("#t-play").onclick = () => (st.playing ? stop() : play());
		tl.addEventListener("input", () => seek(tl.valueAsNumber - 1));
		chapterButtons.addEventListener("click", (e) => {
			const button = e.target.closest("button");
			if (button) seek(+button.dataset.first);
		});
		// Keep the page's scrolling and the native range keyboard controls intact.
		root.addEventListener("keydown", (e) => {
			if (e.defaultPrevented || e.target === tl) return;
			switch (e.key) {
				case "ArrowRight":
					seek(st.i + 1);
					break;
				case "ArrowLeft":
					seek(st.i - 1);
					break;
				case "Home":
					seek(-1);
					break;
				case "End":
					seek(items().length - 1);
					break;
				case " ":
					if (e.target.closest("button")) return;
					st.playing ? stop() : play();
					break;
				default:
					return;
			}
			e.preventDefault();
		});

		return { start, stop };
	}

	class LeitwerkFlow extends HTMLElement {
		connectedCallback() {
			if (!this.player) {
				const root = this.attachShadow({ mode: "open", delegatesFocus: true });
				root.innerHTML = `<style>${STYLE}</style>${MARKUP}`;
				this.player = createPlayer(root);
			}
		}
		disconnectedCallback() {
			this.player.stop();
		}
		start(flow) {
			this.player.start(flow);
		}
	}
	customElements.define("leitwerk-flow", LeitwerkFlow);
})();
