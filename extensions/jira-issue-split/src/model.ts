import { asUnknownRecord } from "@leitwerk-dev/domain";
import { type JiraIssue, jiraIsEpic, ticketDescriptionMarkdown } from "@leitwerk-dev/jira";
import {
	type Codec,
	createEmptyStructuralProcessState,
	type StructuralProcessState,
	stringArg,
} from "@leitwerk-dev/process-sdk";

/** @internal */
export interface SplitRepository {
	/** @internal */ key: string;
	/** @internal */ name: string;
	/** @internal */ projectId: number;
	/** @internal */ origin: string;
	/** @internal */ repoLocator: string;
	/** @internal */ baseBranch: string;
}

/** @internal */
export interface SplitParams {
	/** @internal */ jiraProfile: string;
	/** @internal */ jiraBaseUrl: string;
	/** @internal */ gitlabProfile: string;
	/** @internal */ sshProfile: string;
	/** @internal */ epic: JiraIssue;
	/** @internal */ topicId: string;
	/** @internal */ repositories: SplitRepository[];
	/** @internal */ issueType: "Story" | "Task" | "Sub-task";
	/** @internal */ subtaskType?: {
		/** @internal */ id: string;
		/** @internal */ name: string;
	};
	/** @internal */ labels: string[];
}

/** @internal */
export interface SplitDraft {
	/** @internal */ repositoryKey: string;
	/** @internal */ verdict: "applicable" | "not_applicable" | "already_compliant" | "unresolved";
	/** @internal */ reason: string;
	/** @internal */ evidence: string;
	/** @internal */ revision: string;
	/** @internal */ summary: string;
	/** @internal */ description: string;
	/** @internal */ issueType: SplitParams["issueType"];
	/** @internal */ componentIds: string[];
	/** @internal */ mappingRevision: string;
	/** @internal */ blocked: string | null;
	/** @internal */ excluded: boolean;
	/** @internal */
	receipt?: {
		/** @internal */
		id: string;
		/** @internal */
		key: string;
		/** @internal */
		url: string;
	};
}

/** @internal */
export interface SplitState extends StructuralProcessState {
	/** @internal */ candidates: string[];
	/** @internal */ drafts: SplitDraft[];
	/** @internal */ approved: string[];
	/** @internal */ labels: string[];
	/** @internal */ feedback: string;
	/** @internal */ epicRevision: string;
	/** @internal */ epic: JiraIssue | null;
}

/** @internal */
export function initialSplitState(params: SplitParams): SplitState {
	return {
		...createEmptyStructuralProcessState(),
		candidates: [],
		drafts: [],
		approved: [],
		labels: params.labels,
		feedback: "",
		epicRevision: "",
		epic: null,
	};
}

/** @internal */
export function parseDraft(value: unknown, params?: SplitParams): SplitDraft {
	const record = asUnknownRecord(value);
	if (
		!record ||
		!["applicable", "not_applicable", "already_compliant", "unresolved"].includes(
			String(record.verdict),
		) ||
		!["Story", "Task", "Sub-task"].includes(String(record.issueType))
	)
		throw new Error("Invalid repository assessment");
	const draft = {
		repositoryKey: stringArg(record, "repositoryKey"),
		verdict: record.verdict as SplitDraft["verdict"],
		reason: stringArg(record, "reason"),
		evidence: stringArg(record, "evidence"),
		revision: typeof record.revision === "string" ? record.revision : "",
		summary: typeof record.summary === "string" ? record.summary : "",
		description: typeof record.description === "string" ? record.description : "",
		issueType: record.issueType as SplitParams["issueType"],
		componentIds: [] as string[],
		mappingRevision: "",
		blocked: null,
		excluded: false,
	};
	if (
		draft.verdict === "applicable" &&
		(!draft.summary.trim() ||
			!draft.description.trim() ||
			!/^[a-f0-9]{40,64}$/i.test(draft.revision))
	)
		throw new Error("Applicable repositories require a ticket draft and inspected commit ID");
	if (params && (draft.issueType === "Sub-task") !== Boolean(params.subtaskType))
		throw new Error("Ticket type does not match the source issue's child relationship");
	return draft;
}

