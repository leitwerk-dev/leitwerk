import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	createCoalescedRunner,
	observeUnexpectedChildFailure,
	signalProcessGroup,
	stopAttached,
	stopManaged,
} from "./dev-process.ts";

function fakeChild(pid = 1234): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.assign(child, { pid, exitCode: null, signalCode: null });
	return child;
}

describe("managed development processes", () => {
	it("signals the complete detached process group", () => {
		const child = fakeChild();
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);

		signalProcessGroup(child, "SIGTERM");

		expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
		kill.mockRestore();
	});

	it("reports an unexpected child exit once", () => {
		const child = fakeChild();
		const onUnexpected = vi.fn();
		observeUnexpectedChildFailure(child, () => false, onUnexpected);

		child.emit("exit", 1, null);
		child.emit("error", new Error("duplicate failure"));

		expect(onUnexpected).toHaveBeenCalledOnce();
		expect(onUnexpected).toHaveBeenCalledWith({ code: 1, signal: null });
	});

	it("ignores an expected child exit", () => {
		const child = fakeChild();
		const onUnexpected = vi.fn();
		observeUnexpectedChildFailure(child, () => true, onUnexpected);

		child.emit("exit", 0, "SIGTERM");

		expect(onUnexpected).not.toHaveBeenCalled();
	});

	it("coalesces concurrent requests into one follow-up run", async () => {
		let release: (() => void) | undefined;
		const task = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const runner = createCoalescedRunner(task, () => false);

		runner.run();
		runner.run();
		runner.run();
		expect(task).toHaveBeenCalledTimes(1);

		release?.();
		await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
		release?.();
		await vi.waitFor(() => expect(runner.isRunning()).toBe(false));
	});

	it("propagates Ctrl+C without mistaking an exited group leader for a stopped group", async () => {
		const child = fakeChild();
		let groupAlive = true;
		const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
			if (signal === 0 && !groupAlive) {
				throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
			}
			return true;
		});
		let resolved = false;
		const stopped = stopManaged(child, { signal: "SIGINT", graceMs: 10_000 }).then(() => {
			resolved = true;
		});

		expect(kill).toHaveBeenCalledWith(-1234, "SIGINT");
		child.emit("exit", 0, null);
		await Promise.resolve();
		expect(resolved).toBe(false);

		groupAlive = false;
		await expect(stopped).resolves.toBeUndefined();
		kill.mockRestore();
	});

	it("signals an attached session directly so it can share the terminal process group", async () => {
		const child = fakeChild();
		const kill = vi.fn(() => true);
		child.kill = kill;
		const stopped = stopAttached(child, { signal: "SIGINT", graceMs: 10_000 });

		expect(kill).toHaveBeenCalledWith("SIGINT");
		child.emit("exit", null, "SIGINT");
		await expect(stopped).resolves.toBeUndefined();
	});

	it("finishes cleanup promptly when spawning the child failed", async () => {
		const child = fakeChild(0);
		const stopped = stopManaged(child, { graceMs: 10_000 });

		child.emit("error", new Error("spawn failed"));

		await expect(stopped).resolves.toBeUndefined();
	});
});
