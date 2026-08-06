import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

function safeSegment(value: string, name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		throw new Error(`Invalid managed Pi ${name}`);
	}
	return value;
}

export function resolveManagedPiAgentDir(input: {
	agentDirRoot: string;
	instanceId: string;
	startOrLeaseId: string;
}): string {
	const root = path.resolve(input.agentDirRoot);
	const ambient = path.resolve(homedir(), ".pi", "agent");
	if (root === ambient)
		throw new Error("Managed Pi agent directory must not be ambient ~/.pi/agent");
	return path.join(
		root,
		safeSegment(input.instanceId, "instance id"),
		safeSegment(input.startOrLeaseId, "start id"),
	);
}

export function normalizeManagedPiCredentialPath(value: string): string {
	if (!value || path.posix.isAbsolute(value) || value.includes("\\")) {
		throw new Error(`Invalid credential file path '${value}'`);
	}
	const normalized = path.posix.normalize(value);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new Error(`Invalid credential file path '${value}'`);
	}
	return normalized;
}

async function assertNoSymlinkParents(root: string, target: string): Promise<void> {
	let current = root;
	for (const part of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Credential parent is a symlink: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await mkdir(current, { recursive: false, mode: 0o700 });
		}
	}
}

export interface DeclaredCredentialFile {
	path: string;
	content: string | Uint8Array;
}

/** Atomically writes declared credential files inside an existing managed directory. */
export async function writeManagedPiCredentialFiles(
	agentDir: string,
	files: readonly DeclaredCredentialFile[],
): Promise<void> {
	const root = path.resolve(agentDir);
	if ((await lstat(root)).isSymbolicLink()) {
		throw new Error(`Managed Pi directory is a symlink: ${root}`);
	}
	const seen = new Set<string>();
	for (const file of files) {
		const relative = normalizeManagedPiCredentialPath(file.path);
		if (seen.has(relative)) throw new Error(`Duplicate credential file path '${relative}'`);
		seen.add(relative);
		const target = path.resolve(root, relative);
		if (!target.startsWith(`${root}${path.sep}`))
			throw new Error(`Credential path escapes managed directory: ${relative}`);
		await assertNoSymlinkParents(root, target);
		const tmp = path.join(
			path.dirname(target),
			`.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`,
		);
		await writeFile(tmp, file.content, { mode: 0o600, flag: "wx" });
		await chmod(tmp, 0o600);
		await rename(tmp, target);
		await chmod(target, 0o600);
	}
}
