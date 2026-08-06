import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
	copyFile,
	type FileHandle,
	mkdir,
	open,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { atomicWriteUtf8, isEnoent } from "@leitwerk-dev/process-sdk";
import {
	createEmptyParsedInstanceTree,
	deriveParsedInstanceTree,
	type ParsedInstanceTree,
} from "./instance-tree.js";
import {
	createEmptyReadonlyPiSessionTree,
	parsePiSessionTreeContent,
	type ReadonlyPiSessionTree,
} from "./pi-session-tree.js";

/**
 * A handle to a process session payload that exposes a change `signature`
 * before the reader pays the cost of parsing the full content.
 *
 * The two-step shape lets the reader skip re-parsing whenever the signature is
 * unchanged. Sources may capture content while producing a handle so its
 * signature and payload come from the same storage generation.
 */
export interface ProcessSessionSnapshotHandle {
	/** Opaque value that changes whenever the underlying session content changes. */
	signature: string;
	/** Loads the raw session JSONL content captured by this handle. */
	load(): Promise<string>;
}

/**
 * Provides raw process session content without committing the server to a
 * particular storage location.
 *
 * Production read models use a server-owned latest-snapshot store fed by the
 * worker session-snapshot HTTP exchange. The store may be file-backed, but it
 * represents the server copy of the session JSONL rather than a requirement to
 * mount or inspect worker volumes.
 */
export interface ProcessSessionSource {
	/** Returns a handle for the instance, or `null` when no session exists yet. */
	readSnapshotHandle(instanceId: string): Promise<ProcessSessionSnapshotHandle | null>;
}

export interface WriteProcessSessionSnapshotResult {
	bytes: number;
}

export interface ProcessSessionSnapshotStore extends ProcessSessionSource {
	/** Replaces the server's latest snapshot for this instance. */
	writeSnapshot(instanceId: string, content: string): Promise<WriteProcessSessionSnapshotResult>;
	/** Atomically replaces the server's latest snapshot with content from an existing file. */
	writeSnapshotFile(
		instanceId: string,
		contentPath: string,
	): Promise<WriteProcessSessionSnapshotResult>;
	/** Reads the raw latest snapshot, or `null` when no snapshot has been stored. */
	readRawSnapshot(instanceId: string): Promise<string | null>;
	/** Idempotently deletes the server-owned latest snapshot for this instance. */
	deleteSnapshot(instanceId: string): Promise<void>;
}

interface CachedSessionTree {
	signature: string;
	piTree: ReadonlyPiSessionTree;
	parsedTree: ParsedInstanceTree;
}

export interface ProcessSessionTreeReadResult {
	signature: string | null;
	piTree: ReadonlyPiSessionTree;
	parsedTree: ParsedInstanceTree;
}

/**
 * Reads and caches parsed process session state from a {@link ProcessSessionSource}.
 *
 * All server read paths (primary-path snapshots, diagnostics, leaf-outcome
 * capture and failed-turn continuation) go through this seam so
 * the server never reads worker filesystems directly.
 */
export class ProcessSessionReader {
	private readonly sessionTreeCache = new Map<string, CachedSessionTree>();
	private readonly inFlightReads = new Map<string, Promise<CachedSessionTree>>();

	constructor(private readonly source: ProcessSessionSource) {}

	async readSessionTree(instanceId: string): Promise<ProcessSessionTreeReadResult> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const handle = await this.source.readSnapshotHandle(instanceId);
			if (!handle) {
				this.sessionTreeCache.delete(instanceId);
				return {
					signature: null,
					piTree: createEmptyReadonlyPiSessionTree(instanceId),
					parsedTree: createEmptyParsedInstanceTree(),
				};
			}
			try {
				const cached = await this.readCachedSessionTree(instanceId, handle);
				return {
					signature: cached.signature,
					piTree: cached.piTree,
					parsedTree: cached.parsedTree,
				};
			} catch (error) {
				if (!(error instanceof ProcessSessionSnapshotChangedError) || attempt === 2) {
					throw error;
				}
			}
		}
		throw new Error(`Unable to read process session snapshot '${instanceId}'`);
	}

	async readInstanceTree(instanceId: string): Promise<ParsedInstanceTree> {
		return (await this.readSessionTree(instanceId)).parsedTree;
	}

	async readPiSessionTree(instanceId: string): Promise<ReadonlyPiSessionTree> {
		return (await this.readSessionTree(instanceId)).piTree;
	}

	private async readCachedSessionTree(
		instanceId: string,
		handle: ProcessSessionSnapshotHandle,
	): Promise<CachedSessionTree> {
		const cached = this.sessionTreeCache.get(instanceId);
		if (cached?.signature === handle.signature) {
			return cached;
		}
		const cacheKey = `${instanceId}:${handle.signature}`;
		const inFlight = this.inFlightReads.get(cacheKey);
		if (inFlight) {
			return inFlight;
		}
		const promise = handle
			.load()
			.then((content) => {
				const piTree = parsePiSessionTreeContent(instanceId, content);
				const parsedTree = deriveParsedInstanceTree(piTree);
				const next = { signature: handle.signature, piTree, parsedTree };
				this.sessionTreeCache.set(instanceId, next);
				return next;
			})
			.finally(() => {
				this.inFlightReads.delete(cacheKey);
			});
		this.inFlightReads.set(cacheKey, promise);
		return promise;
	}

	/** Returns the raw session JSONL, or `null` when no session exists yet. */
	async readRawContent(instanceId: string): Promise<string | null> {
		const handle = await this.source.readSnapshotHandle(instanceId);
		if (!handle) {
			return null;
		}
		return handle.load();
	}
}

