import { expect, test } from "vitest";
import type {
	ExternalSourceArmingLike,
	ExternalSourceFireInput,
	ExternalSourceServiceLike,
} from "./core-capabilities.js";
import { createExternalSourcePollReporter } from "./external-source-poll.js";

function fixture(forwardGeneration = false, currentKinds?: readonly string[]) {
	const armed: ExternalSourceArmingLike = {
		id: "subscription",
		instanceId: "process",
		generation: "1",
		resolved: { head: "a" },
		processId: "definition",
		turnId: "turn",
		externalActionId: "action",
		source: { kind: "forge" },
	};
	let live = [structuredClone(armed)];
	const fires: ExternalSourceFireInput[] = [];
	const observations: unknown[] = [];
	const sources: ExternalSourceServiceLike = {
		listArmed: (kind) => (kind === "forge" ? live : []),
		fire: async (input) => {
			fires.push(input);
			return { ok: false };
		},
		observe: async (input) => {
			observations.push(input);
			return { ok: true };
		},
	};
	const result = { created: [] as string[], errors: [] as string[] };
	const report = createExternalSourcePollReporter(sources, result, {
		forwardGeneration,
		currentKinds,
	});
	return {
		armed,
		sources,
		report,
		result,
		fires,
		observations,
		setLive: (value: ExternalSourceArmingLike[]) => {
			live = value;
		},
	};
}

test.each([
	"generation",
	"resolved",
	"id",
	"instanceId",
] as const)("rejects changed %s after provider I/O", async (field) => {
	const f = fixture(true, ["forge"]);
	const visited: string[] = [];
	await f.report.poll("forge", async (armed) => {
		visited.push(armed.id);
		await Promise.resolve();
		f.setLive([{ ...armed, [field]: field === "resolved" ? { head: "b" } : "changed" }]);
		expect(f.report.isCurrent("forge", armed)).toBe(false);
		expect(await f.report.fire(armed, {}, "key")).toBe(false);
		await f.report.observe(armed, { refreshError: "stale" });
	});
	expect(visited).toEqual(["subscription"]);
	expect(f.fires).toEqual([]);
	expect(f.observations).toEqual([]);
	expect(f.result).toEqual({ created: [], errors: [] });
});

test.each([
	false,
	true,
])("preserves generation forwarding policy %s and rejected fire reporting", async (forward) => {
	const f = fixture(forward);
	expect(f.report.isCurrent("forge", f.armed)).toBe(true);
	expect(f.report.isCurrent("other", f.armed)).toBe(false);
	f.setLive([]);
	expect(await f.report.fire(f.armed, { kind: "event" }, "key")).toBe(false);
	expect(f.fires[0]).toEqual({
		instanceId: "process",
		armingId: "subscription",
		event: { kind: "event" },
		mergeKey: "key",
		...(forward ? { generation: "1" } : {}),
	});
	expect(f.result.errors).toEqual(["subscription:fire_failed"]);
});

test("observation support and generation are optional", async () => {
	const f = fixture();
	await f.report.observe({ ...f.armed, generation: undefined }, { refreshError: "error" });
	delete f.sources.observe;
	await f.report.observe(f.armed, { refreshError: "error" });
	expect(f.observations).toEqual([]);
});

test("reports accepted effects only for a live subscription", async () => {
	const f = fixture(true, ["forge"]);
	f.sources.fire = async () => ({ ok: true });
	await f.report.observe(f.armed, { refreshError: "refresh failed" });
	expect(f.observations).toEqual([
		{
			instanceId: "process",
			armingId: "subscription",
			generation: "1",
			refreshError: "refresh failed",
		},
	]);
	expect(await f.report.fire(f.armed, {}, "key")).toBe(true);
	expect(f.result.created).toEqual(["subscription"]);
	f.setLive([]);
	expect(await f.report.fire(f.armed, {}, "key")).toBe(false);
});
