// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
	decorateExternalLink,
	externalResourceLabel,
	isExternalHref,
	NEW_TAB_WINDOW_FEATURES,
	normalizeLinkNavigation,
	secureAnchorNewTab,
} from "./external-links.js";

const BASE_URI = "https://leitwerk.example/processes/agt_1";

describe("external links", () => {
	it.each([
		["#details", false],
		["./history", false],
		["/processes/agt_2", false],
		["https://leitwerk.example/account", false],
		["https://forgejo.example/jonas/vocabelle/issues/6", true],
		["mailto:operator@example.com", true],
	] as const)("classifies %s", (href, expected) => {
		expect(isExternalHref(href, BASE_URI)).toBe(expected);
	});

	it("centralizes secured new-tab behavior", () => {
		const link = document.createElement("a");
		secureAnchorNewTab(link);
		expect(link.target).toBe("_blank");
		expect(link.rel).toBe("noopener noreferrer");
		expect(NEW_TAB_WINDOW_FEATURES).toBe("noopener,noreferrer");
	});

	it("decorates external anchors idempotently", () => {
		const link = document.createElement("a");
		link.href = "https://forgejo.example/pulls/12";
		link.textContent = "PR #12";

		decorateExternalLink(link);
		decorateExternalLink(link);

		expect(link.target).toBe("_blank");
		expect(link.rel).toBe("noopener noreferrer");
		expect(link.classList.contains("external-link")).toBe(true);
		expect(link.querySelectorAll(".external-link-icon")).toHaveLength(1);
		expect(link.querySelectorAll(".external-link-a11y")).toHaveLength(1);
		expect(link.textContent).toContain("opens in a new tab");
	});

	it("removes new-tab behavior and decoration from internal anchors", () => {
		const link = document.createElement("a");
		link.href = "/processes/agt_2";
		link.target = "_blank";
		link.rel = "noreferrer";
		link.textContent = "Another process";
		decorateExternalLink(link);

		normalizeLinkNavigation(link, BASE_URI);

		expect(link.hasAttribute("target")).toBe(false);
		expect(link.hasAttribute("rel")).toBe(false);
		expect(link.classList.contains("external-link")).toBe(false);
		expect(link.querySelector(".external-link-icon")).toBeNull();
	});

	it("provides expanded resource names", () => {
		expect(externalResourceLabel("issue")).toBe("Issue");
		expect(externalResourceLabel("pull_request")).toBe("Pull request");
		expect(externalResourceLabel("merge_request")).toBe("Merge request");
	});
});
