import {
	repositorySettingsIdentity,
	type ScopedSettingsResolver,
	type ServerExtensionAPI,
	type SettingsSubjectInput,
	scopedSettingsCapability,
} from "@leitwerk-dev/process-sdk";
import { expect, it, vi } from "vitest";
import extension from "./index.js";

it("keeps identical repository IDs on GitHub and Enterprise origins distinct during discovery", async ({
	onTestFinished,
}) => {
	let discover: (() => Promise<readonly SettingsSubjectInput[]>) | undefined;
	const settings: Pick<ScopedSettingsResolver, "registerDiscovery"> = {
		registerDiscovery(scope, callback) {
			expect(scope).toBe("repository");
			discover = callback;
		},
	};
	const api = {
		get: (token: unknown) => (token === scopedSettingsCapability ? settings : undefined),
		provide() {},
	} as unknown as ServerExtensionAPI;
	const repositories = ["github.com", "git.company.test"].map((host) => ({
		id: 42,
		name: "repo",
		full_name: "team/repo",
		owner: { login: "team" },
		html_url: `https://${host}/team/repo`,
		ssh_url: `git@${host}:team/repo.git`,
		clone_url: `https://${host}/team/repo.git`,
		archived: false,
		has_issues: true,
	}));
	const request = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (url) =>
			Response.json([repositories[String(url).startsWith("https://api.github.com/") ? 0 : 1]]),
		);
	onTestFinished(() => request.mockRestore());
	await extension.setupServer?.(api, {
		profiles: {
			cloud: { token: "fixture" },
			enterprise: { api_base_url: "https://git.company.test/api/v3", token: "fixture" },
		},
	});
	if (!discover) throw new Error("Missing repository discovery");
	const found = await discover();
	expect(found.map((subject) => subject.identity)).toEqual(
		repositories.map((repo) => repositorySettingsIdentity(repo.html_url, repo.id)),
	);
	expect(new Set(found.map((subject) => subject.identity)).size).toBe(2);
	expect(found[1].aliases).toEqual([repositories[1].ssh_url, repositories[1].clone_url]);
});
