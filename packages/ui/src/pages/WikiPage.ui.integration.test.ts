// @vitest-environment jsdom

import type { WikiPage, WikiTopic } from "@leitwerk-dev/wiki";
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
	revision: 3,
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
		editFailure?: boolean;
		groupDeleted?: boolean;
		index?: boolean;
	} = {},
) {
	let pages = [page];
	let groups = [topic];
	const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		requests.push({
			path: String(input),
			method: init?.method ?? "GET",
			...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
		});
		if (options.failure)
			return Response.json({ error: "Wiki unavailable. Try again." }, { status: 503 });
		if (options.groupDeleted && !input.endsWith("/topics"))
			return Response.json({ error: "Wiki group unavailable or deleted" }, { status: 404 });
		if (options.historyFailure && input.endsWith("/history"))
			return Response.json({ error: "History unavailable" }, { status: 503 });
		if (init?.method === "DELETE") {
			if (options.conflict)
				return Response.json(
					{ error: "Wiki revision conflict; refresh before deleting" },
					{ status: 409 },
				);
			pages = [];
			if (!input.includes("/pages/")) groups = [];
			return Response.json({ deleted: true });
		}
		if (init?.method === "PUT") {
			if (options.editFailure) return Response.json({ error: "Save unavailable" }, { status: 503 });
			if (options.conflict)
				return Response.json(
					{ error: "Wiki revision conflict; refresh before editing" },
					{ status: 409 },
				);
			const { expectedRevision, ...content } = JSON.parse(String(init.body));
			const saved = { ...pages[0], ...content, revision: expectedRevision + 1 };
			pages = [saved];
			return Response.json({ page: saved });
		}
		return Response.json(
			input.endsWith("/history")
				? { revisions: [page] }
				: input.endsWith("/topics")
					? { topics: groups }
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
		setGroup(value: WikiTopic) {
			groups = [value];
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

it("edits entry content with its read revision and keeps evidence in the saved entry", async () => {
	const test = await fixture();
	test.button("Edit entry").click();
	await vi.waitFor(() => expect(test.target.querySelector("#wiki-edit-title")).not.toBeNull());
	const title = test.target.querySelector<HTMLInputElement>("#wiki-edit-title")!;
	title.value = "Corrected README sections";
	title.dispatchEvent(new Event("input", { bubbles: true }));
	const markdown = test.target.querySelector<HTMLTextAreaElement>("#wiki-edit-markdown")!;
	markdown.value = "Use **Setup**, Validation and Troubleshooting.";
	markdown.dispatchEvent(new Event("input", { bubbles: true }));
	expect(test.target.querySelector("form")?.checkValidity()).toBe(true);
	test.button("Save changes").click();
	await vi.waitFor(() => expect(test.target.textContent).toContain("Entry saved."));
	expect(test.target.textContent).toContain("Revision 3");
	expect(test.target.querySelector("#wiki-edit-title")).toBeNull();
	expect(test.requests.find((request) => request.method === "PUT")).toMatchObject({
		body: {
			title: "Corrected README sections",
			markdown: markdown.value,
			expectedRevision: 2,
			evidence: page.evidence,
		},
	});
});

it("keeps editing drafts on save failure and topic updates, then reloads deliberately after a conflict", async () => {
	const options = { editFailure: true };
	const test = await fixture(options);
	test.button("Edit entry").click();
	await vi.waitFor(() => expect(test.target.querySelector("#wiki-edit-markdown")).not.toBeNull());
	const input = test.target.querySelector<HTMLTextAreaElement>("#wiki-edit-markdown")!;
	input.value = "My unsaved correction";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	test.button("Save changes").click();
	await vi.waitFor(() => expect(test.target.textContent).toContain("Save unavailable"));
	expect(input.value).toBe("My unsaved correction");
	test.setPages([{ ...page, revision: 3, markdown: "Concurrent agent edit" }]);
	notifyWikiUpdated(topic.id);
	await vi.waitFor(() => expect(test.target.textContent).toContain("Your draft has been kept"));
	expect(input.value).toBe("My unsaved correction");
	expect(test.button("Save changes").disabled).toBe(true);
	test.button("Reload latest entry").click();
	await vi.waitFor(() =>
		expect(test.target.querySelector<HTMLTextAreaElement>("#wiki-edit-markdown")!.value).toBe(
			"Concurrent agent edit",
		),
	);
	expect(test.button("Save changes").disabled).toBe(false);
	test.button("Cancel editing").click();
	await vi.waitFor(() => expect(test.target.querySelector("form")).toBeNull());
});

it("deletes a complete group from the index only after explicit confirmation", async () => {
	const test = await fixture({ index: true });
	test.button("Delete group…").click();
	await vi.waitFor(() => expect(test.target.textContent).toContain("and all its entries?"));
	expect(test.requests.some((request) => request.method === "DELETE")).toBe(false);
	test.button("Cancel").click();
	await vi.waitFor(() => expect(test.button("Delete group and all entries")).toBeUndefined());
	test.button("Delete group…").click();
	await vi.waitFor(() => expect(test.button("Delete group and all entries")).toBeTruthy());
	test.button("Delete group and all entries").click();
	await vi.waitFor(() => expect(test.target.textContent).toContain("No solution wikis yet"));
	expect(test.requests.find((request) => request.method === "DELETE")?.path).toBe(
		`/api/wiki/topics/${topic.id}?revision=3`,
	);
});

it.each([
	true,
	false,
])("moves focus into group deletion and returns to its trigger on cancel (index: %s)", async (index) => {
	const test = await fixture({ index });
	const trigger = test.button(index ? "Delete group…" : "Delete wiki group…");
	trigger.focus();
	trigger.click();
	await vi.waitFor(() =>
		expect(document.activeElement).toBe(
			test.target.querySelector('[aria-label="Confirm wiki group deletion"] h2'),
		),
	);
	test.button("Cancel").click();
	await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
	expect(test.target.querySelector('[aria-label="Confirm wiki group deletion"]')).toBeNull();
	expect(test.requests.some((request) => request.method === "DELETE")).toBe(false);
});

it("clears removed group content on a live update while preserving an open draft", async () => {
	const options = { groupDeleted: false };
	const test = await fixture(options);
	test.button("Edit entry").click();
	await vi.waitFor(() => expect(test.target.querySelector("#wiki-edit-markdown")).not.toBeNull());
	options.groupDeleted = true;
	notifyWikiUpdated(topic.id);
	await vi.waitFor(() => expect(test.target.textContent).toContain("group unavailable or deleted"));
	expect(test.target.querySelector<HTMLTextAreaElement>("#wiki-edit-markdown")?.value).toBe(
		page.markdown,
	);
	expect(test.button("Save changes").disabled).toBe(true);
	test.button("Cancel editing").click();
	await vi.waitFor(() => expect(test.target.querySelector("article")).toBeNull());
	expect(test.target.textContent).not.toContain(page.title);
});

it.each([
	"group",
	"entry",
] as const)("requires a fresh %s confirmation after a deletion conflict", async (kind) => {
	const group = kind === "group";
	const options = { index: group, conflict: true };
	const test = await fixture(options);
	const open = group ? "Delete group…" : "Delete entry…";
	const confirm = group ? "Delete group and all entries" : "Delete entry";
	const refresh = `Refresh ${kind} before deleting`;
	const revision = group ? 3 : 2;
	const url = `/api/wiki/topics/${topic.id}${group ? "" : `/pages/${page.id}`}`;
	test.button(open).click();
	await vi.waitFor(() => expect(test.button(confirm)).toBeTruthy());
	test.button(confirm).click();
	await vi.waitFor(() => expect(test.button(refresh)).toBeTruthy());
	if (group) test.setGroup({ ...topic, revision: 4 });
	else test.setPages([{ ...page, revision: 3 }]);
	test.button(refresh).click();
	await vi.waitFor(() => {
		if (group)
			expect(test.target.querySelector('[aria-label="Confirm wiki group deletion"]')).toBeNull();
		else expect(test.target.textContent).toContain("Revision 3");
	});
	expect(test.button(confirm)).toBeUndefined();
	options.conflict = false;
	test.button(open).click();
	await vi.waitFor(() => expect(test.button(confirm)).toBeTruthy());
	test.button(confirm).click();
	await vi.waitFor(() =>
		expect(test.target.textContent).toContain(
			group ? "No solution wikis yet" : "Entry unavailable",
		),
	);
	expect(
		test.requests.filter((request) => request.method === "DELETE").map((request) => request.path),
	).toEqual([`${url}?revision=${revision}`, `${url}?revision=${revision + 1}`]);
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
	await vi.waitFor(() => expect(test.target.textContent).toContain("No shared solutions yet"));
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
