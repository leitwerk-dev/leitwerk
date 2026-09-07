import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readlink,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress, constants as zlibConstants } from "node:zlib";
import tar from "tar-stream";
import {
	assertSafeRelativePath,
	DEFAULT_SESSION_TRANSFER_LIMITS,
	isPathInside,
	type LeitwerkTransferManifestV1,
	parseTransferManifest,
	type SessionTransferLimits,
	type SessionTransferPreflight,
	type TransferArchiveProgress,
} from "./format.js";
import { readProjectEvidence } from "./project-evidence.js";
import { assertConfinedSymlinks } from "./symlink-confinement.js";

const MANIFEST_MAX_BYTES = 1024 * 1024;
type TarHeader = Partial<tar.Header> & Pick<tar.Header, "name">;

export interface PortableEntry {
	relativePath: string;
	kind: "file" | "directory" | "symlink";
	mode: number;
	mtimeMs: number;
	size: number;
	linkTarget?: string;
}

export interface TransferPreflight extends SessionTransferPreflight {
	entries: PortableEntry[];
}

export interface ExtractTransferResult {
	manifest: LeitwerkTransferManifestV1;
	compressedBytes: number;
	streamSha256: string;
}

export interface PreparedTransferArchive {
	manifest: LeitwerkTransferManifestV1;
	preflight: TransferPreflight;
	stream(input: { signal?: AbortSignal }): Readable;
}

function abortIfNeeded(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("Transfer cancelled");
}

function toSafeNumber(value: bigint, label: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error(`${label} exceeds safe integer range`);
	return Number(value);
}

export async function scanPortableWorkspace(input: {
	workspaceRoot: string;
	sessionFile: string;
	limits?: SessionTransferLimits;
	signal?: AbortSignal;
}): Promise<TransferPreflight> {
	const limits = input.limits ?? DEFAULT_SESSION_TRANSFER_LIMITS;
	const root = path.resolve(input.workspaceRoot);
	if (!(await lstat(root, { bigint: true })).isDirectory()) {
		throw new Error("Process workspace is not a directory");
	}
	const entries: PortableEntry[] = [];
	let logicalBytesTotal = 0;
	const add = (entry: PortableEntry): void => {
		entries.push(entry);
		if (entries.length + 3 > limits.maxEntries) throw new Error("Transfer entry limit exceeded");
		if (entry.kind === "file") {
			logicalBytesTotal += entry.size;
			if (!Number.isSafeInteger(logicalBytesTotal) || logicalBytesTotal > limits.maxLogicalBytes) {
				throw new Error("Transfer logical byte limit exceeded");
			}
		}
	};
	const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
		abortIfNeeded(input.signal);
		const names = await readdir(directory);
		names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
		for (const name of names) {
			abortIfNeeded(input.signal);
			// Archive paths are normalized with POSIX separators during extraction.
			// A backslash is a valid POSIX filename character, so reject it here
			// rather than silently changing the exported filename on import.
			if (name.includes("\\")) {
				throw new Error(`Workspace entry contains an unsupported path separator: ${name}`);
			}
			const absolute = path.join(directory, name);
			if (!isPathInside(root, absolute))
				throw new Error("Workspace scan escaped its configured root");
			const relativePath = path.posix.join(relativeDirectory, name);
			const stats = await lstat(absolute, { bigint: true });
			const common = {
				relativePath,
				mode: Number(stats.mode & 0o7777n),
				mtimeMs: Number(stats.mtimeMs),
			};
			if (stats.isDirectory()) {
				add({ ...common, kind: "directory", size: 0 });
				await walk(absolute, relativePath);
			} else if (stats.isFile()) {
				add({ ...common, kind: "file", size: toSafeNumber(stats.size, relativePath) });
			} else if (stats.isSymbolicLink()) {
				const linkTarget = await readlink(absolute);
				if (path.isAbsolute(linkTarget) || path.win32.isAbsolute(linkTarget)) {
					throw new Error(`Absolute symlink is not portable: ${relativePath}`);
				}
				add({ ...common, kind: "symlink", size: 0, linkTarget });
			} else {
				throw new Error(`Unsupported workspace entry type: ${relativePath}`);
			}
		}
	};
	await walk(root, "");
	assertConfinedSymlinks(
		new Map(
			entries.flatMap((entry) =>
				entry.kind === "symlink" ? [[entry.relativePath, entry.linkTarget ?? ""] as const] : [],
			),
		),
	);
	const sessionStats = await lstat(path.resolve(input.sessionFile), { bigint: true });
	if (!sessionStats.isFile()) throw new Error("Primary Pi session is not a regular file");
	logicalBytesTotal += toSafeNumber(sessionStats.size, "Pi session");
	if (!Number.isSafeInteger(logicalBytesTotal) || logicalBytesTotal > limits.maxLogicalBytes) {
		throw new Error("Transfer logical byte limit exceeded");
	}
	return { entries, entriesTotal: entries.length + 3, logicalBytesTotal };
}

