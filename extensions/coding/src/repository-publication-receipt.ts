import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A local write-ahead receipt, not a replacement for the server-owned process state. @internal */
export interface RepositoryPublicationReceipt {
	branch: string;
	origin: string;
	pushOrigin: string;
	expectedHead: string | null;
	candidate: string;
	status: "attempting" | "accepted" | "rejected";
}

/** @internal */
export function readPublicationReceipt(gitDirectory: string): RepositoryPublicationReceipt | null {
	const file = join(gitDirectory, "leitwerk-publication.json");
	if (!existsSync(file)) return null;
	const value = JSON.parse(readFileSync(file, "utf8"));
	if (
		!value ||
		typeof value.branch !== "string" ||
		typeof value.origin !== "string" ||
		typeof value.pushOrigin !== "string" ||
		!["attempting", "accepted", "rejected"].includes(value.status) ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.candidate) ||
		!(value.expectedHead === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.expectedHead))
	)
		throw new Error("Invalid repository publication receipt; local work was retained");
	return value;
}

/** Persist intent before sending and acceptance before checking for subsequent remote movement. @internal */
export function savePublicationReceipt(
	gitDirectory: string,
	receipt: RepositoryPublicationReceipt,
): void {
	const file = join(gitDirectory, "leitwerk-publication.json");
	writeFileSync(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 });
	renameSync(`${file}.tmp`, file);
}

/** Porcelain rejection is proof of no write; transport failures are not. @internal */
export function pushWasRejected(porcelain: string): boolean {
	return porcelain.split("\n").some((line) => /^!\t[^\t]+\t\[(?:remote )?rejected\]/.test(line));
}
