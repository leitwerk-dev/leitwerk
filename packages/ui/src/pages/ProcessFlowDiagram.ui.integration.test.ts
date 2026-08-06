// @vitest-environment jsdom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessFlowView } from "../lib/api.js";
import ProcessFlowDiagram from "./ProcessFlowDiagram.svelte";

const flowView: ProcessFlowView = {
	processId: "local_repo_change_process",
	entryTurnIds: ["generate_plan"],
	spine: ["generate_plan", "implement", "commit_and_merge"],
	nodes: [
		{
			turnId: "generate_plan",
			description: "Draft plan",
			turnType: "llm",
			role: "spine",
			spineIndex: 0,
			anchorTurnId: null,
			isEntry: true,
		},
		{
			turnId: "implement",
			description: "Implement change",
			turnType: "llm",
			role: "spine",
			spineIndex: 1,
			anchorTurnId: null,
			isEntry: false,
		},
		{
			turnId: "commit_and_merge",
			description: "Commit and merge",
			turnType: "automatic",
			role: "spine",
			spineIndex: 2,
			anchorTurnId: null,
			isEntry: false,
		},
		{
			turnId: "review_plan",
			description: "Review plan",
			turnType: "llm",
			role: "branch",
			spineIndex: null,
			anchorTurnId: "generate_plan",
			isEntry: false,
		},
		{
			turnId: "resolve_merge_conflict",
			description: "Resolve merge conflict",
			turnType: "llm",
			role: "branch",
			spineIndex: null,
			anchorTurnId: "commit_and_merge",
			isEntry: false,
		},
	],
	edges: [
		{
			from: "generate_plan",
			to: "implement",
			lifecycleStatus: null,
			kind: "forward",
			label: "plan_approved",
		},
		{
			from: "commit_and_merge",
			to: null,
			lifecycleStatus: "completed",
			kind: "terminal",
			label: "finalized",
		},
	],
	endStates: [
		{ lifecycleStatus: "aborted", synthetic: true },
		{ lifecycleStatus: "completed", synthetic: false },
	],
};

