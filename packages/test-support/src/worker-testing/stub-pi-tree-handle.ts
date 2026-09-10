import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@earendil-works/pi-coding-agent";
import type {
	PiCustomMessageInput,
	PiCustomTool,
	PiEvent,
	PiEventHandler,
	PiPromptOptions,
	PiRunDetails,
	PiSessionDiagnostic,
	PiSessionDiagnosticHandler,
	PiTreeEntry,
	PiTreeHandle,
	PiTreeNode,
	PiTurnExecutionResult,
} from "@leitwerk-dev/process-sdk";
import type {
	PiManagedBootstrapOptions,
	PiManagedBootstrapResult,
	PiTreeHandleFactory,
	PiTreeHandleOptions,
	PiTreePlanningOptions,
	PiTreePlanningSnapshot,
} from "@leitwerk-dev/worker";

export interface StubToolCallScriptCall {
	toolName: string;
	args: Record<string, unknown>;
	intermediateEntryCount?: number;
}

export type StubToolCallScriptItem =
	| StubToolCallScriptCall
	| {
			calls: readonly StubToolCallScriptCall[];
			textChunks?: readonly string[];
			thinkingChunks?: readonly string[];
			chunkDelayMs?: number;
	  };

export interface StubToolCallScriptResolverContext {
	promptText: string;
	tools: readonly PiCustomTool[];
	instanceId?: string;
	workspaceRoot?: string;
	sessionCwd?: string;
	treeFile: string;
	turnSequence: number;
}

export type StubToolCallScriptResolver = (
	context: StubToolCallScriptResolverContext,
) => StubToolCallScriptItem | undefined | Promise<StubToolCallScriptItem | undefined>;

function stringifyToolResult(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}
	if (result === undefined) {
		return "ok";
	}
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

function expandStubToolCallScriptItem(item: StubToolCallScriptItem): StubToolCallScriptCall[] {
	if ("calls" in item) {
		return [...item.calls];
	}
	return [item];
}

function stubToolCallId(turnSeq: number, totalCalls: number, index: number): string {
	if (totalCalls <= 1) {
		return `tool-${turnSeq}`;
	}
	return `tool-${turnSeq}-${index + 1}`;
}

interface StubPiTreeState {
	header?: SessionHeader;
	turnSeq: number;
	currentLeafId: string | null;
	entries: Map<string, PiTreeEntry>;
	childIdsByParent: Map<string | null, string[]>;
}

interface PersistedStubPiTreeState {
	turnSeq: number;
	currentLeafId: string | null;
	entries: PiTreeEntry[];
	childIdsByParent: Array<{ parentId: string | null; childIds: string[] }>;
}

function createEmptyStubPiTreeState(): StubPiTreeState {
	return {
		turnSeq: 0,
		currentLeafId: null,
		entries: new Map<string, PiTreeEntry>(),
		childIdsByParent: new Map<string | null, string[]>(),
	};
}

function deriveStubLeafIdFromEntries(state: StubPiTreeState): string | null {
	let leafId: string | null = null;
	for (const entryId of state.entries.keys()) {
		leafId = entryId;
	}
	return leafId;
}

function serializeStubPiTreeState(state: StubPiTreeState, recordSessionTrace: boolean): string {
	if (recordSessionTrace) {
		return `${[
			JSON.stringify({
				...state.header,
				stubState: { turnSeq: state.turnSeq, currentLeafId: state.currentLeafId },
			}),
			...[...state.entries.values()].map((entry) => JSON.stringify(entry)),
		].join("\n")}\n`;
	}
	const persisted: PersistedStubPiTreeState = {
		turnSeq: state.turnSeq,
		currentLeafId: state.currentLeafId,
		entries: [...state.entries.values()],
		childIdsByParent: [...state.childIdsByParent.entries()].map(([parentId, childIds]) => ({
			parentId,
			childIds: [...childIds],
		})),
	};
	return JSON.stringify(persisted);
}

