import path from "node:path";
import * as v from "valibot";

export const SESSION_TRANSFER_CONTENT_TYPE = "application/vnd.leitwerk.session-transfer+tar+zstd";

export const SESSION_TRANSFER_ATTEMPT_STATES = [
	"queued",
	"exporting",
	"awaiting_ack",
	"cancelled",
	"failed",
	"consumed",
] as const;
export type SessionTransferAttemptState = (typeof SESSION_TRANSFER_ATTEMPT_STATES)[number];

export const SESSION_TRANSFER_PHASES = [
	"queued",
	"waiting_for_execution_chain",
	"stopping_worker",
	"starting_exporter",
	"scanning",
	"ready_to_stream",
	"streaming",
	"awaiting_ack",
	"consumed",
	"cancelled",
	"failed",
] as const;
export type SessionTransferPhase = (typeof SESSION_TRANSFER_PHASES)[number];

/** Derives the public coarse status from the persisted lifecycle phase. */
export function sessionTransferAttemptStateForPhase(
	phase: SessionTransferPhase,
): SessionTransferAttemptState {
	switch (phase) {
		case "queued":
		case "waiting_for_execution_chain":
			return "queued";
		case "stopping_worker":
		case "starting_exporter":
		case "scanning":
		case "ready_to_stream":
		case "streaming":
			return "exporting";
		case "awaiting_ack":
		case "consumed":
		case "cancelled":
		case "failed":
			return phase;
		default:
			throw new Error(`Unknown session transfer phase: ${phase}`);
	}
}

export interface SessionTransferAttemptWire {
	id: string;
	grantId: string;
	instanceId: string;
	/** Derived from phase; it is not persisted in the server database. */
	state: SessionTransferAttemptState;
	phase: SessionTransferPhase;
	leaseUntil: string;
	hardDeadline: string;
	entriesTotal: number | null;
	logicalBytesTotal: number | null;
	compressedBytes: number | null;
	streamSha256: string | null;
	failureCode: string | null;
}

const nonBlankStringSchema = v.pipe(
	v.string(),
	v.check((value) => value.trim().length > 0, "Expected a non-empty string"),
);
const safeIntegerSchema = v.pipe(v.number(), v.safeInteger());
const positiveSafeIntegerSchema = v.pipe(safeIntegerSchema, v.minValue(1));
const nonNegativeSafeIntegerSchema = v.pipe(safeIntegerSchema, v.minValue(0));
const normalizedRelativePathSchema = v.pipe(
	nonBlankStringSchema,
	v.check((value) => {
		try {
			return assertSafeRelativePath(value) === value;
		} catch {
			return false;
		}
	}, "Expected a normalized relative path"),
);

export const sessionTransferLimitsSchema = v.object({
	maxEntries: positiveSafeIntegerSchema,
	maxLogicalBytes: positiveSafeIntegerSchema,
	maxCompressedBytes: positiveSafeIntegerSchema,
});
export type SessionTransferLimits = v.InferOutput<typeof sessionTransferLimitsSchema>;

export const DEFAULT_SESSION_TRANSFER_LIMITS: SessionTransferLimits = {
	maxEntries: 250_000,
	maxLogicalBytes: 20 * 1024 * 1024 * 1024,
	maxCompressedBytes: 10 * 1024 * 1024 * 1024,
};

export const leitwerkTransferManifestV1Schema = v.object({
	version: v.literal(1, "Unsupported transfer manifest version"),
	instanceId: nonBlankStringSchema,
	createdAt: v.pipe(
		nonBlankStringSchema,
		v.check((value) => Number.isFinite(Date.parse(value)), "Expected an ISO datetime"),
	),
	session: v.object({
		sourceCwd: nonBlankStringSchema,
		cwdRelativeToWorkspace: v.nullable(v.union([v.literal("."), normalizedRelativePathSchema])),
	}),
	projects: v.array(
		v.object({
			key: nonBlankStringSchema,
			relativePath: normalizedRelativePathSchema,
			branch: v.nullable(v.string()),
			head: v.nullable(v.string()),
		}),
	),
});
export type LeitwerkTransferManifestV1 = v.InferOutput<typeof leitwerkTransferManifestV1Schema>;

export const sessionTransferPreflightSchema = v.object({
	entriesTotal: v.pipe(nonNegativeSafeIntegerSchema, v.minValue(3)),
	logicalBytesTotal: nonNegativeSafeIntegerSchema,
});
export type SessionTransferPreflight = v.InferOutput<typeof sessionTransferPreflightSchema>;

export const sessionTransferPreflightReportSchema = v.object({
	manifest: leitwerkTransferManifestV1Schema,
	preflight: sessionTransferPreflightSchema,
});
export type SessionTransferPreflightReport = v.InferOutput<
	typeof sessionTransferPreflightReportSchema
>;

export interface TransferArchiveProgress {
	entriesProcessed: number;
	logicalBytesProcessed: number;
}

export const sessionTransferHelperSpecSchema = v.object({
	manifest: leitwerkTransferManifestV1Schema,
	limits: sessionTransferLimitsSchema,
});
export type SessionTransferHelperSpec = v.InferOutput<typeof sessionTransferHelperSpecSchema>;

