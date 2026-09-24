import { expect, it } from "vitest";
import { resolveWoodpeckerProjectBinding } from "./binding.js";

it.each([
	[{ forgejo: { owner: "team", repo: "service" } }, "retained-ci"],
	[{ forgejo: { owner: "team", repo: "service", profile: "forge-only" } }, "retained-ci"],
	[{ woodpecker: { owner: "team", repo: "service", profile: "pinned-ci" } }, "pinned-ci"],
] as const)("resolves retained metadata %j using %s", (metadata, profile) => {
	expect(
		resolveWoodpeckerProjectBinding({
			process: {
				id: "process",
				paramsJson: JSON.stringify({
					woodpeckerProfile: "retained-ci",
					forgejoProfile: "forge-only",
				}),
			},
			project: { instanceId: "process", metadata },
		} as never),
	).toEqual({ owner: "team", repo: "service", profile });
});

it("rejects an incomplete dedicated binding rather than silently using legacy metadata", () => {
	expect(() =>
		resolveWoodpeckerProjectBinding({
			process: { id: "process", paramsJson: JSON.stringify({ woodpeckerProfile: "retained-ci" }) },
			project: {
				instanceId: "process",
				metadata: {
					woodpecker: { owner: "team", repo: "service" },
					forgejo: { owner: "team", repo: "service" },
				},
			},
		} as never),
	).toThrow(/profile/);
});
