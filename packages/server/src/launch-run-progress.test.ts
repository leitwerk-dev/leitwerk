import type { LaunchRun } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { initialLaunchSteps } from "./launch-pipeline.js";
import {
	observeBootstrapProgress,
	reconcileCommittedLaunch,
	startupEvidenceScore,
} from "./launch-run-progress.js";

function run(overrides: Partial<LaunchRun> = {}): LaunchRun {
	return {
		id: "lrn_test",
		launcherId: "demo.ui",
		instanceId: "agt_test",
		idempotencyKey: null,
		origin: "ui",
		status: "starting",
		steps: initialLaunchSteps(),
		createdAt: "2027-01-01T00:00:00.000Z",
		updatedAt: "2027-01-01T00:00:00.000Z",
		completedAt: null,
		revision: 1,
		...overrides,
	};
}

describe("launch-run progress projection", () => {
	it("keeps bootstrap evidence monotonic", () => {
		const prepared = observeBootstrapProgress(run(), "preparing_turn");
		const replayed = observeBootstrapProgress(prepared, "loading_resources");
		expect(replayed.steps.find((step) => step.id === "prepare_workspace")?.status).toBe(
			"completed",
		);
	});

	it("scores startup retries above older launch attempts", () => {
		expect(startupEvidenceScore(run({ origin: "startup_retry" }))).toBeGreaterThan(
			startupEvidenceScore(run()),
		);
	});

	it("reconciles only from authoritative startup evidence", () => {
		const reconciled = reconcileCommittedLaunch(run(), {
			process: {
				id: "agt_test",
				processId: "demo",
				title: "Demo",
			} as never,
			leaseState: "ready",
			hasBootstrapReceipt: true,
			hasTurn: true,
			titleGenerationAvailable: true,
			titleJobFailed: false,
		});

		expect(reconciled.status).toBe("completed");
		expect(reconciled.steps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "prepare_workspace", status: "completed" }),
				expect.objectContaining({ id: "start_first_turn", status: "completed" }),
			]),
		);
	});
});
