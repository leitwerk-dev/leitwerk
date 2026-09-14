import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { resolveForgejoProjectBinding as resolve } from "./binding.js";

function ctx(metadata: unknown, params: unknown = {}) {
	return {
		process: { id: "process", paramsJson: JSON.stringify(params) },
		project: { id: "project", instanceId: "process", metadata },
	} as IntegrationToolExecutionContext;
}
describe("forgejo project binding", () => {
	it("uses each project's own profile without reading unrelated parameters", () => {
		for (const profile of ["first", "second"])
			expect(
				resolve(
					ctx({ forgejo: { owner: "team", repo: profile, profile } }, { forgejoProfile: "wrong" }),
				),
			).toEqual({ owner: "team", repo: profile, profile });
		const context = ctx({ forgejo: { owner: "team", repo: "repo", profile: "explicit" } });
		context.process.paramsJson = "old opaque params";
		expect(resolve(context).profile).toBe("explicit");
	});
	it("retains stored legacy binding shapes", () => {
		expect(
			resolve(ctx({ forgejo: { owner: "team", repo: "repo" } }, { forgejoProfile: "legacy" })),
		).toEqual({ owner: "team", repo: "repo", profile: "legacy" });
	});
	it("rejects missing and foreign projects", () => {
		const context = ctx({ forgejo: { owner: "team", repo: "repo", profile: "one" } });
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
		expect(() => resolve(ctx({ forgejo: binding }, { forgejoProfile: "legacy" }))).toThrow();
	});
});
