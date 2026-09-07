import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	link as linkFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isPathInside, type ParsedTransferLink } from "@leitwerk-dev/session-transfer";

const OWNER_MARKER = ".leitwerk-transfer-owner";
const STALE_IMPORT_MS = 2 * 60 * 60 * 1000;

export interface TransferReceipt {
	version: 1;
	origin: string;
	grantId: string;
	tokenHash: string;
	attemptId: string;
	destination: string;
	sessionPath: string;
	completedAt: string;
}

interface TransferStateRecord {
	version: 1;
	phase: "temporary" | "committing" | "completed";
	origin: string;
	grantId: string;
	tokenHash: string;
	attemptId: string;
	createdAt: string;
	temporaryDirectory: string;
	ownerId: string;
	destination?: string;
	sessionPath?: string;
	completedAt?: string;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}

async function atomicJson(file: string, value: unknown, exclusive = false): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		if (exclusive) await linkFile(temporary, file);
		else await rename(temporary, file);
		await chmod(file, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function ownsDirectory(directory: string, ownerId: string, marker: string): Promise<boolean> {
	try {
		return (
			(await lstat(directory)).isDirectory() &&
			(await readFile(path.join(directory, marker), "utf8")).trim() === ownerId
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function removeOwnedDirectory(
	directory: string,
	ownerId: string,
	marker: string,
): Promise<void> {
	if (!(await ownsDirectory(directory, ownerId, marker))) return;
	// Keep the ownership proof until all imported children have been removed.
	for (const name of await readdir(directory)) {
		if (name !== marker) await rm(path.join(directory, name), { recursive: true, force: true });
	}
	await rm(path.join(directory, marker));
	await rmdir(directory);
}

function tokenHash(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function stateKey(link: ParsedTransferLink): string {
	return createHash("sha256")
		.update(`${link.origin}\0${link.grantId}\0${tokenHash(link.token)}`)
		.digest("hex");
}

function completedReceipt(record: TransferStateRecord): TransferReceipt | null {
	if (
		record.phase !== "completed" ||
		!record.destination ||
		!record.sessionPath ||
		!record.completedAt
	) {
		return null;
	}
	return {
		version: 1,
		origin: record.origin,
		grantId: record.grantId,
		tokenHash: record.tokenHash,
		attemptId: record.attemptId,
		destination: record.destination,
		sessionPath: record.sessionPath,
		completedAt: record.completedAt,
	};
}

export class LocalTransferState {
	private readonly agentRoot: string;
	private readonly recordsRoot: string;
	private stateTail: Promise<void> = Promise.resolve();

	constructor(agentDir: string) {
		this.agentRoot = path.resolve(agentDir);
		this.recordsRoot = path.join(this.agentRoot, "leitwerk-session-transfer", "transfers");
	}

	private recordFile(link: ParsedTransferLink): string {
		return path.join(this.recordsRoot, `${stateKey(link)}.json`);
	}

	private async serialized<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.stateTail;
		let release!: () => void;
		this.stateTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	markerName(ownerId?: string): string {
		return ownerId ? `${OWNER_MARKER}-${ownerId}` : OWNER_MARKER;
	}

	async receipt(link: ParsedTransferLink): Promise<TransferReceipt | null> {
		const record = await readJson<TransferStateRecord | null>(this.recordFile(link), null);
		return record ? completedReceipt(record) : null;
	}

	async begin(
		link: ParsedTransferLink,
		input: { attemptId: string; temporaryDirectory: string; ownerId: string },
	): Promise<void> {
		await this.serialized(async () => {
			try {
				await atomicJson(
					this.recordFile(link),
					{
						version: 1,
						phase: "temporary",
						origin: link.origin,
						grantId: link.grantId,
						tokenHash: tokenHash(link.token),
						attemptId: input.attemptId,
						createdAt: new Date().toISOString(),
						temporaryDirectory: input.temporaryDirectory,
						ownerId: input.ownerId,
					} satisfies TransferStateRecord,
					true,
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					throw new Error("A previous import for this link still has recovery state", {
						cause: error,
					});
				}
				throw error;
			}
		});
	}

	async recordCommitTargets(
		link: ParsedTransferLink,
		targets: Required<Pick<TransferStateRecord, "destination" | "sessionPath">>,
	): Promise<void> {
		await this.serialized(async () => {
			const file = this.recordFile(link);
			const record = await readJson<TransferStateRecord | null>(file, null);
			if (!record || record.phase === "completed") {
				throw new Error("Transfer recovery state is missing or already complete");
			}
			await atomicJson(file, { ...record, ...targets, phase: "committing" });
		});
	}

	async complete(
		link: ParsedTransferLink,
		input: { destination: string; sessionPath: string; completedAt: string },
	): Promise<TransferReceipt> {
		return this.serialized(async () => {
			const file = this.recordFile(link);
			const record = await readJson<TransferStateRecord | null>(file, null);
			if (!record) throw new Error("Transfer recovery state is missing");
			const completed: TransferStateRecord = { ...record, ...input, phase: "completed" };
			await atomicJson(file, completed);
			return completedReceipt(completed) as TransferReceipt;
		});
	}

	async discard(link: ParsedTransferLink): Promise<void> {
		await this.serialized(async () => {
			const file = this.recordFile(link);
			const record = await readJson<TransferStateRecord | null>(file, null);
			if (!record) return;
			if (record.phase === "completed") throw new Error("Completed imports cannot be discarded");
			if (
				record.destination &&
				(await ownsDirectory(record.destination, record.ownerId, this.markerName(record.ownerId)))
			) {
				throw new Error("A reserved import must retain its recovery state");
			}
			await removeOwnedDirectory(record.temporaryDirectory, record.ownerId, OWNER_MARKER);
			await rm(file, { force: true });
		});
	}

	async reconcile(): Promise<void> {
		await this.serialized(async () => {
			let names: string[];
			try {
				names = await readdir(this.recordsRoot);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
			for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
				const file = path.join(this.recordsRoot, name);
				try {
					const record = await readJson<TransferStateRecord | null>(file, null);
					if (!record) continue;
					if (
						record.phase !== "completed" &&
						Date.now() - Date.parse(record.createdAt) <= STALE_IMPORT_MS
					) {
						continue;
					}
					const destinationMarker = this.markerName(record.ownerId);
					const ownsDestination = record.destination
						? await ownsDirectory(record.destination, record.ownerId, destinationMarker)
						: false;
					if (record.phase === "completed") {
						if (ownsDestination && record.destination) {
							await rm(path.join(record.destination, destinationMarker), { force: true });
						}
						await removeOwnedDirectory(record.temporaryDirectory, record.ownerId, OWNER_MARKER);
						continue;
					}
					if (ownsDestination && record.destination) {
						await removeOwnedDirectory(record.destination, record.ownerId, destinationMarker);
					}
					if (record.sessionPath && isPathInside(this.agentRoot, record.sessionPath)) {
						await rm(record.sessionPath, { force: true });
					}
					await removeOwnedDirectory(record.temporaryDirectory, record.ownerId, OWNER_MARKER);
					await rm(file, { force: true });
				} catch {
					// Keep the record for a later reconciliation attempt.
				}
			}
		});
	}
}