function addBufferEntry(
	pack: tar.Pack,
	header: TarHeader,
	content: Buffer | string = Buffer.alloc(0),
): Promise<void> {
	return new Promise((resolve, reject) => {
		pack.entry(header, content, (error) => (error ? reject(error) : resolve()));
	});
}

async function addFileEntry(
	pack: tar.Pack,
	header: TarHeader,
	filePath: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	abortIfNeeded(signal);
	const entry = pack.entry(header);
	await pipeline(createReadStream(filePath), entry, { signal });
}

export async function prepareTransferArchive(input: {
	workspaceRoot: string;
	sessionFile: string;
	manifest: LeitwerkTransferManifestV1;
	limits: SessionTransferLimits;
	signal?: AbortSignal;
}): Promise<PreparedTransferArchive> {
	const preflight = await scanPortableWorkspace(input);
	const manifest: LeitwerkTransferManifestV1 = {
		...input.manifest,
		projects: await readProjectEvidence(input.workspaceRoot, input.manifest.projects, input.signal),
	};
	return {
		manifest,
		preflight,
		stream: ({ signal }) => createTransferArchive({ ...input, manifest, preflight, signal }),
	};
}

export function createTransferArchive(input: {
	workspaceRoot: string;
	sessionFile: string;
	manifest: LeitwerkTransferManifestV1;
	preflight: TransferPreflight;
	signal?: AbortSignal;
}): Readable {
	const pack = tar.pack();
	const zstd = createZstdCompress({
		params: {
			[zlibConstants.ZSTD_c_compressionLevel]: 1,
			[zlibConstants.ZSTD_c_checksumFlag]: 1,
		},
	});
	const createdAt = new Date(input.manifest.createdAt);
	const finish = async (): Promise<void> => {
		abortIfNeeded(input.signal);
		const manifest = `${JSON.stringify(input.manifest)}\n`;
		await addBufferEntry(pack, { name: "manifest.json", mode: 0o600, mtime: createdAt }, manifest);
		await addBufferEntry(pack, {
			name: "workspace/",
			type: "directory",
			mode: 0o755,
			mtime: createdAt,
		});
		for (const entry of input.preflight.entries) {
			abortIfNeeded(input.signal);
			const name = `workspace/${entry.relativePath}${entry.kind === "directory" ? "/" : ""}`;
			const header: TarHeader = {
				name,
				type: entry.kind === "file" ? "file" : entry.kind,
				mode: entry.mode,
				mtime: new Date(entry.mtimeMs),
				...(entry.kind === "file" ? { size: entry.size } : {}),
				...(entry.linkTarget ? { linkname: entry.linkTarget } : {}),
			};
			if (entry.kind === "file") {
				await addFileEntry(
					pack,
					header,
					path.join(input.workspaceRoot, ...entry.relativePath.split("/")),
					input.signal,
				);
			} else {
				await addBufferEntry(pack, header);
			}
		}
		const workspaceBytes = input.preflight.entries.reduce(
			(sum, entry) => sum + (entry.kind === "file" ? entry.size : 0),
			0,
		);
		await addFileEntry(
			pack,
			{
				name: "session.jsonl",
				mode: 0o600,
				mtime: createdAt,
				size: input.preflight.logicalBytesTotal - workspaceBytes,
			},
			input.sessionFile,
			input.signal,
		);
		pack.finalize();
	};
	// Pipeline propagates failures and consumer cancellation in both directions.
	// Its rejection is also exposed as an error on the returned compressed stream.
	void pipeline(pack, zstd, { signal: input.signal }).catch(() => undefined);
	void finish().catch((error) => pack.destroy(error as Error));
	return zstd;
}