const SAFE_SESSION_INSTANCE_ID = /^[A-Za-z0-9_.-]+$/;

export function isSafeSessionInstanceId(instanceId: string): boolean {
	return SAFE_SESSION_INSTANCE_ID.test(instanceId) && instanceId !== "." && instanceId !== "..";
}

function assertSafeSessionInstanceId(instanceId: string): void {
	if (!isSafeSessionInstanceId(instanceId)) {
		throw new Error(`Invalid process session instance id '${instanceId}'`);
	}
}

function resolveSessionSnapshotPath(rootDir: string, instanceId: string): string {
	assertSafeSessionInstanceId(instanceId);
	return path.join(rootDir, `${instanceId}.jsonl`);
}

async function atomicCopyFile(sourcePath: string, targetPath: string): Promise<void> {
	await mkdir(path.dirname(targetPath), { recursive: true });
	const tempPath = path.join(
		path.dirname(targetPath),
		`.${path.basename(targetPath)}.${randomUUID()}.tmp`,
	);
	try {
		await copyFile(sourcePath, tempPath);
		await rename(tempPath, targetPath);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

class ProcessSessionSnapshotChangedError extends Error {}

function snapshotStatSignature(stats: BigIntStats): string {
	return `stat:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

async function statSnapshot(treeFile: string): Promise<string | null> {
	try {
		return snapshotStatSignature(await stat(treeFile, { bigint: true }));
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function loadSnapshotGeneration(
	treeFile: string,
	expectedSignature: string,
): Promise<string> {
	let file: FileHandle;
	try {
		file = await open(treeFile, "r");
	} catch (error) {
		if (isEnoent(error)) throw new ProcessSessionSnapshotChangedError();
		throw error;
	}
	try {
		const before = snapshotStatSignature(await file.stat({ bigint: true }));
		if (before !== expectedSignature) throw new ProcessSessionSnapshotChangedError();
		const content = await file.readFile("utf8");
		const after = snapshotStatSignature(await file.stat({ bigint: true }));
		if (after !== expectedSignature) throw new ProcessSessionSnapshotChangedError();
		return content;
	} finally {
		await file.close();
	}
}

/**
 * Filesystem-backed source reading `<treeFilesDir>/<instanceId>.jsonl`.
 *
 * A nanosecond file-generation signature makes unchanged cache checks cheap.
 * Cache misses verify that the loaded bytes still belong to that generation;
 * the reader retries when a concurrent replacement wins the race.
 */
export function createFileBackedProcessSessionSnapshotStore(
	treeFilesDir: string,
): ProcessSessionSnapshotStore {
	const rootDir = path.resolve(treeFilesDir);
	const resolveTreeFile = (instanceId: string): string =>
		resolveSessionSnapshotPath(rootDir, instanceId);
	return {
		async readSnapshotHandle(instanceId) {
			const treeFile = resolveTreeFile(instanceId);
			const signature = await statSnapshot(treeFile);
			if (!signature) return null;
			return {
				signature,
				load: () => loadSnapshotGeneration(treeFile, signature),
			};
		},
		async writeSnapshot(instanceId, content) {
			const treeFile = resolveTreeFile(instanceId);
			await atomicWriteUtf8(treeFile, content);
			return { bytes: Buffer.byteLength(content, "utf8") };
		},
		async writeSnapshotFile(instanceId, contentPath) {
			const treeFile = resolveTreeFile(instanceId);
			await atomicCopyFile(contentPath, treeFile);
			return { bytes: (await stat(treeFile)).size };
		},
		async readRawSnapshot(instanceId) {
			const treeFile = resolveTreeFile(instanceId);
			try {
				return await readFile(treeFile, "utf8");
			} catch (error) {
				if (isEnoent(error)) {
					return null;
				}
				throw error;
			}
		},
		async deleteSnapshot(instanceId) {
			await unlink(resolveTreeFile(instanceId)).catch((error: unknown) => {
				if (!isEnoent(error)) throw error;
			});
		},
	};
}

export function createFilesystemSessionSource(treeFilesDir: string): ProcessSessionSource {
	return createFileBackedProcessSessionSnapshotStore(treeFilesDir);
}

/** Convenience wiring a {@link ProcessSessionReader} over the local filesystem. */
export function createFilesystemSessionReader(treeFilesDir: string): ProcessSessionReader {
	return new ProcessSessionReader(createFilesystemSessionSource(treeFilesDir));
}