export interface ParsedTransferLink {
	origin: string;
	instanceId: string;
	grantId: string;
	token: string;
	grantUrl: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

export function parsePiSessionHeader(content: string): Record<string, unknown> {
	const firstLine = content.split(/\r?\n/, 1)[0];
	if (!firstLine) throw new Error("Pi session is empty");
	const value = JSON.parse(firstLine) as unknown;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(value as Record<string, unknown>).type !== "session"
	) {
		throw new Error("Pi session header is invalid");
	}
	return value as Record<string, unknown>;
}

export function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}

export function assertSafeRelativePath(value: string, label = "path"): string {
	if (value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
		throw new Error(`${label} must be relative`);
	}
	const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
	if (normalized === ".." || normalized.startsWith("../") || normalized === ".") {
		throw new Error(`${label} escapes its root`);
	}
	return normalized;
}

export function parseTransferManifest(value: unknown): LeitwerkTransferManifestV1 {
	return v.parse(leitwerkTransferManifestV1Schema, value);
}

export function parseSessionTransferHelperSpec(value: unknown): SessionTransferHelperSpec {
	return v.parse(sessionTransferHelperSpecSchema, value);
}

const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

function decodeTransferId(value: string, label: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch (error) {
		throw new Error(`Transfer link has an invalid ${label}`, { cause: error });
	}
	// IDs are used to construct subsequent request paths. Reject encoded path
	// separators rather than allowing a single route parameter to become a
	// different path when it is re-encoded by the client.
	if (!TRANSFER_ID_PATTERN.test(decoded)) {
		throw new Error(`Transfer link has an invalid ${label}`);
	}
	return decoded;
}

export function parseTransferLink(raw: string): ParsedTransferLink {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error("Transfer link is not a valid URL");
	}
	const loopback =
		url.hostname === "127.0.0.1" ||
		url.hostname === "localhost" ||
		url.hostname === "::1" ||
		url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("Transfer links require HTTPS (HTTP is allowed only for loopback development)");
	}
	if (url.username || url.password || url.search)
		throw new Error("Transfer link contains unexpected URL credentials or query parameters");
	const match = /^\/api\/session-transfers\/([^/]+)\/([^/]+)$/.exec(url.pathname);
	if (!match) throw new Error("Transfer link has an unexpected path");
	const instanceId = decodeTransferId(match[1] as string, "instance id");
	const grantId = decodeTransferId(match[2] as string, "grant id");
	const token = new URLSearchParams(url.hash.slice(1)).get("token");
	if (!token || token.length < 32)
		throw new Error("Transfer link is missing its bearer token fragment");
	return {
		origin: url.origin,
		instanceId,
		grantId,
		token,
		grantUrl: `${url.origin}/api/session-transfers/${encodeURIComponent(instanceId)}/${encodeURIComponent(grantId)}`,
	};
}

export interface RewrittenPiSession {
	content: string;
	header: Record<string, unknown>;
	entryCount: number;
}

export function rewritePiSession(
	content: string,
	localCwd: string,
	expectedSourceCwd?: string,
): RewrittenPiSession {
	const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
	if (lines.length === 0) throw new Error("Transferred Pi session is empty");
	const parsed = lines.map((line, index) => {
		try {
			return object(JSON.parse(line), `session line ${index + 1}`);
		} catch (error) {
			if (error instanceof SyntaxError)
				throw new Error(`Session line ${index + 1} is not valid JSON`, { cause: error });
			throw error;
		}
	});
	const sourceHeader = parsePiSessionHeader(content);
	if (sourceHeader.version !== 3) {
		throw new Error("unsupported_pi_session_version");
	}
	string(sourceHeader.id, "session header.id");
	const sourceCwd = string(sourceHeader.cwd, "session header.cwd");
	if (!path.isAbsolute(sourceCwd)) throw new Error("Transferred session cwd must be absolute");
	if (expectedSourceCwd !== undefined && sourceCwd !== expectedSourceCwd) {
		throw new Error("Transferred session cwd does not match the transfer manifest");
	}
	const timestamp = string(sourceHeader.timestamp, "session header.timestamp");
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
		!Number.isFinite(Date.parse(timestamp))
	) {
		throw new Error("Transferred session timestamp must be an ISO datetime");
	}

	const ids = new Set<string>();
	for (let index = 1; index < parsed.length; index += 1) {
		const entry = parsed[index] as Record<string, unknown>;
		if (entry.type === "session") throw new Error("Transferred session contains a second header");
		string(entry.type, `session line ${index + 1}.type`);
		const id = string(entry.id, `session line ${index + 1}.id`);
		if (ids.has(id)) throw new Error(`Transferred session contains duplicate entry id '${id}'`);
		const parentId = entry.parentId;
		if (parentId !== null && (typeof parentId !== "string" || !ids.has(parentId))) {
			throw new Error(`Transferred session entry '${id}' has an invalid parent`);
		}
		ids.add(id);
	}
	const { parentSession: _parentSession, ...rest } = sourceHeader;
	const header = { ...rest, cwd: path.resolve(localCwd) };
	return {
		content: `${[header, ...parsed.slice(1)].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		header,
		entryCount: parsed.length - 1,
	};
}
