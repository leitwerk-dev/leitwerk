import { expect, it } from "vitest";
import { epicSplitSource } from "./index.js";

const config = {
	enabled: true,
	jiraProfile: "team",
	gitlabProfile: "team",
	sshProfile: "team",
	jiraProjects: ["100"],
	groups: "team, platform/shared",
	excludeProjects: "team/legacy",
};

it("requires explicit valid repository scope and Jira project IDs at configuration time", () => {
	expect(epicSplitSource.parseConfig(config)).toEqual({
		enabled: true,
		config: { ...config, pollInterval: "30s" },
	});
	for (const invalid of [
		{ groups: "" },
		{ groups: ["team"] },
		{ excludeProjects: "team/*" },
		{ jiraProjects: ["APP"] },
		{ labels: ["use-leitwerk"] },
		{ labels: "leitwerk-epic-split" },
		{ issueType: "Bug" },
		{ pollInterval: "0s" },
	])
		expect(() => epicSplitSource.parseConfig({ ...config, ...invalid })).toThrow();
});
