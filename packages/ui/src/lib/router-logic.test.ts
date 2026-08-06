import { describe, expect, it } from "vitest";
import {
	buildAvailableSkillPath,
	buildFutureLaunchPath,
	buildHomePath,
	buildInstalledSkillPath,
	buildProcessesPath,
	buildProcessPath,
	buildSkillsPath,
	buildWatchersPath,
	matchRoute,
	readProcessDetailOverlay,
} from "./router-logic.js";

describe("matchRoute", () => {
	it("matches root path to the home page", () => {
		expect(matchRoute("/")).toEqual({ page: "home", params: {} });
	});

	it("reads a home launcher query parameter", () => {
		expect(matchRoute("/?launcher=launcher-a")).toEqual({
			page: "home",
			params: { launcher: "launcher-a" },
		});
		expect(matchRoute("/?launcher=launcher%20with%20space#setup")).toEqual({
			page: "home",
			params: { launcher: "launcher with space" },
		});
	});

	it("matches /processes to the all processes page", () => {
		expect(matchRoute("/processes")).toEqual({ page: "processes", params: {} });
		expect(matchRoute("/processes/")).toEqual({ page: "processes", params: {} });
	});

	it("matches /processes/:id to the process detail page", () => {
		expect(matchRoute("/processes/agt_abc123")).toEqual({
			page: "process-detail",
			params: { instanceId: "agt_abc123" },
		});
	});

	it("matches scheduled launch detail routes", () => {
		expect(matchRoute("/future-launches/fut_abc123")).toEqual({
			page: "future-launch-detail",
			params: { futureExecutionId: "fut_abc123" },
		});
		expect(matchRoute("/future-launches/fut_with%20space?tab=detail#top")).toEqual({
			page: "future-launch-detail",
			params: { futureExecutionId: "fut_with space" },
		});
	});

	it("matches process detail routes with query strings and hashes", () => {
		expect(matchRoute("/processes/agt_abc123?overlay=process-info")).toEqual({
			page: "process-detail",
			params: { instanceId: "agt_abc123" },
		});
		expect(matchRoute("/processes/agt_abc123?overlay=reasoning&turnRecordId=trn_1#trace")).toEqual({
			page: "process-detail",
			params: { instanceId: "agt_abc123" },
		});
	});

	it("decodes URI-encoded process IDs for canonical detail routes", () => {
		expect(matchRoute("/processes/agt_with%20space")).toEqual({
			page: "process-detail",
			params: { instanceId: "agt_with space" },
		});
	});

	it("routes utility urls to the default home page", () => {
		expect(matchRoute("/config")).toEqual({ page: "home", params: {} });
		expect(matchRoute("/system")).toEqual({ page: "home", params: {} });
	});

	it("matches the skill catalog and addressable remote and installed details", () => {
		expect(matchRoute("/skills")).toEqual({ page: "skills", params: {} });
		expect(matchRoute("/skills/available/shared/code%20review")).toEqual({
			page: "skills",
			params: {
				detailKind: "available",
				repositoryId: "shared",
				skillId: "code review",
			},
		});
		expect(matchRoute("/skills/installed/code%20review")).toEqual({
			page: "skills",
			params: { detailKind: "installed", skillId: "code review" },
		});
	});

	it("matches /watchers to the watchers page", () => {
		expect(matchRoute("/watchers")).toEqual({ page: "watchers", params: {} });
		expect(matchRoute("/watchers/")).toEqual({ page: "watchers", params: {} });
		expect(matchRoute("/watchers?tab=configured#top")).toEqual({ page: "watchers", params: {} });
	});

	it("falls back to home for unknown paths", () => {
		expect(matchRoute("/unknown")).toEqual({ page: "home", params: {} });
		expect(matchRoute("/foo/bar")).toEqual({ page: "home", params: {} });
	});

	it("extracts only the first segment for process ID, ignoring trailing path", () => {
		expect(matchRoute("/processes/agt_123/extra")).toEqual({
			page: "process-detail",
			params: { instanceId: "agt_123" },
		});
	});
});

describe("route path builders", () => {
	it("builds canonical home and process detail paths", () => {
		expect(buildHomePath()).toBe("/");
		expect(buildHomePath("launcher-a")).toBe("/?launcher=launcher-a");
		expect(buildHomePath("launcher with space")).toBe("/?launcher=launcher+with+space");
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

	it("builds process detail overlay paths", () => {
		expect(buildProcessPath("agt_1", { overlay: "process-info" })).toBe(
			"/processes/agt_1?overlay=process-info",
		);
		expect(buildProcessPath("agt_1", { overlay: "reasoning", turnRecordId: "trn_2" })).toBe(
			"/processes/agt_1?overlay=reasoning&turnRecordId=trn_2",
		);
		expect(buildProcessPath("agt with space", { overlay: "reasoning" })).toBe(
			"/processes/agt%20with%20space?overlay=reasoning",
		);
	});
});

describe("readProcessDetailOverlay", () => {
	it("parses process detail overlay query parameters", () => {
		expect(readProcessDetailOverlay("/processes/agt_1")).toEqual({ kind: "none" });
		expect(readProcessDetailOverlay("/processes/agt_1?overlay=process-info")).toEqual({
			kind: "process-info",
		});
		expect(
			readProcessDetailOverlay("/processes/agt_1?overlay=reasoning&turnRecordId=trn_2"),
		).toEqual({ kind: "reasoning", turnRecordId: "trn_2" });
		expect(readProcessDetailOverlay("/processes/agt_1?overlay=reasoning#trace")).toEqual({
			kind: "reasoning",
			turnRecordId: null,
		});
		expect(readProcessDetailOverlay("/processes/agt_1?overlay=unknown")).toEqual({
			kind: "none",
		});
	});
});
