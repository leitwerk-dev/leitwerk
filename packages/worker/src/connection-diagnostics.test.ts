import { expect, it } from "vitest";
import { createConnectionDiagnosticRecorder } from "./connection-diagnostics.js";

it("retains the first failure and latest observation, then clears them on connection", () => {
	const saved: string[] = [];
	const logged: string[] = [];
	const record = createConnectionDiagnosticRecorder({
		log: (message) => logged.push(message),
		persist: (message) => saved.push(message),
	});
	record("first error");
	record("first close");
	record("second error");
	expect(saved.at(-1)).toBe("first error\nsecond error");
	record("");
	expect(saved.at(-1)).toBe("");
	record("later error");
	expect(saved.at(-1)).toBe("later error");
	expect(logged).toHaveLength(4);
});

it("continues logging when the termination file cannot be written", () => {
	const logged: string[] = [];
	const record = createConnectionDiagnosticRecorder({
		log: (message) => logged.push(message),
		persist: () => {
			throw new Error("read only");
		},
	});
	expect(() => record("connection failed")).not.toThrow();
	expect(logged).toEqual(["connection failed"]);
});
