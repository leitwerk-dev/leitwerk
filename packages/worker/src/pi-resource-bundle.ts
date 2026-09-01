import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createCanonicalPiResourceBundle,
	type ExtractedPiResourceFile,
	type PiResourceBundle,
	type PiResourceFile,
	sha256Digest,
	validateResourceRelativePath,
	verifyCanonicalPiResourceBundle,
} from "@leitwerk-dev/worker-protocol";

export {
	createCanonicalPiResourceBundle,
	type ExtractedPiResourceFile,
	type PiResourceBundle,
	type PiResourceFile,
	sha256Digest,
	validateResourceRelativePath,
	verifyCanonicalPiResourceBundle,
};

function fail(message: string): never {
	throw new Error(`Invalid Pi resource bundle: ${message}`);
}

function requireStorageName(value: string, label: string): string {
	if (!/^[a-zA-Z0-9_-]+$/u.test(value)) fail(`unsafe ${label}: ${value}`);
	return value;
}

async function atomicWrite(pathname: string, content: Uint8Array, mode: number): Promise<void> {
	const staging = `${pathname}.staging-${process.pid}-${randomUUID()}`;
	const handle = await open(staging, "wx", mode);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(staging, pathname);
	} catch (error) {
		await rm(staging, { force: true });
		throw error;
	}
}

/** Resolves an immutable bundle from delivered bytes or the process volume and records its start. */
export async function persistPiResourceBundleForStart(input: {
	bundlesDir: string;
	startRecordId: string;
	digest: string;
	archiveBase64?: string;
	deliveredBundle?: Uint8Array;
}): Promise<{ bundle: Uint8Array; reused: boolean }> {
	const digest = requireStorageName(input.digest, "resource digest");
	const startRecordId = requireStorageName(input.startRecordId, "turn-start id");
	const bundlesDir = path.resolve(input.bundlesDir);
	const startsDir = path.join(bundlesDir, "starts");
	const bundlePath = path.join(bundlesDir, `${digest}.tar`);
	await mkdir(startsDir, { recursive: true, mode: 0o700 });

	let bundle: Uint8Array | null = null;
	let reused = false;
	try {
		const existing = await readFile(bundlePath);
		verifyCanonicalPiResourceBundle(existing, digest);
		bundle = existing;
		reused = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && input.archiveBase64 === undefined) {
			throw error;
		}
	}
	if (!bundle) {
		if (!input.deliveredBundle && input.archiveBase64 === undefined) {
			throw new Error(`Pi resource bundle '${digest}' is unavailable on the process volume`);
		}
		bundle = input.deliveredBundle ?? Buffer.from(input.archiveBase64 as string, "base64");
		verifyCanonicalPiResourceBundle(bundle, digest);
		await atomicWrite(bundlePath, bundle, 0o600);
	}

	const manifest = Buffer.from(
		`${JSON.stringify({ startRecordId, digest, persistedAt: new Date().toISOString() })}\n`,
		"utf8",
	);
	await atomicWrite(path.join(startsDir, `${startRecordId}.json`), manifest, 0o600);
	return { bundle, reused };
}

async function writeExtractedFiles(
	root: string,
	files: readonly ExtractedPiResourceFile[],
): Promise<void> {
	for (const file of files) {
		const output = path.resolve(root, file.path);
		if (
			path.relative(root, output).startsWith("..") ||
			path.isAbsolute(path.relative(root, output))
		) {
			fail(`path escapes materialization root: ${file.path}`);
		}
		await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
		await writeFile(output, file.content, { mode: 0o644, flag: "wx" });
	}
}

/** Extracts a verified bundle into an empty staging directory, then atomically publishes it. */
export async function materializeCanonicalPiResourceBundle(input: {
	bundle: Uint8Array;
	digest: string;
	targetDir: string;
}): Promise<{ targetDir: string; reused: boolean }> {
	const files = verifyCanonicalPiResourceBundle(input.bundle, input.digest);
	const targetDir = path.resolve(input.targetDir);
	const parent = path.dirname(targetDir);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const marker = path.join(targetDir, ".leitwerk-resource-digest");
	try {
		const current = await import("node:fs/promises").then(({ readFile }) =>
			readFile(marker, "utf8"),
		);
		if (current === `${input.digest}\n`) return { targetDir, reused: true };
		throw new Error(
			`Managed Pi directory already exists with a different resource digest: ${targetDir}`,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const staging = path.join(
		parent,
		`.${path.basename(targetDir)}.staging-${process.pid}-${randomUUID()}`,
	);
	try {
		await mkdir(staging, { mode: 0o700 });
		await writeExtractedFiles(staging, files);
		await writeFile(path.join(staging, ".leitwerk-resource-digest"), `${input.digest}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		await rename(staging, targetDir);
		return { targetDir, reused: false };
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			const current = await import("node:fs/promises").then(({ readFile }) =>
				readFile(marker, "utf8"),
			);
			if (current === `${input.digest}\n`) return { targetDir, reused: true };
		}
		throw error;
	}
}
