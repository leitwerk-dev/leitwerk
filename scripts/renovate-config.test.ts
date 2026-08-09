import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(`${repoRoot}/renovate.json`, "utf8"));

describe("Renovate configuration", () => {
	it("uses best practices, immutable pins, weekly maintenance, and DCO", () => {
		expect(config.extends).toEqual(
			expect.arrayContaining(["config:best-practices", ":gitSignOff"]),
		);
		expect(config.dependencyDashboard).toBe(true);
		expect(config.semanticCommits).toBe("enabled");
		expect(config.lockFileMaintenance).toMatchObject({
			enabled: true,
			automerge: true,
			minimumReleaseAge: "7 days",
		});
		expect(config.major).toMatchObject({
			dependencyDashboardApproval: true,
			automerge: false,
		});
		expect(config.vulnerabilityAlerts).toMatchObject({
			enabled: true,
			prCreation: "immediate",
		});
	});

	it("assigns release-producing Conventional Commit types by dependency class", () => {
		const rules = config.packageRules as Array<Record<string, unknown>>;
		const runtime = rules.find((rule) => rule.groupName === "runtime npm dependencies");
		const development = rules.find((rule) => rule.groupName === "development tooling");
		const actions = rules.find((rule) => rule.groupName === "CI actions");
		const containers = rules.find((rule) => rule.groupName === "container and Helm dependencies");
		expect(runtime?.semanticCommitType).toBe("fix");
		expect(containers?.semanticCommitType).toBe("fix");
		expect(development?.semanticCommitType).toBe("chore");
		expect(actions?.semanticCommitType).toBe("ci");
	});

	it("excludes lockstep artifacts owned by Release Please", () => {
		const exclusion = (config.packageRules as Array<Record<string, unknown>>).find(
			(rule) => rule.enabled === false,
		);
		expect(exclusion?.matchPackageNames).toEqual(
			expect.arrayContaining(["@leitwerk-dev/**", "ghcr.io/leitwerk-dev/leitwerk-**"]),
		);
	});
});
