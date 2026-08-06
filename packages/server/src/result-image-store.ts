import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	isResultImageStorageSegment,
	parseResultImageId,
	type ResultImageMimeType,
} from "@leitwerk-dev/worker-protocol";

export interface ResultImageMetadata {
	imageId: string;
	mimeType: ResultImageMimeType;
	byteSize: number;
}

const EXTENSIONS: Record<ResultImageMimeType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};
const MIME_BY_EXTENSION: Record<string, ResultImageMimeType> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
};
export class ResultImageStore {
	readonly rootDir: string;
	constructor(input: { rootDir: string }) {
		this.rootDir = path.resolve(input.rootDir);
	}
	private turnDir(instanceId: string, turnRecordId: string): string {
		if (!isResultImageStorageSegment(instanceId) || !isResultImageStorageSegment(turnRecordId))
			throw new Error("Invalid result image storage id");
		return path.join(this.rootDir, instanceId, turnRecordId);
	}
	async put(input: {
		instanceId: string;
		turnRecordId: string;
		bytes: Buffer;
		mimeType: ResultImageMimeType;
	}): Promise<ResultImageMetadata> {
		const dir = this.turnDir(input.instanceId, input.turnRecordId);
		await mkdir(dir, { recursive: true });
		const digest = createHash("sha256").update(input.bytes).digest("hex");
		const imageId = `img_${digest}.${EXTENSIONS[input.mimeType]}`;
		const destination = path.join(dir, imageId);
		const temporary = path.join(dir, `.${imageId}.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, input.bytes, { flag: "wx" });
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
		return { imageId, mimeType: input.mimeType, byteSize: input.bytes.length };
	}
	async deleteProcess(instanceId: string): Promise<void> {
		if (!isResultImageStorageSegment(instanceId))
			throw new Error("Invalid result image storage id");
		await rm(path.join(this.rootDir, instanceId), { recursive: true, force: true });
	}
	async cleanupProcesses(input: {
		retainedInstanceIds: ReadonlySet<string>;
		expiredInstanceIds?: ReadonlySet<string>;
	}): Promise<string[]> {
		let entries: Dirent[];
		try {
			entries = await readdir(this.rootDir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const removed: string[] = [];
		for (const entry of entries) {
			if (
				!entry.isDirectory() ||
				!isResultImageStorageSegment(entry.name) ||
				(input.retainedInstanceIds.has(entry.name) && !input.expiredInstanceIds?.has(entry.name))
			)
				continue;
			await rm(path.join(this.rootDir, entry.name), { recursive: true, force: true });
			removed.push(entry.name);
		}
		return removed;
	}
	async get(
		instanceId: string,
		turnRecordId: string,
		imageId: string,
	): Promise<{ metadata: ResultImageMetadata; bytes: Buffer } | null> {
		const extension = parseResultImageId(imageId)?.extension;
		if (!extension) return null;
		try {
			const bytes = await readFile(path.join(this.turnDir(instanceId, turnRecordId), imageId));
			return {
				metadata: { imageId, mimeType: MIME_BY_EXTENSION[extension], byteSize: bytes.length },
				bytes,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
}
