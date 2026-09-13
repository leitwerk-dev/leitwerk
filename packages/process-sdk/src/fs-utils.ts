import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tempPath = path.join(
		dir,
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(tempPath, content, "utf8");
		await rename(tempPath, filePath);
	} catch (error) {
		await unlink(tempPath).catch(() => {});
		throw error;
	}
}

// The parent itself is not inside: callers require a strict descendant.
export function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative !== "" &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

export function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}

export function isEnoent(error: unknown): boolean {
	return hasErrorCode(error, "ENOENT");
}
