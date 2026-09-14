import { resolveForgejoProjectBinding } from "@leitwerk-dev/forgejo";
import { resolveGitHubProjectBinding } from "@leitwerk-dev/github";
import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { resolveWoodpeckerProjectBinding } from "@leitwerk-dev/woodpecker";
import { describe, expect, it } from "vitest";

function ctx(metadata: unknown, params: unknown = {}) {
	return {
		process: { id: "process", paramsJson: JSON.stringify(params) },
		project: { id: "project", instanceId: "process", metadata },
	} as IntegrationToolExecutionContext;
}
for (const [provider, resolve] of [
	["forgejo", resolveForgejoProjectBinding],
	["github", resolveGitHubProjectBinding],
	["woodpecker", resolveWoodpeckerProjectBinding],
] as const) {
	describe(`${provider} project binding`, () => {
		const params = { [`${provider}Profile`]: "legacy" };
		const metadata = (profile: string) => ({
			[provider]: { owner: "team", repo: profile, profile },
		});
		it("uses each project's own profile without reading unrelated parameters", () => {
			for (const profile of ["first", "second"])
				expect(resolve(ctx(metadata(profile), params))).toEqual({
					owner: "team",
					repo: profile,
					profile,
				});
			const context = ctx(metadata("explicit"));
			context.process.paramsJson = "old opaque params";
			expect(resolve(context).profile).toBe("explicit");
		});
		it("retains stored legacy binding shapes", () => {
			const key = provider === "woodpecker" ? "forgejo" : provider;
			expect(resolve(ctx({ [key]: { owner: "team", repo: "repo" } }, params))).toEqual({
				owner: "team",
				repo: "repo",
				profile: "legacy",
			});
			if (provider === "woodpecker") {
				expect(
					resolve(ctx({ forgejo: { owner: "team", repo: "repo", profile: "not-ci" } }, params))
						.profile,
				).toBe("legacy");
				expect(() =>
					resolve(ctx({ woodpecker: { owner: "team", repo: "repo" } }, params)),
				).toThrow();
			}
		});
		it("rejects missing and foreign projects", () => {
			const context = ctx(metadata("one"));
			if (context.project) context.project.instanceId = "other";
			expect(() => resolve(context)).toThrow("authorized");
			expect(() => resolve({ ...context, project: null })).toThrow("authorized");
		});
		it.each([
			null,
			[],
			{ owner: "team", repo: "repo", profile: "" },
			{ owner: "", repo: "repo", profile: "one" },
		])("rejects malformed explicit metadata instead of falling back", (binding) => {
			expect(() => resolve(ctx({ [provider]: binding }, params))).toThrow();
		});
	});
}
