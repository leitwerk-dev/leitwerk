import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyPollResult } from "./poll-loop.js";
import { createPollingCoordinator } from "./polling-coordinator.js";

afterEach(() => {
	vi.useRealTimers();
});

function logger() {
	return {
		warn: vi.fn(),
		error: vi.fn(),
	};
}

describe("polling coordinator", () => {
	it("logs scheduled exceptions with poller context and continues polling", async () => {
		vi.useFakeTimers();
		const log = logger();
		const failure = new Error("remote unavailable");
		const pollOnce = vi
			.fn<() => Promise<ReturnType<typeof emptyPollResult>>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue(emptyPollResult());
		const coordinator = createPollingCoordinator(log);
		coordinator.create({
			id: "work-queue",
			pollOnce,
			isEnabled: () => true,
			pollInterval: () => "1s",
		});

		coordinator.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(log.error).toHaveBeenCalledWith(
			{ pollerId: "work-queue", durationMs: expect.any(Number), err: failure },
			"Poll failed",
		);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(pollOnce).toHaveBeenCalledTimes(2);
		coordinator.stop();
	});

	it("logs completed poll results containing operational errors", async () => {
		vi.useFakeTimers();
		const log = logger();
		const result = { ...emptyPollResult(), errors: ["repo#16:launch_failed"] };
		const coordinator = createPollingCoordinator(log);
		coordinator.create({
			id: "work-queue",
			pollOnce: async () => result,
			isEnabled: () => true,
			pollInterval: () => "1s",
		});

		coordinator.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(log.warn).toHaveBeenCalledWith(
			{ pollerId: "work-queue", durationMs: expect.any(Number), result },
			"Poll completed with errors",
		);
		coordinator.stop();
	});

	it("rejects duplicate and late registrations", () => {
		const coordinator = createPollingCoordinator(logger());
		const registration = {
			id: "work-queue",
			pollOnce: async () => emptyPollResult(),
			isEnabled: () => true,
			pollInterval: () => "1s",
		};
		coordinator.create(registration);
		expect(() => coordinator.create(registration)).toThrow("Duplicate poller 'work-queue'");
		coordinator.start();
		expect(() => coordinator.create({ ...registration, id: "github" })).toThrow(
			"after polling has started",
		);
		coordinator.stop();
	});
});
