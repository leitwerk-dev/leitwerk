import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRecord } from "./repository-record.js";

/** @internal */
export interface RepositoryBinding {
	branch: string;
	origin: string;
	pushOrigin: string;
}

/** @internal */
export function readRepositoryBinding(
	git: (...args: string[]) => string,
	branch: string,
): RepositoryBinding {
	return {
		branch,
		origin: git("remote", "get-url", "origin"),
		pushOrigin: git("remote", "get-url", "--push", "--all", "origin"),
	};
}

/** @internal */
export function repositoryBindingMatches(
	record: RepositoryBinding | null,
	binding: RepositoryBinding,
): boolean {
	return (
		!record ||
		(record.branch === binding.branch &&
			record.origin === binding.origin &&
			record.pushOrigin === binding.pushOrigin)
	);
}

/** A local write-ahead receipt, not a replacement for the server-owned process state. @internal */
export interface RepositoryPublicationReceipt extends RepositoryBinding {
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
export const savePublicationReceipt = (
	gitDirectory: string,
	receipt: RepositoryPublicationReceipt,
) => repositoryRecord(gitDirectory, "publication").save(receipt);

/** Porcelain rejection is proof of no write; transport failures are not. @internal */
export function pushWasRejected(porcelain: string): boolean {
	return porcelain.split("\n").some((line) => /^!\t[^\t]+\t\[(?:remote )?rejected\]/.test(line));
}
