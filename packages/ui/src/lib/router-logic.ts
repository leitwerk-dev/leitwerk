export type Page =
	| "wiki"
	| "settings"
	| "api-tokens"
	| "home"
	| "processes"
	| "process-detail"
	| "future-launch-detail"
	| "watchers"
	| "skills";

export interface Route {
	page: Page;
	params: Record<string, string>;
}

function stripSearchAndHash(path: string): string {
	return path.split(/[?#]/, 1)[0];
}

function readSearchParams(path: string): URLSearchParams {
	return new URL(path, "http://localhost").searchParams;
}

function decodeFirstSegment(pathname: string, prefix: string): string {
	const segment = pathname.slice(prefix.length).split("/")[0];
	return segment ? decodeURIComponent(segment) : "";
}

export function buildHomePath(launcherId?: string | null): string {
	if (!launcherId) {
		return "/";
	}
	const params = new URLSearchParams();
	params.set("launcher", launcherId);
	return `/?${params.toString()}`;
}

export function buildFutureLaunchPath(futureExecutionId: string): string {
	return `/future-launches/${encodeURIComponent(futureExecutionId)}`;
}

export function buildProcessesPath(): string {
	return "/processes";
}

export function buildProcessPath(instanceId: string): string {
	return `/processes/${encodeURIComponent(instanceId)}`;
}

export function buildWatchersPath(): string {
	return "/watchers";
}

export function buildSkillsPath(): string {
	return "/skills";
}

export function buildAvailableSkillPath(repositoryId: string, skillId: string): string {
	return `/skills/available/${encodeURIComponent(repositoryId)}/${encodeURIComponent(skillId)}`;
}

export function buildInstalledSkillPath(skillId: string): string {
	return `/skills/installed/${encodeURIComponent(skillId)}`;
}

function matchPrefixedDetailRoute(
	pathname: string,
	prefix: string,
	page: "process-detail" | "future-launch-detail",
	paramName: "instanceId" | "futureExecutionId",
): Route | null {
	if (!pathname.startsWith(prefix)) {
		return null;
	}

	const id = decodeFirstSegment(pathname, prefix);
	if (!id) {
		return null;
	}

	return { page, params: { [paramName]: id } };
}

export function matchRoute(pathnameWithSearch: string): Route {
	const pathname = stripSearchAndHash(pathnameWithSearch);
	if (pathname === "/wiki" || pathname.startsWith("/wiki/")) {
		const segments = pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
		return { page: "wiki", params: { topicId: segments[0] ?? "", pageId: segments[1] ?? "" } };
	}
	if (pathname === "/settings" || pathname === "/settings/")
		return {
			page: "settings",
			params: { scope: readSearchParams(pathnameWithSearch).get("scope") ?? "instance" },
		};
	if (pathname === "/account/api-tokens" || pathname === "/account/api-tokens/")
		return { page: "api-tokens", params: {} };
	const processDetailRoute = matchPrefixedDetailRoute(
		pathname,
		"/processes/",
		"process-detail",
		"instanceId",
	);
	if (processDetailRoute) {
		return processDetailRoute;
	}

	const futureLaunchDetailRoute = matchPrefixedDetailRoute(
		pathname,
		"/future-launches/",
		"future-launch-detail",
		"futureExecutionId",
	);
	if (futureLaunchDetailRoute) {
		return futureLaunchDetailRoute;
	}

	if (pathname.startsWith("/skills/available/")) {
		const segments = pathname.slice("/skills/available/".length).split("/").filter(Boolean);
		if (segments.length >= 2) {
			return {
				page: "skills",
				params: {
					detailKind: "available",
					repositoryId: decodeURIComponent(segments[0] ?? ""),
					skillId: decodeURIComponent(segments[1] ?? ""),
				},
			};
		}
	}

	if (pathname.startsWith("/skills/installed/")) {
		const skillId = pathname.slice("/skills/installed/".length).split("/").filter(Boolean)[0];
		if (skillId) {
			return {
				page: "skills",
				params: { detailKind: "installed", skillId: decodeURIComponent(skillId) },
			};
		}
	}

	if (pathname === "/skills" || pathname === "/skills/") {
		return { page: "skills", params: {} };
	}

	if (pathname === "/watchers" || pathname === "/watchers/") {
		return { page: "watchers", params: {} };
	}

	if (pathname === "/processes" || pathname === "/processes/") {
		return { page: "processes", params: {} };
	}

	if (pathname === "/" || pathname === "/config" || pathname === "/system") {
		const launcher = readSearchParams(pathnameWithSearch).get("launcher");
		return launcher ? { page: "home", params: { launcher } } : { page: "home", params: {} };
	}

	return { page: "home", params: {} };
}

/** @internal */
export const inspectorProcessSections = [
	["overview", "Overview"],
	["workflow", "Workflow"],
	["inputs", "Inputs & configuration"],
	["context-map", "Context map"],
] as const;
/** @internal */
export const inspectorExecutionSections = [
	["trace", "Trace"],
	["context", "Context"],
	["configuration", "Configuration"],
] as const;
export type InspectorProcessSection = (typeof inspectorProcessSections)[number][0];
export type InspectorExecutionSection = (typeof inspectorExecutionSections)[number][0];
export type InspectorTarget =
	| { scope: "process"; section: InspectorProcessSection; turnRecordId?: string }
	| { scope: "step"; turnId: string }
	| {
			scope: "execution";
			turnRecordId: string;
			section: InspectorExecutionSection;
			entryId?: string;
			itemId?: string;
			boundaryFor?: string;
	  };
export type InspectorRoute = InspectorTarget | { scope: "invalid"; reason: string } | null;

export function buildInspectorPath(instanceId: string, target: InspectorTarget): string {
	const params = new URLSearchParams({ inspect: target.scope });
	if (target.scope === "step") params.set("turnId", target.turnId);
	else {
		params.set("section", target.section);
		if (target.turnRecordId) params.set("turnRecordId", target.turnRecordId);
		if (target.scope === "execution") {
			if (target.entryId) params.set("entryId", target.entryId);
			if (target.itemId) params.set("itemId", target.itemId);
			if (target.boundaryFor) params.set("boundaryFor", target.boundaryFor);
		}
	}
	return `${buildProcessPath(instanceId)}?${params}`;
}

export function readInspectorTarget(path: string): InspectorRoute {
	const params = readSearchParams(path);
	let scope = params.get("inspect");
	if (!scope && params.get("overlay") === "process-info") scope = "process";
	if (!scope && params.get("overlay") === "reasoning") scope = "execution";
	if (!scope) return null;
	const invalid = {
		scope: "invalid",
		reason: "This inspector link has a missing or unsupported target.",
	} as const;
	const section = params.get("section");
	const turnRecordId = params.get("turnRecordId") || undefined;
	if (scope === "step") {
		const turnId = params.get("turnId");
		return turnId ? { scope, turnId } : invalid;
	}
	if (scope === "process") {
		if (section && !inspectorProcessSections.some(([id]) => id === section)) return invalid;
		return {
			scope,
			section: (section ?? "overview") as InspectorProcessSection,
			...(turnRecordId ? { turnRecordId } : {}),
		};
	}
	if (scope === "execution" && turnRecordId) {
		if (section && !inspectorExecutionSections.some(([id]) => id === section)) return invalid;
		const target: InspectorTarget = {
			scope,
			turnRecordId,
			section: (section ?? "trace") as InspectorExecutionSection,
		};
		for (const key of ["entryId", "itemId", "boundaryFor"] as const) {
			const value = params.get(key);
			if (value) target[key] = value;
		}
		return target;
	}
	return invalid;
}