function deserializeStubPiTreeState(value: string): StubPiTreeState {
	const lines = value.trim().split("\n");
	const header = JSON.parse(lines[0]) as SessionHeader & {
		stubState?: { turnSeq: number; currentLeafId: string | null };
	};
	if (header.type === "session") {
		const entries = lines
			.slice(1)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as PiTreeEntry);
		const state = createEmptyStubPiTreeState();
		state.header = header;
		state.turnSeq = header.stubState?.turnSeq ?? 0;
		state.currentLeafId = header.stubState?.currentLeafId ?? null;
		for (const entry of entries) {
			state.entries.set(entry.id, entry);
			const siblings = state.childIdsByParent.get(entry.parentId) ?? [];
			siblings.push(entry.id);
			state.childIdsByParent.set(entry.parentId, siblings);
		}
		return state;
	}
	const parsed = JSON.parse(value) as PersistedStubPiTreeState;
	return {
		turnSeq: typeof parsed.turnSeq === "number" ? parsed.turnSeq : 0,
		currentLeafId:
			typeof parsed.currentLeafId === "string" || parsed.currentLeafId === null
				? parsed.currentLeafId
				: null,
		entries: new Map((parsed.entries ?? []).map((entry) => [entry.id, entry])),
		childIdsByParent: new Map(
			(parsed.childIdsByParent ?? []).map((entry) => [entry.parentId, [...entry.childIds]]),
		),
	};
}

export class StubPiTreeHandle implements PiTreeHandle {
	readonly sessionId: string;
	readonly treeFile: string;
	readonly isResumed: boolean;

	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	beforeTurn?: (
		kind: "prompt" | "literal" | "custom" | "continue",
		options: PiPromptOptions | undefined,
		promptText: string | undefined,
	) => boolean | undefined | Promise<boolean | undefined>;

	private _closed = false;
	private turnAbort = new AbortController();
	private branchDriftPending = false;
	private readonly handlers = new Set<PiEventHandler>();
	private readonly diagnosticHandlers = new Set<PiSessionDiagnosticHandler>();
	private readonly toolCallScriptResolver?: StubToolCallScriptResolver;
	private readonly state: StubPiTreeState;
	private readonly runDetails: PiRunDetails;
	private readonly persistState?: (() => Promise<void>) | undefined;
	private readonly recordSessionTrace: boolean;

	constructor(options: {
		sessionId: string;
		treeFile: string;
		isResumed: boolean;
		toolCallScriptResolver?: StubToolCallScriptResolver;
		state?: StubPiTreeState;
		runDetails?: Partial<PiRunDetails>;
		persistState?: () => Promise<void>;
		recordSessionTrace?: boolean;
	}) {
		this.sessionId = options.sessionId;
		this.treeFile = options.treeFile;
		this.isResumed = options.isResumed;
		this.toolCallScriptResolver = options.toolCallScriptResolver;
		this.state = options.state ?? createEmptyStubPiTreeState();
		this.persistState = options.persistState;
		this.recordSessionTrace = options.recordSessionTrace ?? false;
		this.runDetails = {
			loadedAgentsFiles: options.runDetails?.loadedAgentsFiles?.map((file) => ({ ...file })) ?? [],
			loadedSkills: options.runDetails?.loadedSkills?.map((skill) => ({ ...skill })) ?? [],
			availableToolNames: [...(options.runDetails?.availableToolNames ?? [])],
		};
	}

	get closed(): boolean {
		return this._closed;
	}

	failNextTurnWithBranchDrift(): void {
		this.branchDriftPending = true;
	}

	private assertOpen(): void {
		if (this._closed) {
			throw new Error("Handle is closed");
		}
	}

	private addEntry(entry: PiTreeEntry): void {
		this.state.entries.set(entry.id, entry);
		const siblings = this.state.childIdsByParent.get(entry.parentId) ?? [];
		siblings.push(entry.id);
		this.state.childIdsByParent.set(entry.parentId, siblings);
		this.state.currentLeafId = entry.id;
	}

	private createMessageEntry(
		id: string,
		parentId: string | null,
		role: "user" | "assistant",
		content: unknown,
		timestamp: string,
	): PiTreeEntry {
		return {
			id,
			parentId,
			type: "message",
			timestamp,
			message: {
				role,
				content,
			},
		};
	}

	private emitEvent(event: PiEvent): void {
		for (const handler of this.handlers) {
			handler(event);
		}
	}

	getRunDetails(): PiRunDetails {
		return {
			loadedAgentsFiles: this.runDetails.loadedAgentsFiles.map((file) => ({ ...file })),
			loadedSkills: this.runDetails.loadedSkills.map((skill) => ({ ...skill })),
			availableToolNames: [...this.runDetails.availableToolNames],
		};
	}

	getLeafId(): string | null {
		return this.state.currentLeafId;
	}

	getEntry(id: string): PiTreeEntry | undefined {
		return this.state.entries.get(id);
	}

