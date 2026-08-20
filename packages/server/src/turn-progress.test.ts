import { describe, expect, it } from "vitest";
import { normalizeTurnProgressReport, recordTurnProgress } from "./turn-progress.js";

describe("turn progress reports", () => {
	it("normalizes an ordered report with external resources", () => {
		expect(
			normalizeTurnProgressReport({
				title: " Delivery progress ",
				steps: [
					{ id: "validate", label: "Validate", status: "completed" },
					{ id: "publish", label: "Publish", status: "in_progress", detail: "Pushing" },
				],
				links: [
					{ id: "pr-1", label: "PR #1", url: "https://example.test/pr/1", kind: "pull_request" },
				],
			}),
		).toEqual({
			title: "Delivery progress",
			steps: [
				{ id: "validate", label: "Validate", status: "completed" },
				{ id: "publish", label: "Publish", status: "in_progress", detail: "Pushing" },
			],
			links: [
				{ id: "pr-1", label: "PR #1", url: "https://example.test/pr/1", kind: "pull_request" },
			],
		});
	});

	it("persists only current running turn updates", () => {
		const events: unknown[] = [];
		const broadcasts: unknown[] = [];
		const process = { id: "agt_1", selectedTurnId: "deliver" };
		const running = { id: "trn_1", instanceId: "agt_1", turnId: "deliver", status: "running" };
		const deps = {
			processes: { getById: () => process },
			turnRecords: { getById: (id: string) => (id === running.id ? running : null) },
			events: {
				create: (event: unknown) => events.push(event),
				listByInstanceTurnRecordEventTypes: () => events,
			},
			broadcaster: { broadcast: (frame: unknown) => broadcasts.push(frame) },
		} as never;
		const report = {
			title: "Progress",
			steps: [{ id: "one", label: "One", status: "in_progress" }],
		};
		expect(recordTurnProgress(deps, { instanceId: "agt_1", turnRecordId: "trn_1", report })).toBe(
			true,
		);
		expect(events).toHaveLength(1);
		expect(broadcasts).toHaveLength(1);
		expect(recordTurnProgress(deps, { instanceId: "agt_1", turnRecordId: "stale", report })).toBe(
			false,
		);
		expect(events).toHaveLength(1);
	});

	it("rejects duplicate steps and unsafe links", () => {
		expect(
			normalizeTurnProgressReport({
				title: "Progress",
				steps: [
					{ id: "same", label: "One", status: "completed" },
					{ id: "same", label: "Two", status: "incomplete" },
				],
			}),
		).toBeNull();
		expect(
			normalizeTurnProgressReport({
				title: "Progress",
				steps: [{ id: "one", label: "One", status: "completed" }],
				links: [{ id: "bad", label: "Bad", url: "javascript:alert(1)" }],
			}),
		).toBeNull();
	});
});
