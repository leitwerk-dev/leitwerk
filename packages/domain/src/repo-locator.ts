export type RepoLocatorKind = "remote_url" | "local_path";

export interface ParsedRepoLocator {
	kind: RepoLocatorKind;
	value: string;
}

function isFileUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "file:") {
			return false;
		}
		return (
			(url.hostname === "" || url.hostname === "localhost") &&
			url.pathname.startsWith("/") &&
			decodeURIComponent(url.pathname).length > 1
		);
	} catch {
		return false;
	}
}

function isLocalFilesystemPath(value: string): boolean {
	return (
		value.startsWith("/") ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.startsWith("~/") ||
		isFileUrl(value)
	);
}

const scpLikeGitUrlPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+:[^\s]+$/;
const explicitRemoteGitUrlPattern = /^(?:https?|ssh|git):\/\//;

function hasRepositoryPath(pathname: string): boolean {
	return pathname.split("/").filter(Boolean).length >= 1;
}

function isRemoteGitUrl(value: string): boolean {
	if (scpLikeGitUrlPattern.test(value)) {
		const path = value.slice(value.indexOf(":") + 1);
		return hasRepositoryPath(path);
	}
	if (!explicitRemoteGitUrlPattern.test(value)) {
		return false;
	}
	try {
		const url = new URL(value);
		return (
			["http:", "https:", "ssh:", "git:"].includes(url.protocol) &&
			!!url.hostname &&
			hasRepositoryPath(url.pathname)
		);
	} catch {
		return false;
	}
}

export function detectRepoLocatorKind(value: string): RepoLocatorKind | null {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}
	if (isLocalFilesystemPath(trimmed)) {
		return "local_path";
	}
	if (isRemoteGitUrl(trimmed)) {
		return "remote_url";
	}
	return null;
}

export function parseRepoLocator(value: unknown): ParsedRepoLocator | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	const kind = detectRepoLocatorKind(trimmed);
	if (!kind) {
		return null;
	}
	return { kind, value: trimmed };
}

export function isRepoLocator(value: unknown): value is string {
	return parseRepoLocator(value) !== null;
}

export function assertRepoLocator(value: unknown, fieldName = "repoLocator"): string {
	const parsed = parseRepoLocator(value);
	if (!parsed) {
		throw new Error(`${fieldName} must be a remote URL or local filesystem path`);
	}
	return parsed.value;
}
