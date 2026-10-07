import { type Actor, asUnknownRecord } from "@leitwerk-dev/domain";

/** @internal */
export interface WikiTopic {
	/** @internal */ id: string;
	/** @internal */ key: string;
	/** @internal */ title: string;
	/** @internal */ url: string;
	/** @internal */ sourceRevision: string;
	/** @internal */ revision?: number;
	/** @internal */ deleted?: boolean;
	/** @internal */ deletion?: {
		/** @internal */ actor: string;
		/** @internal */ turnRecordId: string;
		/** @internal */ at: string;
	};
}

/** @internal */
export interface WikiEvidence {
	/** @internal */ repository: string;
	/** @internal */ revision: string;
	/** @internal */ path: string;
	/** @internal */ observation: string;
}

/** @internal */
export interface WikiPage {
	/** @internal */ id: string;
	/** @internal */ topicId: string;
	/** @internal */ revision: number;
	/** @internal */ title: string;
	/** @internal */ markdown: string;
	/** @internal */ applicability: string;
	/** @internal */ status: "proposed" | "observed" | "validated" | "needs_revalidation";
	/** @internal */ evidence: WikiEvidence[];
	/** @internal */ links: string[];
	/** @internal */ sourceRevision: string;
	/** @internal */ instanceId: string;
	/** @internal */ turnRecordId: string;
	/** @internal */ updatedAt: string;
	/** @internal */ updatedBy?: Actor;
	/** @internal */ deleted: boolean;
}

/** @internal */
export type WikiPageContent = Pick<
	WikiPage,
	"title" | "markdown" | "applicability" | "status" | "evidence" | "links"
>;

/** @internal */
export function isWikiPageId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
}

/** Validates browser and agent contributions against the same evidence contract. @internal */
export function parseWikiPageContent(value: unknown): WikiPageContent {
	const input = asUnknownRecord(value);
	if (!input) throw new Error("Provide wiki entry content");
	const text = (record: Record<string, unknown>, key: string): string => {
		const value = record[key];
		if (typeof value !== "string" || !value.trim())
			throw new Error(`Wiki ${key} must not be empty`);
		return value;
	};
	if (!["proposed", "observed", "validated", "needs_revalidation"].includes(String(input.status)))
		throw new Error("Invalid wiki evidence status");
	if (!Array.isArray(input.evidence) || input.evidence.length === 0)
		throw new Error("Wiki contributions require evidence");
	const evidence = input.evidence.map((value): WikiEvidence => {
		const record = asUnknownRecord(value);
		if (!record) throw new Error("Invalid wiki evidence");
		const revision = text(record, "revision");
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision))
			throw new Error(
				"Wiki evidence requires the inspected repository commit SHA (40 or 64 hexadecimal characters)",
			);
		return {
			repository: text(record, "repository"),
			revision,
			path: text(record, "path"),
			observation: text(record, "observation"),
		};
	});
	if (!Array.isArray(input.links) || input.links.some((link) => !isWikiPageId(link)))
		throw new Error("Wiki links must be page IDs");
	return {
		title: text(input, "title"),
		markdown: text(input, "markdown"),
		applicability: text(input, "applicability"),
		status: input.status as WikiPage["status"],
		evidence,
		links: input.links as string[],
	};
}
