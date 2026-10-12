// @vitest-environment jsdom
import type { ProcessFlowView } from "@leitwerk-dev/domain";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProcessFlowDiagram from "./ProcessFlowDiagram.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];
const flow: ProcessFlowView = {
	processId: "test",
	entryTurnIds: ["assess"],
	spine: ["assess", "publish"],
	nodes: [
		{
			turnId: "assess",
			description: "Assess component",
			turnType: "llm",
			role: "spine",
			spineIndex: 0,
			anchorTurnId: null,
			isEntry: true,
			repetition: "sequential",
			tools: [
				{ name: "read", category: "workspace", description: "Read workspace files." },
				{ name: "submit_finding", category: "outcome", description: "Yield one finding." },
			],
			hasDynamicTools: true,
		},
		{
			turnId: "publish",
			description: "Publish",
			turnType: "automatic",
			role: "spine",
			spineIndex: 1,
			anchorTurnId: null,
			isEntry: false,
		},
		{
			turnId: "review",
			description: "Review recommendation",
			turnType: "human",
			role: "branch",
			spineIndex: null,
			anchorTurnId: "assess",
			isEntry: false,
		},
	],
	edges: [
		{ from: "assess", to: "publish", kind: "forward", lifecycleStatus: null, label: "Ready" },
		{ from: "assess", to: "review", kind: "forward", lifecycleStatus: null, label: "Review" },
		{ from: "review", to: "publish", kind: "forward", lifecycleStatus: null, label: "Approve" },
		{ from: "publish", to: null, kind: "terminal", lifecycleStatus: "completed", label: "Done" },
	],
	endStates: [{ lifecycleStatus: "completed", synthetic: false }],
};
function subject(props: Record<string, unknown> = {}) {
	const target = document.createElement("div");
	document.body.append(target);
	mounted.push(mount(ProcessFlowDiagram, { target, props: { flow, ...props } }));
	flushSync();
	return target;
}
afterEach(async () => {
	for (const app of mounted.splice(0)) await unmount(app);
	document.body.innerHTML = "";
});
function button(target: HTMLElement, part: string) {
	const element = target.querySelector<HTMLButtonElement>(
		`[data-flow-turn-id="assess"][data-part="${part}"]`,
	);
	if (!element) throw new Error(`Missing ${part}`);
	return element;
}
function route(target: HTMLElement, from: string, to: string, section = "outer") {
	const outer = target.querySelector<SVGGElement>(
		`[data-flow-edge-from="${from}"][data-flow-edge-to="${to}"]`,
	);
	const element = target.querySelector<SVGGElement>(
		`[data-route-id="${outer?.dataset.routeId}"][data-route-section="${section}"]`,
	);
	if (!element) throw new Error(`Missing ${from} → ${to} ${section}`);
	return element;
}
function hover(element: Element, entering = true) {
	element.dispatchEvent(new MouseEvent(entering ? "mouseenter" : "mouseleave"));
	flushSync();
}
describe("shared workflow graph integration", () => {
	it("shows distinct branch conditions and explains their shared outcome on hover", () => {
		const conditionalFlow: ProcessFlowView = {
			...flow,
			edges: flow.edges.map((edge) =>
				edge.from === "assess"
					? {
							...edge,
							label: "Assessment ready",
							condition:
								edge.to === "publish"
									? {
											label: "Skip review",
											description: "The process policy permits direct publication.",
										}
									: {
											label: "Review required",
											description: "An operator must review the findings.",
										},
						}
					: edge,
			),
		};
		const target = subject({ mode: "full", flow: conditionalFlow });
		const direct = route(target, "assess", "publish");
		const review = route(target, "assess", "review");
		expect(direct.querySelector("text")?.textContent).toBe("Skip review");
		expect(review.querySelector("text")?.textContent).toBe("Review required");
		hover(direct);
		expect(target.querySelector('[role="tooltip"]')?.textContent).toContain(
			"After Assessment ready",
		);
		expect(target.querySelector('[role="tooltip"]')?.textContent).toContain(
			"The process policy permits direct publication.",
		);
		hover(direct, false);
		button(target, "turn").click();
		flushSync();
		expect(target.querySelector(".outgoing")?.textContent).toContain("Skip review");
		expect(target.querySelector(".outgoing")?.textContent).toContain("Review required");
	});
	it("keeps the launch overview compact and expands the shared renderer", () => {
		const target = subject({ expandable: true });
		expect(target.querySelector('[aria-label="Shortest successful path"]')?.textContent).toContain(
			"For each item",
		);
		const toggle = target.querySelector<HTMLButtonElement>(".flow-toggle");
		toggle?.click();
		flushSync();
		expect(target.querySelector(".workflow-graph")).toBeTruthy();
		expect(target.querySelectorAll(".repeat-group button")).toHaveLength(3);
		toggle?.click();
		flushSync();
		expect(target.querySelector(".workflow-graph")).toBeNull();
	});
	it("inspects a mapped activity without leaving the graph and discloses tool names", async () => {
		const onSelectTurn = vi.fn(),
			target = subject({ mode: "full", onSelectTurn });
		button(target, "turn").click();
		flushSync();
		await tick();
		expect(onSelectTurn).not.toHaveBeenCalled();
		expect(target.querySelectorAll(".tool-disclosure")).toHaveLength(2);
		expect(target.querySelector(".tool-disclosure summary")?.textContent?.trim()).toBe("read");
		expect(target.querySelector("details[open]")).toBeNull();
		expect(target.querySelector(".dynamic-tools")?.textContent).toContain("when this turn starts");
		target.querySelector<HTMLButtonElement>(".inspect-turn")?.click();
		expect(onSelectTurn).toHaveBeenCalledWith("assess");
	});
	it("gives group, item work and collection independent feedback while selected", () => {
		const target = subject({ mode: "full" });
		button(target, "turn").click();
		flushSync();
		for (const part of ["repeat", "turn", "collect"]) {
			button(target, part).dispatchEvent(new MouseEvent("mouseenter"));
			flushSync();
			expect(button(target, part).classList.contains("highlighted")).toBe(true);
			expect(target.querySelectorAll(".repeat-group .highlighted")).toHaveLength(1);
			button(target, part).dispatchEvent(new MouseEvent("mouseleave"));
			flushSync();
		}
		expect(button(target, "turn").classList.contains("chosen")).toBe(true);
		button(target, "collect").click();
		flushSync();
		expect(target.querySelector(".step-inspector h3")?.textContent).toBe("Collect results");
		expect(target.querySelector(".available-tools")).toBeNull();
		expect(target.querySelector(".step-inspector")?.textContent).toContain("empty collection");
	});
	it("retains selection when moving from enclosure to activity and restores exact keyboard focus", async () => {
		const target = subject({ mode: "full" });
		button(target, "repeat").click();
		flushSync();
		await tick();
		button(target, "turn").click();
		flushSync();
		await tick();
		expect(target.querySelector(".step-inspector")).toBeTruthy();
		button(target, "turn").focus();
		target
			.querySelector(".workflow-graph")
			?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		flushSync();
		await tick();
		expect(target.querySelector(".step-inspector")).toBeNull();
		expect(document.activeElement).toBe(button(target, "turn"));
		expect(target.querySelector('[role="tooltip"]')).toBeNull();
	});
	it("dismisses previews on close and does not restore an earlier hover", async () => {
		const target = subject({ mode: "full" });
		const activity = button(target, "turn");
		activity.focus();
		activity.click();
		flushSync();
		await tick();
		const close = target.querySelector<HTMLButtonElement>('[aria-label="Close step details"]');
		if (!close) throw new Error("Missing close button");
		close.focus();
		close.click();
		flushSync();
		await tick();
		await vi.waitFor(() => expect(document.activeElement).toBe(activity));
		expect(target.querySelector('[role="tooltip"]')).toBeNull();
		expect(target.querySelectorAll(".highlighted, .route-active")).toHaveLength(0);
		const collect = button(target, "collect");
		hover(collect);
		expect(target.querySelector('[role="tooltip"] strong')?.textContent).toBe("Collect results");
		hover(collect, false);
		expect(target.querySelector('[role="tooltip"]')).toBeNull();
		expect(target.querySelectorAll(".highlighted, .route-active")).toHaveLength(0);
	});
	it("lets pointer feedback replace keyboard feedback without reviving it on leave", () => {
		const target = subject({ mode: "full" });
		const activity = button(target, "turn");
		activity.focus();
		flushSync();
		expect(target.querySelector('[role="tooltip"] strong')?.textContent).toBe("Assess component");
		const collect = button(target, "collect");
		hover(collect);
		expect(target.querySelector('[role="tooltip"] strong')?.textContent).toBe("Collect results");
		hover(collect, false);
		expect(target.querySelector('[role="tooltip"]')).toBeNull();
	});
	it("uses separate markers for each mounted graph", () => {
		subject({ mode: "full" });
		subject({ mode: "full" });
		const ids = [...document.querySelectorAll("marker")].map((marker) => marker.id);
		expect(ids).toHaveLength(6);
		expect(new Set(ids).size).toBe(ids.length);
	});
	it("keeps unrelated repeat exits neutral when highlighting publication", () => {
		const target = subject({ mode: "full" });
		const publish = target.querySelector('[data-flow-turn-id="publish"]');
		if (!publish) throw new Error("Missing publication turn");
		hover(publish);
		for (const section of ["outer", "exit"]) {
			expect(route(target, "assess", "publish", section).classList.contains("route-active")).toBe(
				true,
			);
			expect(route(target, "assess", "review", section).classList.contains("route-active")).toBe(
				false,
			);
		}
		expect(route(target, "review", "publish").classList.contains("route-active")).toBe(true);
		expect(target.querySelector('[data-route-section="loop"].route-active')).toBeNull();
	});
	it.each([
		"outer",
		"exit",
	])("highlights a complete route from its %s segment without replacing step selection", (section) => {
		const target = subject({ mode: "full" });
		button(target, "repeat").click();
		flushSync();
		const arrow = route(target, "assess", "publish", section);
		hover(arrow);
		expect(target.querySelectorAll(".route-active")).toHaveLength(2);
		for (const segment of ["outer", "exit"])
			expect(route(target, "assess", "publish", segment).classList.contains("route-active")).toBe(
				true,
			);
		expect(button(target, "repeat").classList.contains("chosen")).toBe(true);
		expect(target.querySelector(".step-inspector h3")?.textContent).toBe("For each item");
		expect(target.querySelector('[role="tooltip"]')?.textContent).toContain(
			"Assess component → Publish",
		);
		hover(arrow, false);
		expect(route(target, "assess", "review").classList.contains("route-active")).toBe(true);
	});
	it("keeps next-item repetition neutral and previews internal routes independently", () => {
		const target = subject({ mode: "full" });
		const loop = target.querySelector('[data-route-section="loop"]');
		if (!loop) throw new Error("Missing next-item route");
		expect(loop.querySelector(".route-line")?.getAttribute("stroke")).toBe("var(--graph-route)");
		expect(loop.querySelector(".route-line")?.getAttribute("marker-end")).toContain("arrow-normal");
		for (const section of ["loop", "results"]) {
			const arrow = target.querySelector(`[data-route-section="${section}"]`);
			if (!arrow) throw new Error(`Missing ${section} route`);
			hover(arrow);
			expect(target.querySelectorAll(".route-active")).toHaveLength(1);
			expect(arrow.querySelector(".route-line")?.getAttribute("stroke")).toBe(
				"var(--graph-accent)",
			);
			expect(arrow.querySelector(".route-line")?.getAttribute("marker-end")).toContain(
				"arrow-active",
			);
			hover(arrow, false);
			expect(target.querySelectorAll(".route-active")).toHaveLength(0);
		}
	});
});
