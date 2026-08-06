// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchInstalledSkillDetail,
	fetchSkills,
	refreshSkills,
	registerSkill,
	removeSkill,
} from "../lib/api.js";
import { navigate } from "../lib/router.svelte";
import SkillsPage from "./SkillsPage.svelte";

const usage = {
	attachedAllTime: 8,
	attachedLast30Days: 3,
	invokedAllTime: 4,
	invokedLast30Days: 2,
};

const installed = {
	id: "configured",
	label: "Configured skill",
	description: "Managed directly",
	activeRevisionId: "skillrev_1",
	activeSourceRevision: null,
	registrationKind: "configuration" as const,
	sourceRepositoryId: null,
	updateAvailable: false,
	usage,
};

const remote = {
	repositoryId: "shared",
	id: "review",
	label: "Review",
	description: "Review changes",
	sourcePath: "skills/review",
	sourceRevision: "abcdef123456",
	registered: false,
	updateAvailable: false,
	conflict: false,
	stale: false,
	usage: { ...usage, attachedAllTime: 0, attachedLast30Days: 0 },
};

vi.mock("../lib/api.js", () => ({
	fetchInstalledSkillDetail: vi.fn(),
	fetchSkillDetail: vi.fn(),
	fetchSkills: vi.fn(),
	refreshSkills: vi.fn(),
	registerSkill: vi.fn(),
	removeSkill: vi.fn(),
}));

vi.mock("../lib/router.svelte", () => ({
	buildAvailableSkillPath: (repositoryId: string, skillId: string) =>
		`/skills/available/${repositoryId}/${skillId}`,
	buildInstalledSkillPath: (skillId: string) => `/skills/installed/${skillId}`,
	buildProcessPath: (instanceId: string) => `/processes/${instanceId}`,
	buildSkillsPath: () => "/skills",
	followLink: vi.fn(),
	navigate: vi.fn(),
}));

const mountedApps: Array<ReturnType<typeof mount>> = [];