/** @internal */
export const splitParamsCodec: Codec<SplitParams> = {
	parse(value) {
		const record = asUnknownRecord(value);
		if (
			!record ||
			!Array.isArray(record.repositories) ||
			!asUnknownRecord(record.epic) ||
			!["Story", "Task", "Sub-task"].includes(String(record.issueType)) ||
			!Array.isArray(record.labels) ||
			record.labels.some((label) => typeof label !== "string")
		)
			throw new Error("Invalid issue split snapshot");
		if (!jiraIsEpic(record.epic as JiraIssue)) {
			const subtaskType = asUnknownRecord(record.subtaskType);
			if (!subtaskType || record.issueType !== "Sub-task")
				throw new Error("Issue split requires a retained subtask type");
			stringArg(subtaskType, "id");
			stringArg(subtaskType, "name");
		} else if (record.issueType === "Sub-task") {
			throw new Error("Epic children must be Stories or Tasks");
		}
		for (const key of ["jiraProfile", "jiraBaseUrl", "gitlabProfile", "sshProfile", "topicId"])
			stringArg(record, key);
		for (const candidate of record.repositories) {
			const repository = asUnknownRecord(candidate);
			if (
				!repository ||
				!Number.isSafeInteger(repository.projectId) ||
				Number(repository.projectId) < 1
			)
				throw new Error("Invalid split repository");
			for (const key of ["key", "name", "origin"]) stringArg(repository, key);
			if (typeof repository.repoLocator !== "string" || typeof repository.baseBranch !== "string")
				throw new Error("Invalid repository checkout binding");
		}
		if (
			new Set(record.repositories.map((repository) => repository.key)).size !==
			record.repositories.length
		)
			throw new Error("Duplicate split repository");
		return record as unknown as SplitParams;
	},
	serialize: (value) => value,
};

/** @internal */
export const splitStateCodec: Codec<SplitState> = {
	parse(value) {
		const record = asUnknownRecord(value);
		if (
			!record ||
			!Array.isArray(record.drafts) ||
			!Array.isArray(record.candidates) ||
			!Array.isArray(record.approved) ||
			!Array.isArray(record.labels) ||
			typeof record.epicRevision !== "string"
		)
			throw new Error("Invalid issue split state");
		for (const values of [record.candidates, record.approved, record.labels])
			if (
				values.some((value) => typeof value !== "string") ||
				new Set(values).size !== values.length
			)
				throw new Error("Invalid split selection");
		for (const value of record.drafts) {
			parseDraft(value);
			if (
				!Array.isArray(value.componentIds) ||
				value.componentIds.some((id: unknown) => typeof id !== "string") ||
				typeof value.mappingRevision !== "string" ||
				typeof value.excluded !== "boolean" ||
				(value.blocked !== null && typeof value.blocked !== "string")
			)
				throw new Error("Invalid persisted split draft");
			if (value.receipt) for (const key of ["id", "key", "url"]) stringArg(value.receipt, key);
		}
		const drafts = record.drafts;
		if (
			new Set(drafts.map((draft) => draft.repositoryKey)).size !== drafts.length ||
			record.approved.some((key) => !drafts.some((draft) => draft.repositoryKey === key))
		)
			throw new Error("Invalid approved split drafts");
		return record as unknown as SplitState;
	},
	serialize: (value) => value,
};

/** @internal */
export function splitTicketDescription(
	params: SplitParams,
	repository: SplitRepository,
	draft: SplitDraft,
): string {
	return ticketDescriptionMarkdown(draft.description, {
		repositoryName: repository.name,
		repositoryUrl: `${repository.origin.replace(/\/$/, "")}/${repository.name.split("/").map(encodeURIComponent).join("/")}`,
		sourceKey: params.epic.key,
		sourceUrl: `${params.jiraBaseUrl.replace(/\/$/, "")}/browse/${encodeURIComponent(params.epic.key)}`,
	});
}

/** @internal */
export function batchMarkdown(params: SplitParams, state: SplitState): string {
	return `# ${params.epic.key}: repository tickets\n\n[Shared solution wiki](/wiki/${params.topicId})\n\n${params.subtaskType ? `Subtask type: ${params.subtaskType.name} (${params.subtaskType.id}).\n\n` : ""}Labels selected for new tickets: ${state.labels.join(", ") || "none"}.\n\n${state.drafts
		.map((draft) => {
			const repository = params.repositories.find(
				(candidate) => candidate.key === draft.repositoryKey,
			);
			return `## ${repository?.name ?? draft.repositoryKey}\n\n${draft.receipt ? `[${draft.receipt.key}](${draft.receipt.url}) — published` : draft.excluded ? "Excluded by operator" : `${draft.verdict}${draft.blocked ? ` — BLOCKED: ${draft.blocked}` : ""}`}\n\n${draft.reason}\n\n${draft.summary ? `### ${draft.issueType}: ${draft.summary}\n\n${repository ? splitTicketDescription(params, repository, draft) : draft.description}\n\nComponents: ${draft.componentIds.join(", ") || "mapping required"}\n\n` : ""}### Inspection evidence\n\n${draft.evidence}\n\nInspected revision: ${draft.revision || "unavailable"}`;
		})
		.join("\n\n")}`;
}
