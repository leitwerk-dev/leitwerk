import { randomUUID } from "node:crypto";
import { access, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	extractTransferArchive,
	isPathInside,
	type ParsedTransferLink,
	readProjectEvidence,
	rewritePiSession,
	type TransferArchiveProgress,
} from "@leitwerk-dev/session-transfer";
import { type RemoteTransferAttempt, SessionTransferClient } from "./client.js";
import type { LocalTransferState } from "./local-state.js";

export interface ImportProgress extends TransferArchiveProgress {
	phase: string;
	compressedBytes: number;
	entriesTotal: number | null;
	logicalBytesTotal: number | null;
	finishing: boolean;
}

export interface ImportResult {
	destination: string;
	sessionPath: string;
	attemptId: string;
}

async function assertDestinationAbsent(destination: string): Promise<void> {
	try {
		await lstat(destination);
		throw new Error(`Destination already exists: ${destination}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function resolveImportedCwd(root: string, relative: string | null): string {
	return relative === null || relative === "." ? root : path.resolve(root, ...relative.split("/"));
}

async function validateProjects(
	workspaceRoot: string,
	projects: Parameters<typeof readProjectEvidence>[1],
	signal: AbortSignal,
): Promise<void> {
	const actual = await readProjectEvidence(workspaceRoot, projects, signal);
	for (let index = 0; index < projects.length; index += 1) {
		const expected = projects[index];
		const candidate = actual[index];
		if (!expected || !candidate) throw new Error("Project evidence is incomplete");
		if (expected.head && candidate.head !== expected.head) {
			throw new Error(`Project '${expected.key}' HEAD does not match the transfer manifest`);
		}
		if (candidate.branch !== expected.branch) {
			throw new Error(
				`Project '${expected.key}' branch state does not match the transfer manifest`,
			);
		}
	}
}

export async function importTransfer(input: {
	link: ParsedTransferLink;
	destination: string;
	state: LocalTransferState;
	signal: AbortSignal;
	onProgress(progress: ImportProgress): void;
}): Promise<ImportResult> {
	const destination = path.resolve(input.destination);
	await assertDestinationAbsent(destination);
	const client = new SessionTransferClient(input.link);
	let attempt: RemoteTransferAttempt | null = null;
	let temporaryDirectory: string | null = null;
	let destinationCommitted = false;
	let sessionPath: string | null = null;
	let heartbeat: NodeJS.Timeout | null = null;
	const progress: ImportProgress = {
		phase: "queued",
		compressedBytes: 0,
		entriesProcessed: 0,
		logicalBytesProcessed: 0,
		entriesTotal: null,
		logicalBytesTotal: null,
		finishing: false,
	};
	const report = (patch: Partial<ImportProgress>): void => {
		Object.assign(progress, patch);
		input.onProgress({ ...progress });
	};
	try {
		attempt = await client.start(input.signal);
		heartbeat = setInterval(() => {
			if (attempt) void client.status(attempt.id).catch(() => undefined);
		}, 30_000);
		while (attempt.phase !== "ready_to_stream") {
			if (["cancelled", "failed", "consumed"].includes(attempt.state)) {
				throw new Error(
					attempt.failureCode
						? `Transfer ended: ${attempt.failureCode}`
						: `Transfer ended in state ${attempt.state}`,
				);
			}
			report({
				phase: attempt.phase,
				entriesTotal: attempt.entriesTotal,
				logicalBytesTotal: attempt.logicalBytesTotal,
			});
			await delay(1_000, undefined, { signal: input.signal });
			attempt = await client.status(attempt.id, input.signal);
		}
		const ownerId = randomUUID();
		const destinationMarkerName = input.state.markerName(ownerId);
		temporaryDirectory = path.join(
			path.dirname(destination),
			`.leitwerk-transfer-${input.link.instanceId}-${randomUUID()}`,
		);
		await input.state.begin(input.link, {
			attemptId: attempt.id,
			temporaryDirectory,
			ownerId,
		});
		report({
			phase: "streaming",
			entriesTotal: attempt.entriesTotal,
			logicalBytesTotal: attempt.logicalBytesTotal,
		});
		const compressed = await client.stream(attempt.id, input.signal);
		const extracted = await extractTransferArchive({
			compressed,
			outputRoot: temporaryDirectory,
			signal: input.signal,
			ownershipMarker: { name: input.state.markerName(), value: ownerId },
			onProgress: (archiveProgress) =>
				report({
					phase: "streaming",
					...archiveProgress,
				}),
		});
		if (extracted.manifest.instanceId !== input.link.instanceId)
			throw new Error("Transfer manifest process id does not match the link");
		attempt = await client.status(attempt.id, input.signal);
		if (
			attempt.state !== "awaiting_ack" ||
			attempt.compressedBytes !== extracted.compressedBytes ||
			attempt.streamSha256 !== extracted.streamSha256
		) {
			throw new Error("Transfer stream digest or byte count does not match the server record");
		}
		report({ phase: "validating_local" });
		const temporaryWorkspace = path.join(temporaryDirectory, "workspace");
		await validateProjects(temporaryWorkspace, extracted.manifest.projects, input.signal);
		const relativeCwd = extracted.manifest.session.cwdRelativeToWorkspace;
		const localCwd = resolveImportedCwd(destination, relativeCwd);
		if (!isPathInside(destination, localCwd))
			throw new Error("Imported session cwd escapes the destination");
		const temporaryCwd = resolveImportedCwd(temporaryWorkspace, relativeCwd);
		if (!isPathInside(temporaryWorkspace, temporaryCwd))
			throw new Error("Imported session cwd escapes the workspace");
		await access(temporaryCwd);
		const rewritten = rewritePiSession(
			await readFile(path.join(temporaryDirectory, "session.jsonl"), "utf8"),
			localCwd,
			extracted.manifest.session.sourceCwd,
		);

		report({ finishing: true, phase: "finishing_import" });
		const createdSessionPath = SessionManager.create(localCwd).getSessionFile();
		if (!createdSessionPath) throw new Error("Pi did not create a persistent target session");
		sessionPath = createdSessionPath;
		await writeFile(path.join(temporaryWorkspace, destinationMarkerName), `${ownerId}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		await input.state.recordCommitTargets(input.link, { destination, sessionPath });
		await rename(temporaryWorkspace, destination);
		destinationCommitted = true;
		const temporarySession = `${sessionPath}.${randomUUID()}.importing`;
		await writeFile(temporarySession, rewritten.content, { mode: 0o600, flag: "wx" });
		await rename(temporarySession, sessionPath);
		await input.state.complete(input.link, {
			destination,
			sessionPath,
			completedAt: new Date().toISOString(),
		});
		await rm(path.join(destination, destinationMarkerName), { force: true });
		await client.acknowledge(attempt.id, AbortSignal.timeout(30_000));
		await rm(temporaryDirectory, { recursive: true, force: true });
		return { destination, sessionPath, attemptId: attempt.id };
	} catch (error) {
		if (attempt && !progress.finishing) await client.cancel(attempt.id).catch(() => undefined);
		if (temporaryDirectory && !destinationCommitted) {
			await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
			if (sessionPath) await rm(sessionPath, { force: true }).catch(() => undefined);
			await input.state.discard(input.link).catch(() => undefined);
		}
		throw error;
	} finally {
		if (heartbeat) clearInterval(heartbeat);
	}
}