function catalog() {
	return {
		repositories: [
			{
				id: "shared",
				label: "Shared",
				url: "https://example.test/shared.git",
				ref: "main",
				path: "skills",
				lastRefreshedAt: "2026-08-01T10:00:00.000Z",
				error: null,
			},
		],
		availableSkills: [remote],
		installedSkills: [installed],
	};
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountSubject(props: { detailKind?: string; skillId?: string } = {}) {
	const target = document.createElement("div");
	document.body.append(target);
	mountedApps.push(mount(SkillsPage, { target, props }));
	return target;
}

function click(element: Element | null) {
	if (!(element instanceof HTMLElement)) throw new Error("expected clickable element");
	element.click();
}

function choose(element: Element | null, value: string) {
	if (!(element instanceof HTMLSelectElement)) throw new Error("expected select element");
	element.value = value;
	element.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(() => {
	for (const app of mountedApps.splice(0)) unmount(app);
	vi.clearAllMocks();
	document.body.innerHTML = "";
});

describe("SkillsPage", () => {
	it("separates installed skills from remote candidates and displays configured repositories in a modal popup", async () => {
		vi.mocked(fetchSkills).mockResolvedValue(catalog());
		const target = mountSubject();
		await flush();

		expect(target.textContent).toContain("Configured skill");
		expect(target.textContent).not.toContain("Review changes");
		expect(target.querySelector('[data-section="repository-modal"]')).toBeNull();

		click(
			[...target.querySelectorAll("button")].find((btn) =>
				btn.textContent?.includes("Repositories (1)"),
			) ?? null,
		);
		await flush();

		const modal = target.querySelector('[data-section="repository-modal"]');
		expect(modal).not.toBeNull();
		expect(document.activeElement).toBe(
			modal?.querySelector('[aria-label="Close configured repositories"]'),
		);
		expect(modal?.textContent).toContain("Shared");
		expect(modal?.textContent).toContain("https://example.test/shared.git");

		click(modal?.querySelector('[aria-label="Close configured repositories"]') ?? null);
		await flush();
		expect(target.querySelector('[data-section="repository-modal"]')).toBeNull();
		expect(document.activeElement?.textContent).toContain("Repositories (1)");

		click(target.querySelector('[data-catalog-view="available"]'));
		await flush();
		expect(target.textContent).toContain("Review changes");
	});

	it("does not duplicate already installed skills in Available remotely by default", async () => {
		const installedRemoteCandidate = {
			...remote,
			id: "already-installed",
			label: "Already Installed Skill",
			registered: true,
		};
		vi.mocked(fetchSkills).mockResolvedValue({
			...catalog(),
			availableSkills: [remote, installedRemoteCandidate],
		});
		const target = mountSubject();
		await flush();

		click(target.querySelector('[data-catalog-view="available"]'));
		await flush();

		expect(target.textContent).toContain("Review changes");
		expect(target.textContent).not.toContain("Already Installed Skill");

		choose(target.querySelectorAll("select")[1] ?? null, "all");
		await flush();
		expect(target.textContent).toContain("Already Installed Skill");
	});

	it("shows configuration-managed details without a removal action", async () => {
		vi.mocked(fetchSkills).mockResolvedValue(catalog());
		vi.mocked(fetchInstalledSkillDetail).mockResolvedValue({
			...installed,
			skillMarkdown: "# Configured skill",
			processes: [],
			revisions: [
				{
					id: "skillrev_1",
					sourceRevision: null,
					importedAt: "2026-08-01T10:00:00.000Z",
					active: true,
				},
			],
		});
		const target = mountSubject({ detailKind: "installed", skillId: "configured" });
		await flush();

		expect(target.textContent).toContain("managed by leitwerk.yaml");
		expect(target.textContent).toContain("Revision history");
		const instructionsTab = target.querySelector(
			'[role="tab"][aria-controls="skill-instructions"]',
		);
		click(instructionsTab);
		await flush();
		expect(target.querySelector("#skill-instructions")).not.toBeNull();
		instructionsTab?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
		);
		await flush();
		expect(target.querySelector("#skill-overview")).not.toBeNull();
		expect(document.activeElement?.getAttribute("aria-controls")).toBe("skill-overview");
		expect(
			[...target.querySelectorAll("button")].some((button) => button.textContent === "Remove"),
		).toBe(false);
		expect(removeSkill).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it("filters stale candidates and labels them as no longer available", async () => {
		vi.mocked(fetchSkills).mockResolvedValue({
			...catalog(),
			availableSkills: [
				remote,
				{
					...remote,
					id: "retired",
					label: "Retired skill",
					description: "No longer upstream",
					stale: true,
				},
			],
		});
		const target = mountSubject();
		await flush();

		click(target.querySelector('[data-catalog-view="available"]'));
		await flush();
		choose(target.querySelectorAll("select")[1] ?? null, "stale");
		await flush();

		expect(target.textContent).toContain("Retired skill");
		expect(target.textContent).toContain("No longer available");
		expect(target.textContent).not.toContain("Review changes");
	});

	it("shows repository-level refresh progress and errors", async () => {
		vi.mocked(fetchSkills).mockResolvedValue(catalog());
		let finishRefresh: ((value: ReturnType<typeof catalog>) => void) | undefined;
		vi.mocked(refreshSkills).mockReturnValue(
			new Promise((resolve) => {
				finishRefresh = resolve;
			}),
		);
		const target = mountSubject();
		await flush();
		click(
			[...target.querySelectorAll("button")].find((button) =>
				button.textContent?.includes("Repositories (1)"),
			) ?? null,
		);
		await flush();
		const modal = target.querySelector('[data-section="repository-modal"]');
		expect(modal).not.toBeNull();
		click(
			[...(modal?.querySelectorAll("button") ?? [])].find((button) =>
				button.textContent?.includes("Refresh all"),
			) ?? null,
		);
		await Promise.resolve();
		expect(target.textContent).toContain("Refreshing…");

		const failed = catalog();
		failed.repositories[0] = { ...failed.repositories[0], error: "repository unavailable" };
		finishRefresh?.(failed);
		await flush();
		expect(modal?.textContent).toContain("Refresh failed");
		expect(modal?.textContent).toContain("repository unavailable");
	});

	it("confirms removal and announces success", async () => {
		const repositoryInstalled = {
			...installed,
			id: "review",
			label: "Review",
			registrationKind: "catalog" as const,
			sourceRepositoryId: "shared",
		};
		vi.mocked(fetchSkills).mockResolvedValue({
			...catalog(),
			installedSkills: [repositoryInstalled],
		});
		vi.mocked(fetchInstalledSkillDetail).mockResolvedValue({
			...repositoryInstalled,
			skillMarkdown: "# Review",
			processes: [],
			revisions: [
				{
					id: "skillrev_1",
					sourceRevision: "abc",
					importedAt: "2026-08-01T10:00:00.000Z",
					active: true,
				},
			],
		});
		vi.mocked(removeSkill).mockResolvedValue();
		const target = mountSubject({ detailKind: "installed", skillId: "review" });
		await flush();

		click(
			[...target.querySelectorAll("button")].find((button) => button.textContent === "Remove") ??
				null,
		);
		await flush();
		expect(target.textContent).toContain("Remove Review from future runs?");
		expect(document.activeElement?.textContent).toBe("Confirm removal");
		click(
			[...target.querySelectorAll("button")].find((button) => button.textContent === "Cancel") ??
				null,
		);
		await flush();
		expect(document.activeElement?.textContent).toBe("Remove");
		click(
			[...target.querySelectorAll("button")].find((button) => button.textContent === "Remove") ??
				null,
		);
		await flush();
		click(
			[...target.querySelectorAll("button")].find(
				(button) => button.textContent === "Confirm removal",
			) ?? null,
		);
		await flush();

		expect(removeSkill).toHaveBeenCalledWith("review");
		const visibleStatus = target.querySelector('.status-banner[role="status"]');
		expect(visibleStatus?.textContent).toContain("Review removed from future runs.");
	});

	it("reloads installed detail after an update", async () => {
		const update = {
			...installed,
			id: "review",
			label: "Review",
			registrationKind: "catalog" as const,
			sourceRepositoryId: "shared",
			updateAvailable: true,
		};
		const detail = {
			...update,
			skillMarkdown: "# Review",
			processes: [],
			revisions: [
				{
					id: "skillrev_1",
					sourceRevision: "old",
					importedAt: "2026-08-01T10:00:00.000Z",
					active: true,
				},
			],
		};
		vi.mocked(fetchSkills).mockResolvedValue({ ...catalog(), installedSkills: [update] });
		vi.mocked(fetchInstalledSkillDetail)
			.mockResolvedValueOnce(detail)
			.mockResolvedValueOnce({
				...detail,
				activeSourceRevision: "new",
				updateAvailable: false,
				revisions: [{ ...detail.revisions[0], sourceRevision: "new" }],
			});
		vi.mocked(registerSkill).mockResolvedValue();
		const target = mountSubject({ detailKind: "installed", skillId: "review" });
		await flush();

		click(
			[...target.querySelectorAll("button")].find(
				(button) => button.textContent === "Update skill",
			) ?? null,
		);
		await flush();

		expect(fetchInstalledSkillDetail).toHaveBeenCalledTimes(2);
		expect(target.textContent).toContain("Skill updated.");
		expect(target.textContent).toContain("new");
	});
});
