import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
	type PiResourceBundle,
	type PiResourceFile,
	type PiResourceFileProvenance,
	type PiResourceProvenanceKind,
	sha256Digest,
	validateResourceRelativePath,
	verifyCanonicalPiResourceBundle,
} from "@leitwerk-dev/worker-protocol";

export const DEFAULT_PI_RESOURCE_LIMITS = {
	maxFiles: 2_048,
	maxFileBytes: 32 * 1024 * 1024,
	maxTotalBytes: 64 * 1024 * 1024,
} as const;

export interface PiResourceLimits {
	readonly maxFiles?: number;
	readonly maxFileBytes?: number;
	readonly maxTotalBytes?: number;
}

export interface ResourceOwner {
	readonly kind: Exclude<PiResourceProvenanceKind, "generated">;
	readonly ownerExtensionId: string | null;
	readonly packageName: string | null;
}

export const SKILL_RESOURCE_OWNER: ResourceOwner = {
	kind: "skill",
	ownerExtensionId: null,
	packageName: null,
};

export interface PiResourceLayer {
	readonly bundle: PiResourceBundle;
	readonly owner: ResourceOwner;
}

function resolveLimits(input?: PiResourceLimits): Required<PiResourceLimits> {
	const limits = {
		maxFiles: input?.maxFiles ?? DEFAULT_PI_RESOURCE_LIMITS.maxFiles,
		maxFileBytes: input?.maxFileBytes ?? DEFAULT_PI_RESOURCE_LIMITS.maxFileBytes,
		maxTotalBytes: input?.maxTotalBytes ?? DEFAULT_PI_RESOURCE_LIMITS.maxTotalBytes,
	};
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new Error(`${name} must be a positive safe integer`);
		}
	}
	return limits;
}

