import { readFile, unlink } from "node:fs/promises";

export type TriggerFileReadResult = { exists: false } | { exists: true; content: string };

export function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return null;
	}
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : null;
}

export async function readTriggerFile(filePath: string): Promise<TriggerFileReadResult> {
	try {
		return { exists: true, content: await readFile(filePath, "utf8") };
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return { exists: false };
		}
		throw error;
	}
}

export async function consumeTriggerFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return;
		}
		throw error;
	}
}