	getBranch(fromId: string | undefined = this.state.currentLeafId ?? undefined): PiTreeEntry[] {
		if (!fromId) {
			return [];
		}
		const branch: PiTreeEntry[] = [];
		let currentId: string | null = fromId;
		while (currentId) {
			const entry = this.state.entries.get(currentId);
			if (!entry) {
				break;
			}
			branch.push(entry);
			currentId = entry.parentId;
		}
		branch.reverse();
		return branch;
	}

	getChildren(parentId: string): PiTreeEntry[] {
		return (this.state.childIdsByParent.get(parentId) ?? [])
			.map((childId) => this.state.entries.get(childId))
			.filter((entry): entry is PiTreeEntry => entry !== undefined);
	}

	getTree(): PiTreeNode[] {
		const buildNode = (entry: PiTreeEntry): PiTreeNode => ({
			entry,
			children: this.getChildren(entry.id).map(buildNode),
		});
		return (this.state.childIdsByParent.get(null) ?? [])
			.map((entryId) => this.state.entries.get(entryId))
			.filter((entry): entry is PiTreeEntry => entry !== undefined)
			.map(buildNode);
	}

	async branch(entryId: string): Promise<void> {
		this.assertOpen();
		if (!this.state.entries.has(entryId)) {
			throw new Error(`Unknown Pi entry '${entryId}'`);
		}
		this.state.currentLeafId = entryId;
		await this.persistState?.();
	}

	async branchFromRoot(): Promise<void> {
		this.assertOpen();
		this.state.currentLeafId = null;
		await this.persistState?.();
	}

	async resetLeaf(): Promise<void> {
		await this.branchFromRoot();
	}

	async compact(_customInstructions?: string, details?: unknown): Promise<{ summary: string }> {
		this.assertOpen();
		const timestamp = new Date().toISOString();
		const compactionEntryId = `compaction-${++this.state.turnSeq}`;
		this.addEntry({
			id: compactionEntryId,
			parentId: this.state.currentLeafId,
			type: "compaction",
			timestamp,
			details,
		});
		await this.persistState?.();
		return { summary: "Stub compaction" };
	}