async function assertNoSymlinkParents(root: string, target: string): Promise<void> {
	let current = root;
	for (const segment of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				throw new Error(`Archive path traverses symlink '${segment}'`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

async function drainEntry(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _chunk of stream) {
		// tar-stream requires each entry to be drained before advancing.
	}
}

async function streamBuffer(
	stream: AsyncIterable<Uint8Array>,
	limit: number,
	label: string,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > limit) throw new Error(`${label} is too large`);
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

export async function extractTransferArchive(input: {
	compressed: Readable;
	outputRoot: string;
	limits?: SessionTransferLimits;
	signal?: AbortSignal;
	onProgress?: (progress: TransferArchiveProgress & { compressedBytes: number }) => void;
	ownershipMarker?: { name: string; value: string };
}): Promise<ExtractTransferResult> {
	const limits = input.limits ?? DEFAULT_SESSION_TRANSFER_LIMITS;
	const outputRoot = path.resolve(input.outputRoot);
	await mkdir(outputRoot, { recursive: false, mode: 0o700 });
	if (input.ownershipMarker) {
		const markerName = assertSafeRelativePath(input.ownershipMarker.name, "ownership marker");
		if (markerName.includes("/")) throw new Error("Ownership marker must be a root file");
		await writeFile(path.join(outputRoot, markerName), `${input.ownershipMarker.value}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	}

	const hash = createHash("sha256");
	let compressedBytes = 0;
	let entriesProcessed = 0;
	let logicalBytesProcessed = 0;
	let manifest: LeitwerkTransferManifestV1 | null = null;
	const seen = new Set<string>();
	const symlinks = new Map<string, string>();
	const directoryMetadata: Array<{ target: string; mode: number; mtime: Date }> = [];
	const report = (): void =>
		input.onProgress?.({ entriesProcessed, logicalBytesProcessed, compressedBytes });
	const metered = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			compressedBytes += chunk.length;
			if (compressedBytes > limits.maxCompressedBytes) {
				callback(new Error("Transfer compressed byte limit exceeded"));
				return;
			}
			hash.update(chunk);
			report();
			callback(null, chunk);
		},
	});
	const extract = tar.extract();
	extract.on("entry", (header, entryStream, next) => {
		void (async () => {
			abortIfNeeded(input.signal);
			const name = assertSafeRelativePath(header.name.replace(/\/$/, ""), "archive path");
			if (seen.has(name)) throw new Error(`Duplicate archive path '${name}'`);
			seen.add(name);
			entriesProcessed += 1;
			if (entriesProcessed > limits.maxEntries) throw new Error("Transfer entry limit exceeded");
			if (entriesProcessed === 1 && name !== "manifest.json") {
				throw new Error("manifest.json must be the first archive entry");
			}
			if (
				name !== "manifest.json" &&
				name !== "session.jsonl" &&
				name !== "workspace" &&
				!name.startsWith("workspace/")
			) {
				throw new Error(`Unexpected archive path '${name}'`);
			}
			const target = path.resolve(outputRoot, ...name.split("/"));
			if (!isPathInside(outputRoot, target))
				throw new Error(`Archive path escapes output: ${name}`);
			await assertNoSymlinkParents(outputRoot, target);
			const mode = (header.mode ?? (header.type === "directory" ? 0o755 : 0o600)) & 0o7777;
			const mtime = header.mtime ?? new Date(0);
			if (header.type === "directory") {
				if (header.size !== 0) throw new Error(`Directory '${name}' has content`);
				await drainEntry(entryStream);
				await mkdir(target, { recursive: false, mode: mode | 0o700 });
				directoryMetadata.push({ target, mode, mtime });
			} else if (header.type === "symlink") {
				if (header.size !== 0) throw new Error(`Symlink '${name}' has content`);
				await drainEntry(entryStream);
				if (!name.startsWith("workspace/")) {
					throw new Error(`Archive symlink is outside the workspace: ${name}`);
				}
				const link = header.linkname ?? "";
				if (path.isAbsolute(link) || path.win32.isAbsolute(link)) {
					throw new Error(`Absolute archive symlink '${name}'`);
				}
				await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
				await symlink(link, target);
				symlinks.set(name.slice("workspace/".length), link);
			} else if (header.type === "file" || !header.type) {
				const size = header.size ?? 0;
				if (!Number.isSafeInteger(size) || size < 0) {
					throw new Error(`Invalid size for archive entry '${name}'`);
				}
				await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
				if (name === "manifest.json") {
					const content = await streamBuffer(
						entryStream as AsyncIterable<Uint8Array>,
						MANIFEST_MAX_BYTES,
						"Transfer manifest",
					);
					await writeFile(target, content, { flag: "wx", mode: 0o600 });
					manifest = parseTransferManifest(JSON.parse(content.toString("utf8")));
				} else {
					const handle = await open(target, "wx", mode);
					let actualSize = 0;
					try {
						for await (const chunk of entryStream as AsyncIterable<Uint8Array>) {
							const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
							actualSize += buffer.length;
							logicalBytesProcessed += buffer.length;
							if (
								!Number.isSafeInteger(actualSize) ||
								logicalBytesProcessed > limits.maxLogicalBytes
							) {
								throw new Error("Transfer logical byte limit exceeded");
							}
							await handle.write(buffer);
						}
					} finally {
						await handle.close();
					}
					if (actualSize !== size) {
						throw new Error(`Archive entry '${name}' size does not match its content`);
					}
					await chmod(target, mode);
					await utimes(target, mtime, mtime);
				}
			} else {
				await drainEntry(entryStream);
				throw new Error(`Unsupported tar entry type '${header.type}' for '${name}'`);
			}
			report();
			next();
		})().catch((error) => next(error as Error));
	});
	const abort = (): void => extract.destroy(input.signal?.reason);
	input.signal?.addEventListener("abort", abort, { once: true });
	try {
		await pipeline(input.compressed, metered, createZstdDecompress(), extract);
	} finally {
		input.signal?.removeEventListener("abort", abort);
	}
	assertConfinedSymlinks(symlinks);
	for (const directory of directoryMetadata.reverse()) {
		await chmod(directory.target, directory.mode);
		await utimes(directory.target, directory.mtime, directory.mtime);
	}
	if (!manifest) throw new Error("Transfer manifest is missing");
	if (!seen.has("workspace") || !seen.has("session.jsonl")) {
		throw new Error("Transfer archive is incomplete");
	}
	return {
		manifest,
		compressedBytes,
		streamSha256: hash.digest("hex"),
	};
}
