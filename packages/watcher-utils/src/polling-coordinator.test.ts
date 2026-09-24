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

		try {
			coordinator.start();
			await vi.advanceTimersByTimeAsync(0);

			expect(log.error).toHaveBeenCalledWith(
				{ pollerId: "work-queue", durationMs: expect.any(Number), err: failure },
				expect.any(String),
			);

			await vi.advanceTimersByTimeAsync(1_000);
			expect(pollOnce).toHaveBeenCalledTimes(2);
		} finally {
			await coordinator.stop();
		}
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

		try {
			coordinator.start();
			await vi.advanceTimersByTimeAsync(0);

			expect(log.warn).toHaveBeenCalledWith(
				{ pollerId: "work-queue", durationMs: expect.any(Number), result },
				expect.any(String),
			);
		} finally {
			await coordinator.stop();
		}
	});

	it("rejects duplicate and late registrations", async () => {
		const coordinator = createPollingCoordinator(logger());
		const registration = {
			id: "work-queue",
			pollOnce: async () => emptyPollResult(),
			isEnabled: () => true,
			pollInterval: () => "1s",
		};
		coordinator.create(registration);
		expect(() => coordinator.create(registration)).toThrow(/work-queue/);
		try {
			coordinator.start();
			expect(() => coordinator.create({ ...registration, id: "github" })).toThrow(/github/);
		} finally {
			await coordinator.stop();
		}
	});

	it("coalesces scheduled and explicit polls and drains work before shutdown", async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<ReturnType<typeof emptyPollResult>>();
		const result = emptyPollResult();
		const pollOnce = vi.fn(() => pending.promise);
		const coordinator = createPollingCoordinator(logger());
		const poller = coordinator.create({
			id: "work-queue",
			pollOnce,
			isEnabled: () => true,
			pollInterval: () => "1s",
		});
		try {
			coordinator.start();
			const explicitPoll = poller.poll();
			await vi.advanceTimersByTimeAsync(2_000);
			expect(pollOnce).toHaveBeenCalledTimes(1);

			let stopped = false;
			const stopping = coordinator.stop().then(() => {
				stopped = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(stopped).toBe(false);
			pending.resolve(result);
			await expect(explicitPoll).resolves.toBe(result);
			await stopping;
			await vi.advanceTimersByTimeAsync(2_000);
			expect(pollOnce).toHaveBeenCalledTimes(1);
		} finally {
			pending.resolve(result);
			await coordinator.stop();
		}
	});
});