	private async executeTurn(input: {
		kind: "prompt" | "literal" | "custom" | "continue";
		promptText?: string;
		options?: PiPromptOptions;
		appendPromptUserMessage: boolean;
	}): Promise<PiTurnExecutionResult> {
		this.assertOpen();
		this.turnAbort = new AbortController();
		if ((await this.beforeTurn?.(input.kind, input.options, input.promptText)) === false) {
			input.options = undefined;
		}
		if (this.branchDriftPending) {
			this.branchDriftPending = false;
			throw Object.assign(new Error("stubbed Pi branch drift"), {
				name: "PiBranchDriftError",
				failureCode: "branch_drift",
				toTurnFailureOptions: () => ({
					failureCode: "branch_drift",
					failureDetails: { operation: input.kind },
					recoveryContext: null,
					restorePrimaryLeaf: false,
				}),
			});
		}
		if (input.promptText !== undefined) {
			this.prompts.push(input.promptText);
		}
		const startLeafId = this.state.currentLeafId;
		const turnId = `turn-${++this.state.turnSeq}`;
		const timestamp = new Date().toISOString();
		const createdEntryIds: string[] = [];
		if (input.appendPromptUserMessage) {
			const userEntryId = `user-${this.state.turnSeq}`;
			this.addEntry(
				this.createMessageEntry(
					userEntryId,
					this.state.currentLeafId,
					"user",
					input.promptText ?? "",
					timestamp,
				),
			);
			createdEntryIds.push(userEntryId);
		}
		await this.persistState?.();
		this.emitEvent({ type: "turn.start", turnId, data: {}, timestamp });

		const tools = new Map((input.options?.tools ?? []).map((tool) => [tool.name, tool]));
		let assistantContent = input.promptText ?? "Continued.";
		let assistantContentFromScriptedMarkdown = false;
		const scriptedItem = await this.toolCallScriptResolver?.({
			treeFile: this.treeFile,
			turnSequence: this.state.turnSeq,
			promptText: input.promptText ?? "",
			tools: input.options?.tools ?? [],
		});
		if (scriptedItem && "calls" in scriptedItem) {
			const streamed = { thinking: "", text: "" };
			const streamEntryId = `stream-${this.state.turnSeq}`;
			const streamParentId = this.state.currentLeafId;
			const chunks = [
				...(scriptedItem.thinkingChunks ?? []).map((text) => ({
					text,
					streamType: "thinking" as const,
				})),
				...(scriptedItem.textChunks ?? []).map((text) => ({ text, streamType: "text" as const })),
			];
			for (const { text, streamType } of chunks) {
				this.turnAbort.signal.throwIfAborted();
				streamed[streamType] += text;
				if (this.recordSessionTrace) {
					const entry = this.createMessageEntry(
						streamEntryId,
						streamParentId,
						"assistant",
						[
							...(streamed.thinking ? [{ type: "thinking", thinking: streamed.thinking }] : []),
							...(streamed.text ? [{ type: "text", text: streamed.text }] : []),
						],
						timestamp,
					);
					if (this.state.entries.has(streamEntryId)) this.state.entries.set(streamEntryId, entry);
					else {
						this.addEntry(entry);
						createdEntryIds.push(streamEntryId);
					}
					await this.persistState?.();
				}
				this.emitEvent({
					type: "stream.delta",
					turnId,
					data: { text, streamType },
					timestamp: new Date().toISOString(),
				});
				if (scriptedItem.chunkDelayMs)
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => {
							this.turnAbort.signal.removeEventListener("abort", abort);
							resolve();
						}, scriptedItem.chunkDelayMs);
						const abort = () => {
							clearTimeout(timer);
							reject(this.turnAbort.signal.reason);
						};
						this.turnAbort.signal.addEventListener("abort", abort, { once: true });
					});
			}
		}
		const scriptedCalls = scriptedItem ? expandStubToolCallScriptItem(scriptedItem) : [];
		if (scriptedCalls.length > 0) {
			for (const [callIndex, scriptedCall] of scriptedCalls.entries()) {
				const toolCallId = stubToolCallId(this.state.turnSeq, scriptedCalls.length, callIndex);
				this.emitEvent({
					type: "tool.call",
					turnId,
					data: {
						toolCallId,
						name: scriptedCall.toolName,
						arguments: scriptedCall.args,
					},
					timestamp,
				});
				const tool = tools.get(scriptedCall.toolName);
				if (!tool && scriptedCall.toolName === "markdown_result") {
					const markdown = (scriptedCall.args as { markdown?: unknown }).markdown;
					if (typeof markdown === "string") {
						assistantContent = markdown;
						assistantContentFromScriptedMarkdown = true;
					}
				}
				if (tool) {
					if (this.recordSessionTrace) {
						const entryId = `call-${toolCallId}`;
						this.addEntry(
							this.createMessageEntry(
								entryId,
								this.state.currentLeafId,
								"assistant",
								[
									{
										type: "toolCall",
										id: toolCallId,
										name: scriptedCall.toolName,
										arguments: scriptedCall.args,
									},
								],
								new Date().toISOString(),
							),
						);
						createdEntryIds.push(entryId);
						await this.persistState?.();
					}
					const recordToolResult = async (result: unknown, isError: boolean) => {
						if (!this.recordSessionTrace) return;
						const entryId = `result-${toolCallId}`;
						const entry = {
							id: entryId,
							parentId: this.state.currentLeafId,
							type: "message",
							timestamp: new Date().toISOString(),
							message: {
								role: "toolResult",
								toolCallId,
								toolName: scriptedCall.toolName,
								content: [{ type: "text", text: stringifyToolResult(result) }],
								isError,
							},
						};
						this.addEntry(entry);
						createdEntryIds.push(entryId);
						await this.persistState?.();
					};
					try {
						this.turnAbort.signal.throwIfAborted();
						const blocked = input.options?.shouldBlockToolCall?.(scriptedCall.toolName);
						if (blocked) throw new Error(blocked);
						const result = await tool.execute(scriptedCall.args, {
							toolCallId,
							signal: this.turnAbort.signal,
							suspendPromptGuards: input.options?.suspendPromptGuards,
						});
						if (!assistantContentFromScriptedMarkdown) {
							assistantContent = stringifyToolResult(result);
						}
						await recordToolResult(result, false);
						this.emitEvent({
							type: "tool.result",
							turnId,
							data: { toolCallId, name: scriptedCall.toolName, result },
							timestamp,
						});
					} catch (error) {
						await recordToolResult(error instanceof Error ? error.message : String(error), true);
						this.emitEvent({
							type: "error",
							turnId,
							data: {
								message: error instanceof Error ? error.message : String(error),
								toolName: scriptedCall.toolName,
							},
							timestamp,
						});
						throw error;
					}
				}
				for (let i = 0; i < (scriptedCall.intermediateEntryCount ?? 0); i++) {
					const intermediateEntryId =
						scriptedCalls.length === 1
							? `intermediate-${this.state.turnSeq}-${i + 1}`
							: `intermediate-${this.state.turnSeq}-${callIndex + 1}-${i + 1}`;
					this.addEntry(
						this.createMessageEntry(
							intermediateEntryId,
							this.state.currentLeafId,
							"assistant",
							`Intermediate entry ${i + 1}`,
							timestamp,
						),
					);
					createdEntryIds.push(intermediateEntryId);
				}
			}
		} else if (tools.size > 0) {
			throw new Error(
				`Stub Pi prompt requires a stub tool-call script when tools are provided (${[...tools.keys()].join(", ")})`,
			);
		} else if (input.promptText !== undefined) {
			this.emitEvent({
				type: "stream.delta",
				turnId,
				data: { text: input.promptText },
				timestamp,
			});
		}

		this.addEntry(
			this.createMessageEntry(
				turnId,
				this.state.currentLeafId,
				"assistant",
				assistantContent,
				timestamp,
			),
		);
		createdEntryIds.push(turnId);
		await this.persistState?.();
		this.emitEvent({ type: "turn.end", turnId, data: {}, timestamp });
		const resultEntryId = this.state.currentLeafId;
		if (!resultEntryId) {
			throw new Error(
				input.appendPromptUserMessage
					? "Stub Pi prompt completed without an active leaf"
					: "Stub Pi continuation completed without an active leaf",
			);
		}
		return {
			startLeafId,
			endLeafId: resultEntryId,
			createdEntryIds,
			resultEntryId,
			assistantMarkdown: assistantContent,
		};
	}

	async prompt(text: string, options: PiPromptOptions = {}): Promise<PiTurnExecutionResult> {
		return await this.executeTurn({
			kind: "prompt",
			promptText: text,
			options,
			appendPromptUserMessage: true,
		});
	}

	async promptLiteral(text: string, options: PiPromptOptions = {}): Promise<PiTurnExecutionResult> {
		return await this.executeTurn({
			kind: "literal",
			promptText: text,
			options,
			appendPromptUserMessage: true,
		});
	}

	async promptCustom(
		input: PiCustomMessageInput,
		options: PiPromptOptions = {},
	): Promise<PiTurnExecutionResult> {
		const startLeafId = this.getLeafId();
		const promptEntryId = await this.appendCustomMessage(input);
		const result = await this.executeTurn({
			kind: "custom",
			options,
			appendPromptUserMessage: false,
		});
		return {
			...result,
			startLeafId,
			createdEntryIds: [promptEntryId, ...result.createdEntryIds],
		};
	}

	async continueTurn(options: PiPromptOptions = {}): Promise<PiTurnExecutionResult> {
		return await this.executeTurn({
			kind: "continue",
			options,
			appendPromptUserMessage: false,
		});
	}

	async appendUserMessage(text: string): Promise<string> {
		this.assertOpen();
		const timestamp = new Date().toISOString();
		const userEntryId = `user-${++this.state.turnSeq}`;
		this.addEntry(
			this.createMessageEntry(userEntryId, this.state.currentLeafId, "user", text, timestamp),
		);
		await this.persistState?.();
		return userEntryId;
	}

	async appendCustomMessage(input: PiCustomMessageInput): Promise<string> {
		this.assertOpen();
		const timestamp = new Date().toISOString();
		const entryId = `custom-${++this.state.turnSeq}`;
		this.addEntry({
			id: entryId,
			parentId: this.state.currentLeafId,
			type: "custom_message",
			timestamp,
			customType: "leitwerk",
			content: input.content,
			details: input.details,
		});
		await this.persistState?.();
		return entryId;
	}

	async steer(text: string): Promise<void> {
		this.assertOpen();
		this.steers.push(text);
	}

	async abortTurn(): Promise<void> {
		this.assertOpen();
		this.turnAbort.abort(new Error("Scripted turn aborted"));
	}

	subscribe(handler: PiEventHandler): () => void {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}

	subscribeDiagnostics(handler: PiSessionDiagnosticHandler): () => void {
		this.diagnosticHandlers.add(handler);
		return () => {
			this.diagnosticHandlers.delete(handler);
		};
	}

	emitDiagnostic(diagnostic: PiSessionDiagnostic): void {
		for (const handler of this.diagnosticHandlers) handler(diagnostic);
	}

	async close(): Promise<void> {
		this.turnAbort.abort(new Error("Scripted session closed"));
		await this.persistState?.();
		this._closed = true;
		this.handlers.clear();
		this.diagnosticHandlers.clear();
	}
}

