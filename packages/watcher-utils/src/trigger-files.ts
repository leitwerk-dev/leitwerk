import { readFile, unlink } from "node:fs/promises";

/** @internal */
export type TriggerFileReadResult =
	| {
			/** @internal */
			exists: false;
	  }
	| {
			/** @internal */
			exists: true;
			/** @internal */
			content: string;
	  };

/** @internal */
export function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return null;
	}
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : null;
}

/** @internal */
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

/** @internal */
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
