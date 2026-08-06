import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
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