function mountSubject(props: Record<string, unknown>) {
	const target = document.createElement("div");
	document.body.appendChild(target);
	const app = mount(ProcessFlowDiagram, { target, props });
	return { app, target };
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("ProcessFlowDiagram", () => {
	it("renders only the spine and the completed end state in happy mode", () => {
		const { app, target } = mountSubject({ flow: flowView, mode: "happy" });

		const diagram = target.querySelector('[data-section="process-flow-diagram"]');
		expect(diagram?.getAttribute("data-flow-mode")).toBe("happy");

		const renderedTurns = [...target.querySelectorAll("[data-flow-turn-id]")].map((node) =>
			node.getAttribute("data-flow-turn-id"),
		);
		expect(renderedTurns).toEqual(["generate_plan", "implement", "commit_and_merge"]);

		// Branch turns are not shown on the happy path.
		expect(renderedTurns).not.toContain("review_plan");

		// The completed terminal closes the happy path; abort is not shown here.
		expect(target.querySelector('[data-flow-end-state="completed"]')).toBeTruthy();
		expect(target.querySelector('[data-flow-end-state="aborted"]')).toBeNull();

		unmount(app);
	});

	it("renders a connected SVG graph with nodes and edges in full mode", () => {
		const { app, target } = mountSubject({ flow: flowView, mode: "full" });

		const diagram = target.querySelector('[data-section="process-flow-diagram"]');
		expect(diagram?.getAttribute("data-flow-mode")).toBe("full");

		// The chart is a real SVG, not a list of chips.
		expect(target.querySelector("svg.flow-svg")).toBeTruthy();

		// Every turn node is drawn as an SVG group keyed by its turn id.
		const turnIds = [...target.querySelectorAll("g[data-flow-turn-id]")].map((node) =>
			node.getAttribute("data-flow-turn-id"),
		);
		expect(turnIds).toContain("generate_plan");
		expect(turnIds).toContain("implement");
		expect(turnIds).toContain("commit_and_merge");
		expect(turnIds).toContain("review_plan");
		expect(turnIds).toContain("resolve_merge_conflict");

		// The completed terminal is drawn as its own end-state node.
		expect(target.querySelector('g[data-flow-end-state="completed"]')).toBeTruthy();

		// Edges are drawn as paths that actually connect the work nodes.
		const edge = target.querySelector(
			'path.flow-edge[data-flow-edge-from="generate_plan"][data-flow-edge-to="implement"]',
		);
		expect(edge).toBeTruthy();
		expect(edge?.getAttribute("d")?.length ?? 0).toBeGreaterThan(0);
		expect(edge?.getAttribute("marker-end")).toMatch(/url\(#.+arrow-forward\)/);

		unmount(app);
	});

	it("uses unique SVG marker ids for separate full diagram instances", () => {
		const first = mountSubject({ flow: flowView, mode: "full" });
		const second = mountSubject({ flow: flowView, mode: "full" });

		const markerIds = [...document.querySelectorAll("marker.flow-marker")]
			.map((marker) => marker.id)
			.filter(Boolean);
		expect(markerIds).toHaveLength(8);
		expect(new Set(markerIds).size).toBe(markerIds.length);

		for (const edge of document.querySelectorAll("path.flow-edge")) {
			const markerEnd = edge.getAttribute("marker-end") ?? "";
			const referencedId = markerEnd.match(/#([^)]*)/)?.[1];
			expect(referencedId).toBeTruthy();
			expect(markerIds).toContain(referencedId);
		}

		unmount(first.app);
		unmount(second.app);
	});

	it("collapses to the happy strip with a disclosure toggle when expandable", () => {
		const { app, target } = mountSubject({ flow: flowView, mode: "happy", expandable: true });

		const disclosure = target.querySelector('[data-section="process-flow-disclosure"]');
		expect(disclosure).toBeTruthy();

		const toggle = target.querySelector<HTMLButtonElement>("button.flow-toggle");
		expect(toggle).toBeTruthy();
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(toggle?.textContent?.trim()).toContain("Show full flow");

		// Collapsed: happy strip is shown, full SVG chart is not.
		expect(target.querySelector('[data-flow-mode="happy"]')).toBeTruthy();
		expect(target.querySelector("svg.flow-svg")).toBeNull();

		// The same caret toggle persists across states and stays out of the strip.
		expect(target.querySelector('[data-flow-mode="happy"]')?.contains(toggle ?? null)).toBe(false);

		// Expanding reveals the full directed chart in place.
		toggle?.click();
		flushSync();
		expect(target.querySelector('[data-flow-mode="happy"]')).toBeNull();
		expect(target.querySelector("svg.flow-svg")).toBeTruthy();

		// Same button, now reflecting the expanded state.
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(toggle?.textContent?.trim()).toContain("Hide flow");

		// Collapsing returns to the strip.
		toggle?.click();
		flushSync();
		expect(target.querySelector("svg.flow-svg")).toBeNull();
		expect(target.querySelector('[data-flow-mode="happy"]')).toBeTruthy();

		unmount(app);
	});

	it("renders nothing when no flow view is provided", () => {
		const { app, target } = mountSubject({ mode: "full" });

		expect(target.querySelector('[data-section="process-flow-diagram"]')).toBeNull();

		unmount(app);
	});

	it("reads the flow view from a launcher summary", () => {
		const { app, target } = mountSubject({
			launcher: {
				id: "launcher",
				processId: "local_repo_change_process",
				displayName: "Local Repo Change",
				label: "Local Repo Change",
				description: "desc",
				card: { title: "Local Repo Change", description: "desc" },
				launchConfigSchema: { id: "form", title: "form", fields: [], submitLabel: "Go" },
				processFlow: flowView,
			},
			mode: "happy",
		});

		const renderedTurns = [...target.querySelectorAll("[data-flow-turn-id]")].map((node) =>
			node.getAttribute("data-flow-turn-id"),
		);
		expect(renderedTurns).toEqual(["generate_plan", "implement", "commit_and_merge"]);

		unmount(app);
	});

	it("gives the full chart a key and an accessible summary", () => {
		const { app, target } = mountSubject({ flow: flowView, mode: "full" });

		// A legend explains the visual language instead of leaving it implicit.
		const legend = target.querySelector(".flow-legend");
		expect(legend).toBeTruthy();
		expect(legend?.textContent).toContain("Happy path");
		expect(legend?.textContent).toContain("Completed");

		// The SVG is described for assistive tech rather than collapsing to one label.
		const svg = target.querySelector("svg.flow-svg");
		const describedBy = svg?.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		const summary = target.querySelector(`#${describedBy}`);
		expect(summary?.textContent).toContain("Happy path");
		expect(summary?.textContent).toContain("Draft plan");

		// Each node carries its own accessible name within a list.
		const nodeList = target.querySelector('g.flow-nodes[role="list"]');
		expect(nodeList).toBeTruthy();
		const planNode = target.querySelector('g[data-flow-turn-id="generate_plan"]');
		expect(planNode?.getAttribute("role")).toBe("listitem");
		expect(planNode?.getAttribute("aria-label")).toContain("Draft plan");

		unmount(app);
	});
});
