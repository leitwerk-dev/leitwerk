// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { isInteractiveTarget, isPlainShortcut, isTextEntryTarget } from "./keyboard.js";

describe("isTextEntryTarget", () => {
	it("treats inputs, textareas and selects as text entry", () => {
		for (const tag of ["input", "textarea", "select"] as const) {
			expect(isTextEntryTarget(document.createElement(tag))).toBe(true);
		}
	});

	it("returns false for non-text elements and non-elements", () => {
		expect(isTextEntryTarget(document.createElement("div"))).toBe(false);
		expect(isTextEntryTarget(null)).toBe(false);
	});
});

describe("isPlainShortcut", () => {
	it("is true only when no command modifier is held", () => {
		expect(isPlainShortcut(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
		expect(isPlainShortcut(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }))).toBe(
			false,
		);
		expect(isPlainShortcut(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }))).toBe(
			false,
		);
	});
});

describe("isInteractiveTarget", () => {
	it("matches native and role-based interactive controls so shortcuts don't steal their keys", () => {
		expect(isInteractiveTarget(document.createElement("button"))).toBe(true);

		const link = document.createElement("a");
		link.href = "#";
		expect(isInteractiveTarget(link)).toBe(true);

		const roleButton = document.createElement("div");
		roleButton.setAttribute("role", "button");
		expect(isInteractiveTarget(roleButton)).toBe(true);
	});

	it("matches when the target is nested inside an interactive control", () => {
		const button = document.createElement("button");
		const inner = document.createElement("span");
		button.appendChild(inner);
		expect(isInteractiveTarget(inner)).toBe(true);
	});

	it("returns false for plain elements, bare links, and non-elements", () => {
		expect(isInteractiveTarget(document.createElement("div"))).toBe(false);
		// An anchor without an href is not a focusable control.
		expect(isInteractiveTarget(document.createElement("a"))).toBe(false);
		expect(isInteractiveTarget(null)).toBe(false);
	});
});
