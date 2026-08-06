import { describe, expect, it } from "vitest";
import {
	extractPiSessionMessageText,
	isPiSessionMessageEntryType,
	isPiSessionMessageEntryWithRecord,
	isPiSessionMessageRecord,
} from "./pi-session-message.js";

describe("Pi session message helpers", () => {
	it("extracts text from string content", () => {
		expect(extractPiSessionMessageText("plain text")).toBe("plain text");
	});

	it("joins text blocks and ignores non-text or malformed blocks", () => {
		expect(
			extractPiSessionMessageText([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: " world" },
				{ type: "text", text: 42 },
				null,
				["nested arrays are ignored"],
			]),
		).toBe("hello world");
	});

	it("returns empty text for unsupported content", () => {
		expect(extractPiSessionMessageText(undefined)).toBe("");
		expect(extractPiSessionMessageText({ type: "text", text: "not an array" })).toBe("");
	});

	it("distinguishes message entry type checks from message record checks", () => {
		expect(isPiSessionMessageEntryType({ type: "message" })).toBe(true);
		expect(isPiSessionMessageEntryWithRecord({ type: "message" })).toBe(false);
		expect(isPiSessionMessageEntryWithRecord({ type: "message", message: { role: "user" } })).toBe(
			true,
		);
		expect(isPiSessionMessageEntryWithRecord({ type: "message", message: null })).toBe(false);
		expect(isPiSessionMessageEntryType({ type: "label", message: { role: "user" } })).toBe(false);
	});

	it("accepts only object message records", () => {
		expect(isPiSessionMessageRecord({ content: "hello" })).toBe(true);
		expect(isPiSessionMessageRecord([])).toBe(false);
		expect(isPiSessionMessageRecord(null)).toBe(false);
		expect(isPiSessionMessageRecord("hello")).toBe(false);
	});
});
