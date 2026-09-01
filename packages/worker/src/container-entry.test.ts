import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runWorkerContainerEntrypoint } from "./container-entry.js";

function child() {
	const value = new EventEmitter() as ChildProcess;
	Object.assign(value, {
		exitCode: null,
		signalCode: null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => {
			(value as { signalCode: NodeJS.Signals | null }).signalCode = "SIGTERM";
			value.emit("exit", null, "SIGTERM");
			return true;
		}),
	});
	return value;
}

function exit(value: ChildProcess, code: number) {
	(value as { exitCode: number | null }).exitCode = code;
	value.emit("exit", code, null);
}

function deps(spawned: ChildProcess[], overrides: Record<string, unknown> = {}) {
	let time = 0;
	return {
		spawn: vi.fn(() => spawned.shift() as ChildProcess) as unknown as typeof spawn,
		dockerInfo: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
		now: () => time,
		delay: vi.fn(async (ms: number) => {
			time += ms;
		}),
		warn: vi.fn(),
		...overrides,
	};
}

describe("worker container entrypoint", () => {
	it("starts only the worker in ordinary mode", async () => {
		const worker = child();
		const runtime = deps([worker]);
		const running = runWorkerContainerEntrypoint({}, runtime);
		exit(worker, 0);
		await expect(running).resolves.toBe(0);
		expect(runtime.spawn).toHaveBeenCalledOnce();
		expect(runtime.spawn.mock.calls[0]?.[1]?.[0]).toMatch(/worker-entry\.js$/u);
	});

	it("waits for daemon readiness before starting the worker", async () => {
		const daemon = child();
		const worker = child();
		const runtime = deps([daemon, worker]);
		const running = runWorkerContainerEntrypoint({ LEITWERK_PRIVATE_DOCKER: "1" }, runtime);
		await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledTimes(2));
		expect(runtime.dockerInfo).toHaveBeenCalled();
		exit(worker, 0);
		await expect(running).resolves.toBe(0);
	});

	it("resets only the Docker data root and retries once after an early exit", async () => {
		const first = child();
		const second = child();
		const worker = child();
		let checks = 0;
		const runtime = deps([first, second, worker], {
			dockerInfo: vi.fn(async () => {
				checks += 1;
				if (checks === 1) exit(first, 1);
				if (checks === 2) throw new Error("not ready");
			}),
		});
		const running = runWorkerContainerEntrypoint({ LEITWERK_PRIVATE_DOCKER: "1" }, runtime);
		await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledTimes(3));
		exit(worker, 0);
		await expect(running).resolves.toBe(0);
		expect(runtime.remove).toHaveBeenCalledOnce();
		expect(runtime.remove).toHaveBeenCalledWith("/state/tooling/docker", {
			recursive: true,
			force: true,
		});
		expect(runtime.warn).toHaveBeenCalledOnce();
	});

	it("does not reset a live daemon when readiness times out", async () => {
		const daemon = child();
		const runtime = deps([daemon], {
			dockerInfo: vi.fn().mockRejectedValue(new Error("not ready")),
		});
		await expect(
			runWorkerContainerEntrypoint(
				{ LEITWERK_PRIVATE_DOCKER: "1", LEITWERK_WORKER_STARTUP_TIMEOUT_MS: "500" },
				runtime,
			),
		).rejects.toThrow(/readiness timed out/);
		expect(runtime.remove).not.toHaveBeenCalled();
	});

	it("shares one absolute readiness deadline across recovery attempts", async () => {
		const first = child();
		const second = child();
		let time = 0;
		let checks = 0;
		const dockerInfo = vi.fn(async () => {
			checks += 1;
			if (checks === 1) exit(first, 1);
			else throw new Error("not ready");
		});
		const runtime = deps([first, second], {
			now: () => time,
			dockerInfo,
			remove: vi.fn(async () => {
				time = 450;
			}),
			delay: vi.fn(async (ms: number) => {
				time += ms;
			}),
		});

		await expect(
			runWorkerContainerEntrypoint(
				{ LEITWERK_PRIVATE_DOCKER: "1", LEITWERK_WORKER_STARTUP_DEADLINE_MS: "500" },
				runtime,
			),
		).rejects.toThrow(/readiness timed out/);
		expect(dockerInfo).toHaveBeenCalledTimes(2);
		expect(runtime.remove).toHaveBeenCalledOnce();
	});
});
