// @vitest-environment jsdom

import type { LaunchRun } from "@leitwerk-dev/domain";
import type { WsFrame } from "@leitwerk-dev/protocol";
import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLaunchRun, fetchProcessLaunchRuns } from "../lib/api.js";
import { dispatchLaunchUpdated } from "../lib/launch-updates.js";
import LaunchChecklist from "./LaunchChecklist.svelte";

vi.mock("../lib/api.js", () => ({
	fetchLaunchRun: vi.fn(),
	fetchProcessLaunchRuns: vi.fn(),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function launchRun(revision: number, safeSummary: string): LaunchRun {
	return {
		id: "launch-1",
		launcherId: "launcher-1",
		origin: "ui",
		instanceId: "process-1",
		status: "starting",
		steps: [
			{
				id: "start_worker",
				label: "Start worker",
				status: "in_progress",
				safeSummary,
			},
		],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: `2026-01-01T00:00:0${revision}.000Z`,
		completedAt: null,
		revision,
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("LaunchChecklist", () => {
	it("ignores an older request that resolves after a WebSocket refresh", async () => {
		const stale = deferred<LaunchRun>();
		vi.mocked(fetchLaunchRun)
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValueOnce(launchRun(2, "New launch state"));
		vi.mocked(fetchProcessLaunchRuns).mockResolvedValue([]);

		const target = document.createElement("div");
		document.body.appendChild(target);
		const component = mount(LaunchChecklist, {
			target,
			props: { launchRunId: "launch-1" },
		});
		await vi.waitFor(() => expect(fetchLaunchRun).toHaveBeenCalledTimes(1));

		dispatchLaunchUpdated({
			type: "launch.updated",
			payload: { launchRunId: "launch-1", instanceId: "process-1" },
		} as WsFrame);
		await vi.waitFor(() => expect(target.textContent).toContain("New launch state"));

		stale.resolve(launchRun(1, "Stale launch state"));
		await flush();

		expect(target.textContent).toContain("New launch state");
		expect(target.textContent).not.toContain("Stale launch state");
		unmount(component);
	});
});
