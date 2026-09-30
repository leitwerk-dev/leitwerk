// @vitest-environment jsdom

import type { WikiPage, WikiTopic } from "@leitwerk-dev/domain";
import { mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { notifyWikiUpdated } from "../lib/wiki.js";
import WikiPageView from "./WikiPage.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const topic: WikiTopic = {
	id: "epic-one",
	key: "topic:1",
	title: "APP-10: Standardize READMEs",
	url: "https://tracker.test/APP-10",
	sourceRevision: "current",
};
const page: WikiPage = {
	id: "template",
	topicId: topic.id,
	revision: 2,
	title: "Shared README sections",
	markdown: "Use **Setup** and Validation. <script>alert(1)</script>",
	applicability: "Repositories with the legacy template",
	status: "needs_revalidation",
	evidence: [
		{
			repository: "team/service",
			path: "README.md",
			revision: "a".repeat(40),
			observation: "The old template lacks validation instructions",
		},
	],
	links: [],
	sourceRevision: "old",
	instanceId: "process-one",
	turnRecordId: "turn-one",
	updatedAt: "2026-09-30T10:00:00Z",
	deleted: false,
};

afterEach(async () => {
	for (const app of mounted.splice(0)) await unmount(app);
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

async function fixture(
	options: {
		conflict?: boolean;
		failure?: boolean;
		historyFailure?: boolean;
		index?: boolean;
	} = {},
) {
	let pages = [page];
	const requests: { path: string; method: string }[] = [];
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		requests.push({ path: String(input), method: init?.method ?? "GET" });
		if (options.failure)
			return Response.json({ error: "Wiki unavailable. Try again." }, { status: 503 });
		if (options.historyFailure && input.endsWith("/history"))
			return Response.json({ error: "History unavailable" }, { status: 503 });
		if (init?.method === "DELETE") {
			if (options.conflict)
				return Response.json(
					{ error: "Wiki revision conflict; refresh before deleting" },
					{ status: 409 },
				);
			pages = [];
			return Response.json({ deleted: true });
		}
		return Response.json(
			input.endsWith("/history")
				? { revisions: [page] }
				: input.endsWith("/topics")
					? { topics: [topic] }
					: { topic, pages },
		);
	});
	const target = document.createElement("div");
	document.body.appendChild(target);
	mounted.push(
		mount(WikiPageView, {
			target,
			props: options.index ? {} : { topicId: topic.id, pageId: page.id },
		}),
	);
	await vi.waitFor(() =>
		expect(target.textContent).toContain(options.failure ? "Wiki unavailable" : topic.title),
	);
	const button = (label: string) =>
		[...target.querySelectorAll("button")].find((button) => button.textContent === label)!;
	return {
		target,
		requests,
		button,
		setPages(value: WikiPage[]) {
			pages = value;
		},
	};
}

it("renders scoped evidence, sanitized guidance, navigation, and filtering", async () => {
	const test = await fixture();
	expect(test.target.textContent).toContain("Revalidate this guidance before reuse");
	expect(test.target.textContent).toContain("team/service");
	expect(test.target.textContent).toContain("turn-one");
	expect(test.target.querySelector("script")).toBeNull();
	expect(test.target.querySelector('a[href="/processes/process-one"]')).not.toBeNull();
	const input = test.target.querySelector("input")!;
	input.value = "nothing matches";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await vi.waitFor(() =>
		expect(test.target.textContent).toContain("No entries match these filters"),
	);
});

it("confirms deletion with a revision and clears stale history on refresh", async () => {
	const test = await fixture();
	test.button("Show revision history").click();
	await vi.waitFor(() => expect(test.target.querySelector("details")).not.toBeNull());
	test.button("Delete entry…").click();
	await vi.waitFor(() => expect(test.button("Delete entry")).toBeTruthy());
	expect(test.requests.filter((request) => request.method === "DELETE")).toEqual([]);
	test.button("Cancel").click();
	await vi.waitFor(() => expect(test.button("Delete entry")).toBeUndefined());
	test.button("Delete entry…").click();
	await vi.waitFor(() => expect(test.button("Delete entry")).toBeTruthy());
	test.button("Delete entry").click();
	await vi.waitFor(() => expect(test.target.textContent).toContain("Entry unavailable"));
	expect(test.requests.find((request) => request.method === "DELETE")?.path).toContain(
		"?revision=2",
	);
	expect(test.target.querySelector("details")).toBeNull();
});

it("keeps a conflicting deletion visible and refreshes on a topic invalidation", async () => {
	const test = await fixture({ conflict: true });
	test.button("Delete entry…").click();
	await vi.waitFor(() => expect(test.button("Delete entry")).toBeTruthy());
	test.button("Delete entry").click();
	await vi.waitFor(() =>
		expect(test.target.querySelector('[role="alert"]')?.textContent).toContain("revision conflict"),
	);
	test.setPages([]);
	notifyWikiUpdated(topic.id);
	await vi.waitFor(() => expect(test.target.textContent).toContain("No shared findings yet"));
});

it("requires a fresh confirmation after a deletion conflict", async () => {
	const options = { conflict: true };
	const test = await fixture(options);
	test.button("Delete entry…").click();
	await vi.waitFor(() => expect(test.button("Delete entry")).toBeTruthy());
	test.button("Delete entry").click();
	await vi.waitFor(() => expect(test.button("Refresh entry before deleting")).toBeTruthy());
	test.setPages([{ ...page, revision: 3 }]);
	test.button("Refresh entry before deleting").click();
	await vi.waitFor(() => expect(test.target.textContent).toContain("Revision 3"));
	expect(test.button("Delete entry")).toBeUndefined();
	options.conflict = false;
	test.button("Delete entry…").click();
	await vi.waitFor(() => expect(test.button("Delete entry")).toBeTruthy());
	test.button("Delete entry").click();
	await vi.waitFor(() => expect(test.target.textContent).toContain("Entry unavailable"));
	expect(
		test.requests.filter((request) => request.method === "DELETE").map((request) => request.path),
	).toEqual([
		`/api/wiki/topics/${topic.id}/pages/${page.id}?revision=2`,
		`/api/wiki/topics/${topic.id}/pages/${page.id}?revision=3`,
	]);
});

it("lists epic wikis without leaking another topic's page content", async () => {
	const test = await fixture({ index: true });
	expect(test.target.querySelector('a[href="/wiki/epic-one"]')).not.toBeNull();
	expect(test.target.textContent).not.toContain(page.markdown);
});

it("does not mistake a failed index request for an empty index", async () => {
	const test = await fixture({ index: true, failure: true });
	expect(test.target.textContent).not.toContain("No solution wikis yet");
});

it("reports history failures beside the entry and retries the history request", async () => {
	const options = { historyFailure: true };
	const test = await fixture(options);
	test.button("Show revision history").click();
	await vi.waitFor(() =>
		expect(test.target.querySelector('article [role="alert"]')?.textContent).toContain(
			"History unavailable",
		),
	);
	options.historyFailure = false;
	test.button("Retry history").click();
	await vi.waitFor(() => expect(test.target.querySelector("details")).not.toBeNull());
	expect(test.requests.filter((request) => request.path.endsWith("/history"))).toHaveLength(2);
});
