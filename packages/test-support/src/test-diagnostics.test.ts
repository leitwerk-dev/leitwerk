import { expect, it } from "vitest";
import { createTestDiagnostics, traceTestSubprocess } from "./test-diagnostics.js";

it("records timestamps and subprocess exits without recording arguments or error messages", () => {
	const trace = createTestDiagnostics("example");
	const failure = Object.assign(new Error("secret output"), {
		status: null,
		signal: "SIGTERM",
		code: "ETIMEDOUT",
	});
	trace.run(() => {
		expect(traceTestSubprocess("git init", () => "ok")).toBe("ok");
		expect(() =>
			traceTestSubprocess("git push", () => {
				throw failure;
			}),
		).toThrow(failure);
	});
	const output = trace.format();
	const { events } = JSON.parse(output);
	expect(events).toHaveLength(5);
	expect(events[2]).toMatchObject({
		stage: "subprocess.exit",
		operation: "git init",
		status: 0,
		durationMs: expect.any(Number),
	});
	expect(events[4]).toMatchObject({ status: null, signal: "SIGTERM", code: "ETIMEDOUT" });
	expect(
		events.every(
			(event: { at: string; elapsedMs: number }) =>
				Number.isFinite(Date.parse(event.at)) && event.elapsedMs >= 0,
		),
	).toBe(true);
	expect(output).not.toContain("secret output");
});

it("keeps concurrent async traces separate and bounds retained events", async () => {
	const first = createTestDiagnostics("first");
	const second = createTestDiagnostics("second");
	await Promise.all([
		first.run(async () => {
			await Promise.resolve();
			traceTestSubprocess("first command", () => 1);
		}),
		second.run(async () => {
			await Promise.resolve();
			traceTestSubprocess("second command", () => 2);
		}),
	]);
	expect(first.format()).not.toContain("second command");
	expect(second.format()).not.toContain("first command");
	for (let i = 0; i < 600; i++) first.mark(`stage-${i}`);
	const snapshot = JSON.parse(first.format());
	expect(snapshot.events).toHaveLength(512);
	expect(snapshot.dropped).toBe(91);
	expect(snapshot.events.at(-1).stage).toBe("stage-599");
});

it("does not change untraced subprocess results or errors", () => {
	expect(traceTestSubprocess("untraced", () => 42)).toBe(42);
	const error = new Error("failure");
	expect(() =>
		traceTestSubprocess("untraced", () => {
			throw error;
		}),
	).toThrow(error);
});
