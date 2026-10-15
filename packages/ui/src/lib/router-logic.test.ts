import { describe, expect, it } from "vitest";
import {
	buildAvailableSkillPath,
	buildCreateProcessPath,
	buildFutureLaunchPath,
	buildHomePath,
	buildInstalledSkillPath,
	buildProcessesPath,
	buildProcessPath,
	buildSkillsPath,
	buildWatchersPath,
	canonicalizeRoutePath,
	matchRoute,
} from "./router-logic.js";

describe("matchRoute", () => {
	it("canonicalizes legacy launcher URLs", () => {
		expect(canonicalizeRoutePath("/?launcher=a%20b#setup")).toBe("/processes/new?launcher=a+b");
		expect(canonicalizeRoutePath("/config")).toBe("/processes/new");
		expect(canonicalizeRoutePath("/system?launcher=abc")).toBe("/processes/new?launcher=abc");
		expect(canonicalizeRoutePath("/")).toBe("/");
		expect(canonicalizeRoutePath("/processes/new?launcher=abc")).toBe(
			"/processes/new?launcher=abc",
		);
	});
	it.each([
		["/processes/new", "home", {}],
		["/processes/new/?launcher=a%20b", "home", { launcher: "a b" }],
		["/", "dashboard", {}],
		["/#?launcher=not-a-query", "dashboard", {}],
		["/?launcher=launcher-a", "home", { launcher: "launcher-a" }],
		["/?launcher=launcher%20with%20space#setup", "home", { launcher: "launcher with space" }],
		["/processes", "processes", {}],
		["/processes/", "processes", {}],
		["/processes/agt_abc123", "process-detail", { instanceId: "agt_abc123" }],
		["/future-launches/fut_abc123", "future-launch-detail", { futureExecutionId: "fut_abc123" }],
		[
			"/future-launches/fut_with%20space?tab=detail#top",
			"future-launch-detail",
			{ futureExecutionId: "fut_with space" },
		],
		["/processes/agt_abc123?overlay=process-info", "process-detail", { instanceId: "agt_abc123" }],
		[
			"/processes/agt_abc123?overlay=reasoning&turnRecordId=trn_1#trace",
			"process-detail",
			{ instanceId: "agt_abc123" },
		],
		["/processes/agt_with%20space", "process-detail", { instanceId: "agt_with space" }],
		["/config", "home", {}],
		["/system", "home", {}],
		["/skills", "skills", {}],
		[
			"/skills/available/shared/code%20review",
			"skills",
			{ detailKind: "available", repositoryId: "shared", skillId: "code review" },
		],
		[
			"/skills/installed/code%20review",
			"skills",
			{ detailKind: "installed", skillId: "code review" },
		],
		["/watchers", "watchers", {}],
		["/watchers/", "watchers", {}],
		["/watchers?tab=configured#top", "watchers", {}],
		["/unknown", "dashboard", {}],
		["/foo/bar", "dashboard", {}],
		["/processes/agt_123/extra", "process-detail", { instanceId: "agt_123" }],
	] as const)("matches %s to %s", (path, page, params) => {
		expect(matchRoute(path)).toEqual({ page, params });
	});
});

describe("route path builders", () => {
	it("builds canonical home and process detail paths", () => {
		expect(buildHomePath()).toBe("/");
		expect(buildCreateProcessPath()).toBe("/processes/new");
		expect(buildCreateProcessPath("launcher-a")).toBe("/processes/new?launcher=launcher-a");
		expect(buildCreateProcessPath("launcher with space")).toBe(
			"/processes/new?launcher=launcher+with+space",
		);
		expect(buildWatchersPath()).toBe("/watchers");
		expect(buildProcessesPath()).toBe("/processes");
		expect(buildSkillsPath()).toBe("/skills");
		expect(buildAvailableSkillPath("shared", "code review")).toBe(
			"/skills/available/shared/code%20review",
		);
		expect(buildInstalledSkillPath("code review")).toBe("/skills/installed/code%20review");
		expect(buildFutureLaunchPath("fut_1")).toBe("/future-launches/fut_1");
		expect(buildFutureLaunchPath("fut with space")).toBe("/future-launches/fut%20with%20space");
		expect(buildProcessPath("agt_1")).toBe("/processes/agt_1");
		expect(buildProcessPath("agt with space")).toBe("/processes/agt%20with%20space");
	});
});