export function compareResourcePaths(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function validatePhysicalSourcePath(sourcePath: string): void {
	if (!path.isAbsolute(sourcePath) || path.normalize(sourcePath) !== sourcePath) {
		throw new Error(`Pi resource source path must be normalized and absolute: ${sourcePath}`);
	}
}

export class ResourceCollector {
	readonly files = new Map<string, Uint8Array>();
	readonly provenance: PiResourceFileProvenance[] = [];
	private readonly sourceFileIdentities = new Map<string, string>();
	private readonly sourceFileRealPaths = new Map<string, string>();
	private readonly sourceRootRealPaths = new Map<string, string>();
	private readonly limits: Required<PiResourceLimits>;
	private totalBytes = 0;

	constructor(limits?: PiResourceLimits) {
		this.limits = resolveLimits(limits);
	}

	private checkCapacity(snapshotPath: string, size: number): void {
		if (size > this.limits.maxFileBytes) {
			throw new Error(
				`Pi resource '${snapshotPath}' size ${size} exceeds per-file limit ${this.limits.maxFileBytes}`,
			);
		}
		if (this.files.size + 1 > this.limits.maxFiles) {
			throw new Error(`Pi resource snapshot exceeds file-count limit ${this.limits.maxFiles}`);
		}
		if (this.totalBytes + size > this.limits.maxTotalBytes) {
			throw new Error(`Pi resource snapshot exceeds byte limit ${this.limits.maxTotalBytes}`);
		}
	}

	addBytes(snapshotPathInput: string, contentInput: Uint8Array, owner?: ResourceOwner): void {
		const snapshotPath = validateResourceRelativePath(snapshotPathInput);
		if (this.files.has(snapshotPath)) {
			throw new Error(`Duplicate Pi resource snapshot path '${snapshotPath}'`);
		}
		const content = Uint8Array.from(contentInput);
		this.checkCapacity(snapshotPath, content.byteLength);
		this.files.set(snapshotPath, content);
		this.totalBytes += content.byteLength;
		this.provenance.push({
			kind: owner?.kind ?? "generated",
			ownerExtensionId: owner?.ownerExtensionId ?? null,
			packageName: owner?.packageName ?? null,
			snapshotPath,
			sha256: sha256Digest(content),
			size: content.byteLength,
		});
	}

	addBundle(bundle: PiResourceBundle, owner: ResourceOwner): void {
		for (const file of verifyCanonicalPiResourceBundle(bundle.bytes, bundle.digest)) {
			this.addBytes(file.path, file.content, owner);
		}
	}

	private async addSourceFile(
		sourcePath: string,
		snapshotPath: string,
		owner: ResourceOwner,
		physicalRoot: string,
	): Promise<void> {
		const before = await lstat(sourcePath);
		if (before.isSymbolicLink() || !before.isFile()) {
			throw new Error(`Pi resource source must be a regular file: ${sourcePath}`);
		}
		const physicalPath = await realpath(sourcePath);
		if (!isWithin(physicalRoot, physicalPath)) {
			throw new Error(`Pi resource path escapes its declared directory: ${sourcePath}`);
		}
		const identity = `${before.dev}:${before.ino}`;
		const duplicate =
			this.sourceFileIdentities.get(identity) ?? this.sourceFileRealPaths.get(physicalPath);
		if (duplicate) {
			throw new Error(
				`Physical Pi resource file is included more than once: ${sourcePath} (first: ${duplicate})`,
			);
		}
		if (before.size > this.limits.maxFileBytes) {
			throw new Error(
				`Pi resource source '${sourcePath}' size ${before.size} exceeds per-file limit ${this.limits.maxFileBytes}`,
			);
		}
		const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		let content: Uint8Array;
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
				throw new Error(`Pi resource source changed while being read: ${sourcePath}`);
			}
			content = await handle.readFile();
		} finally {
			await handle.close();
		}
		this.sourceFileIdentities.set(identity, sourcePath);
		this.sourceFileRealPaths.set(physicalPath, sourcePath);
		this.addBytes(snapshotPath, content, owner);
	}

	async addDirectory(
		sourceRoot: string,
		targetRoot: string,
		owner: ResourceOwner,
		options: { forbiddenNames?: ReadonlySet<string> } = {},
	): Promise<void> {
		validatePhysicalSourcePath(sourceRoot);
		const rootStat = await lstat(sourceRoot);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			throw new Error(`Pi resource root must be a real directory: ${sourceRoot}`);
		}
		const physicalRoot = await realpath(sourceRoot);
		const duplicateRoot = this.sourceRootRealPaths.get(physicalRoot);
		if (duplicateRoot) {
			throw new Error(
				`Physical Pi resource directory is declared more than once: ${sourceRoot} (first: ${duplicateRoot})`,
			);
		}
		this.sourceRootRealPaths.set(physicalRoot, sourceRoot);

		const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
			const entries = await readdir(directory, { withFileTypes: true });
			entries.sort((left, right) => compareResourcePaths(left.name, right.name));
			for (const entry of entries) {
				if (options.forbiddenNames?.has(entry.name)) {
					throw new Error(`Pi resource contains forbidden path component '${entry.name}'`);
				}
				const source = path.join(directory, entry.name);
				const relative = relativeDirectory
					? path.posix.join(relativeDirectory, entry.name)
					: entry.name;
				if (entry.isSymbolicLink()) {
					throw new Error(`Symbolic links are forbidden in Pi resources: ${source}`);
				}
				if (entry.isDirectory()) {
					await visit(source, relative);
					continue;
				}
				if (!entry.isFile()) {
					throw new Error(`Special filesystem entries are forbidden in Pi resources: ${source}`);
				}
				await this.addSourceFile(
					source,
					validateResourceRelativePath(path.posix.join(targetRoot, relative)),
					owner,
					physicalRoot,
				);
			}
		};
		await visit(sourceRoot, "");
	}

	toResourceFiles(): PiResourceFile[] {
		return [...this.files]
			.sort(([left], [right]) => compareResourcePaths(left, right))
			.map(([resourcePath, content]) => ({ path: resourcePath, content }));
	}
}