export interface StubPiTreeHandleFactoryOptions {
	toolCallScriptResolver?: StubToolCallScriptResolver;
	/** Persist SDK-readable JSONL with reasoning and tool messages for history/detail tests. */
	recordSessionTrace?: boolean;
}

export class StubPiTreeHandleFactory implements PiTreeHandleFactory {
	readonly sessions: StubPiTreeHandle[] = [];
	toolCallScriptResolver?: StubToolCallScriptResolver;

	private seq = 0;
	private readonly treeStateByFile = new Map<string, StubPiTreeState>();
	private readonly recordSessionTrace: boolean;

	constructor(options: StubPiTreeHandleFactoryOptions = {}) {
		this.toolCallScriptResolver = options.toolCallScriptResolver;
		this.recordSessionTrace = options.recordSessionTrace ?? false;
	}

	async prepareManagedBootstrap(
		opts: PiManagedBootstrapOptions,
	): Promise<PiManagedBootstrapResult> {
		return {
			loadedResourceIds: opts.manifest.provenance.map(
				(resource: { snapshotPath: string }) => resource.snapshotPath,
			),
			loadedAgentsFiles: [],
			loadedSkillFiles: [],
			resolvedModel: { ...opts.expectedModel },
			diagnostics: [],
		};
	}

	async inspectPrimaryTree(opts: PiTreePlanningOptions): Promise<PiTreePlanningSnapshot> {
		let treeState = this.treeStateByFile.get(opts.treeFile);
		if (!treeState) {
			try {
				treeState = deserializeStubPiTreeState(readFileSync(opts.treeFile, "utf8"));
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					(error as { code?: unknown }).code === "ENOENT"
				) {
					return { currentLeafId: null, entries: [] };
				}
				throw error;
			}
		}
		return {
			currentLeafId: treeState.currentLeafId ?? deriveStubLeafIdFromEntries(treeState),
			entries: [...treeState.entries.values()].map((entry) => ({
				id: entry.id,
				parentId: entry.parentId,
			})),
		};
	}

	async createPrimaryTreeHandle(opts: PiTreeHandleOptions): Promise<PiTreeHandle> {
		const persistState = async (state: StubPiTreeState): Promise<void> => {
			this.treeStateByFile.set(opts.treeFile, state);
			try {
				mkdirSync(path.dirname(opts.treeFile), { recursive: true });
				writeFileSync(
					opts.treeFile,
					serializeStubPiTreeState(state, this.recordSessionTrace),
					"utf8",
				);
			} catch (error) {
				if (
					typeof error !== "object" ||
					error === null ||
					!("code" in error) ||
					!["ENOENT", "EACCES", "EROFS", "EPERM"].includes(
						String((error as { code?: unknown }).code),
					)
				) {
					throw error;
				}
			}
		};
		let treeState = this.treeStateByFile.get(opts.treeFile);
		if (!treeState && opts.resume) {
			try {
				const persisted = readFileSync(opts.treeFile, "utf8");
				treeState = deserializeStubPiTreeState(persisted);
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					(error as { code?: unknown }).code !== "ENOENT"
				) {
					throw error;
				}
			}
		}
		treeState ??= createEmptyStubPiTreeState();
		treeState.header ??= {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: opts.sessionCwd ?? opts.workspaceRoot ?? path.dirname(opts.treeFile),
		};
		if (opts.resume) {
			treeState.currentLeafId = deriveStubLeafIdFromEntries(treeState);
		}
		this.treeStateByFile.set(opts.treeFile, treeState);
		const piHandle = new StubPiTreeHandle({
			sessionId: `stub-${++this.seq}`,
			treeFile: opts.treeFile,
			isResumed: opts.resume,
			toolCallScriptResolver: this.toolCallScriptResolver
				? (context) =>
						this.toolCallScriptResolver?.({
							...context,
							instanceId: opts.instanceId,
							workspaceRoot: opts.workspaceRoot,
							sessionCwd: opts.sessionCwd,
						})
				: undefined,
			state: treeState,
			persistState: () => persistState(treeState),
			recordSessionTrace: this.recordSessionTrace,
			runDetails: {
				availableToolNames: opts.piConfig?.availableToolNames ?? [],
			},
		});
		this.sessions.push(piHandle);
		if (!opts.resume) {
			await persistState(treeState);
		}
		return piHandle;
	}
}
