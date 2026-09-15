import { describe, expect, it } from "vitest";
import { forgejoIssueWatcherSource } from "./issue-watcher.js";

describe("forgejoIssueWatcherSource", () => {
	it("parses and presents extension-owned watcher configuration", () => {
		const parsed = forgejoIssueWatcherSource.parseConfig({
			enabled: true,
			profile: "primary",
			poll_interval: "30s",
			labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
			launch: {
				default_model_profile: "fast",
				turn_configs: { implement: { model_profile: "deep" } },
			},
		});

		expect(parsed).toEqual({
			config: {
				profile: "primary",
				pollInterval: "30s",
				repositories: { include: [], exclude: [] },
				labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
			},
			enabled: true,
			launchModelConfig: {
				defaultModelProfileId: "fast",
				skillIds: [],
				turnConfigs: { implement: { modelProfileId: "deep" } },
			},
		});
		expect(forgejoIssueWatcherSource.presentConfig(parsed.config)).toMatchObject({
			targetSummary: "Profile primary · trigger use-leitwerk",
		});
	});

	it("parses repository include and exclude filters", () => {
		const parsed = forgejoIssueWatcherSource.parseConfig({
			enabled: true,
			profile: "primary",
			poll_interval: "30s",
			repositories: {
				include: ["team/notebook"],
				exclude: ["leitwerk-dev/leitwerk"],
			},
			labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
		});

		expect(parsed.config.repositories).toEqual({
			include: ["team/notebook"],
			exclude: ["leitwerk-dev/leitwerk"],
		});
	});

	it("rejects incomplete and mismatched legacy configuration", () => {
		expect(() => forgejoIssueWatcherSource.parseConfig({ enabled: true })).toThrow("poll_interval");
		expect(() =>
			forgejoIssueWatcherSource.parseConfig({
				type: "another_source",
				enabled: true,
				profile: "primary",
				poll_interval: "30s",
				labels: { trigger: "ready", done: "done" },
			}),
		).toThrow("forgejo_issue");
		expect(() =>
			forgejoIssueWatcherSource.parseConfig({
				enabled: true,
				profile: "primary",
				poll_interval: "30s",
				repositories: { include: ["notebook"] },
				labels: { trigger: "ready", done: "done" },
			}),
		).toThrow("owner/name");
	});
});
