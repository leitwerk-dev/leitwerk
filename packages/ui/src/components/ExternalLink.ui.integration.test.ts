// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import ExternalLink from "./ExternalLink.svelte";

let mounted: ReturnType<typeof mount> | null = null;

afterEach(() => {
	if (mounted) {
		unmount(mounted);
		mounted = null;
	}
	document.body.replaceChildren();
});

describe("ExternalLink", () => {
	it("renders an accessible, keyboard-native issue link", () => {
		mounted = mount(ExternalLink, {
			target: document.body,
			props: {
				href: "https://forgejo.example/jonas/vocabelle/issues/6",
				label: "jonas/vocabelle#6",
				resourceType: "issue",
			},
		});

		const link = document.querySelector<HTMLAnchorElement>("a.external-link");
		expect(link?.textContent).toContain("jonas/vocabelle#6");
		expect(link?.target).toBe("_blank");
		expect(link?.rel).toBe("noopener noreferrer");
		expect(link?.getAttribute("aria-label")).toBe("Issue: jonas/vocabelle#6 (opens in a new tab)");
		expect(link?.querySelector(".external-link-icon")?.getAttribute("aria-hidden")).toBe("true");
		expect(link?.tabIndex).toBe(0);
	});
});
