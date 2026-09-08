export type Page =
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

export type ProcessDetailOverlayState =
	| { kind: "none" }
	| { kind: "process-info" }
	| { kind: "reasoning"; turnRecordId: string | null };

export interface ProcessPathOptions {
	overlay?: "process-info" | "reasoning" | null;
	turnRecordId?: string | null;
}

function stripSearchAndHash(path: string): string {
	const searchIndex = path.indexOf("?");
	const hashIndex = path.indexOf("#");
	const endIndexes = [searchIndex, hashIndex].filter((index) => index >= 0);
	const endIndex = endIndexes.length > 0 ? Math.min(...endIndexes) : path.length;
	return path.slice(0, endIndex);
}

function readSearchParams(path: string): URLSearchParams {
	const searchIndex = path.indexOf("?");
	if (searchIndex < 0) {
		return new URLSearchParams();
	}
	const hashIndex = path.indexOf("#", searchIndex);
	const search = path.slice(searchIndex + 1, hashIndex >= 0 ? hashIndex : path.length);
	return new URLSearchParams(search);
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

export function buildProcessPath(instanceId: string, options: ProcessPathOptions = {}): string {
	const path = `/processes/${encodeURIComponent(instanceId)}`;
	const params = new URLSearchParams();
	if (options.overlay === "process-info") {
		params.set("overlay", "process-info");
	} else if (options.overlay === "reasoning") {
		params.set("overlay", "reasoning");
		if (options.turnRecordId) {
			params.set("turnRecordId", options.turnRecordId);
		}
	}
	const query = params.toString();
	return query ? `${path}?${query}` : path;
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

export function readProcessDetailOverlay(path: string): ProcessDetailOverlayState {
	const params = readSearchParams(path);
	const overlay = params.get("overlay");
	if (overlay === "process-info") {
		return { kind: "process-info" };
	}
	if (overlay === "reasoning") {
		return { kind: "reasoning", turnRecordId: params.get("turnRecordId") };
	}
	return { kind: "none" };
}

function matchPrefixedDetailRoute(
	pathnameWithSearch: string,
	prefix: string,
	page: "process-detail" | "future-launch-detail",
	paramName: "instanceId" | "futureExecutionId",
): Route | null {
	const pathname = stripSearchAndHash(pathnameWithSearch);
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
	if (pathname === "/account/api-tokens" || pathname === "/account/api-tokens/")
		return { page: "api-tokens", params: {} };
	const processDetailRoute = matchPrefixedDetailRoute(
		pathnameWithSearch,
		"/processes/",
		"process-detail",
		"instanceId",
	);
	if (processDetailRoute) {
		return processDetailRoute;
	}

	const futureLaunchDetailRoute = matchPrefixedDetailRoute(
		pathnameWithSearch,
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
