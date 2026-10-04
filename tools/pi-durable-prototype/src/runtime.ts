// biome-ignore-all lint/style/noNonNullAssertion: This throwaway fixture requires identities established by preceding operations and assertions.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	GenerationTask,
	Harness,
	hook,
	type JsonObject,
	section,
	type ToolRegistration,
	ToolTask,
	wrapTool,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { TurnOutcomePayload } from "@leitwerk-dev/domain";
import { LeitwerkProcess, RESOURCE_TEXT } from "./leitwerk.ts";
import { RemoteWorker, remoteEnvironment } from "./remote-env.ts";
import { SecretBoundary } from "./secrets.ts";

export interface RuntimeConfig {
	directory: string;
	workspace: string;
	workerName: string;
	providerUrl: string;
	modelCredential: string;
	externalCredential: string;
	fault?: string;
}
type Binding = {
	turnRecordId: string;
	startId: string;
	turnId: string;
	resourceDigest: string;
	instructions: string;
	allowedTools: string[];
	outcome: string | null;
	submissionId: number | null;
	published: boolean;
};
const BindingDoc = defineDoc<Binding>({
	kind: "leitwerk.prototype.binding",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "initial",
	initial: () => ({
		turnRecordId: "",
		startId: "",
		turnId: "",
		resourceDigest: "",
		instructions: "",
		allowedTools: [],
		outcome: null,
		submissionId: null,
		published: false,
	}),
});
const RunIndex = defineDoc<{
	conversations: Record<string, number>;
	primaryId: number;
	primaryLeaf: number | null;
	receipts: Record<
		string,
		{ payload: string; answer: number; published: boolean; discarded?: boolean }
	>;
}>({
	kind: "leitwerk.prototype.index",
	version: 1,
	scope: "session",
	initial: () => ({ conversations: {}, primaryId: 0, primaryLeaf: null, receipts: {} }),
});

/** Server-owned harness. Only remoteEnvironment crosses into the container. @internal */
export class PrototypeRuntime {
	readonly boundary: SecretBoundary;
	readonly core: LeitwerkProcess;
	readonly worker: RemoteWorker;
	harness!: Harness;
	private workerAllowed = true;
	private extension!: Extension;
	private tools: ToolRegistration[] = [];
	private preparation: Promise<{ conversationId: number; turnRecordId: string }> | undefined;
	private readonly digest = createHash("sha256").update(RESOURCE_TEXT).digest("hex");
	private readonly watches = new Map<string, Awaited<ReturnType<Conversation["watch"]>>>();
	constructor(
		readonly config: RuntimeConfig,
		private readonly emit: (type: string, data: unknown) => void,
	) {
		mkdirSync(config.directory, { recursive: true });
		this.boundary = new SecretBoundary([config.modelCredential, config.externalCredential]);
		this.core = new LeitwerkProcess(config.directory, this.digest);
		this.worker = new RemoteWorker({
			name: config.workerName,
			workspace: config.workspace,
			auditFile: path.join(config.directory, "worker-wire.jsonl"),
			boundary: this.boundary,
			authorize: () => {
				if (!this.workerAllowed) throw new Error("Worker lease revoked");
			},
		});
	}
	async open(): Promise<void> {
		await this.worker.start();
		const raw = remoteEnvironment(this.worker);
		if (!getOrThrow(await raw.exists("/workspace/repo/.git", context))) {
			getOrThrow(
				await raw.exec(
					"git clone /workspace/seed.bundle /workspace/repo",
					{ cwd: "/workspace" },
					context,
				),
			);
		}
		await this.core.start();
		const models = createModels();
		const faux = fauxProvider({
			provider: "prototype",
			models: [{ id: "fake-model", contextWindow: 32768, maxTokens: 4096 }],
			tokensPerSecond: 2000,
		});
		// The deterministic provider goes through a credentialed HTTP boundary too;
		// only this server process can authenticate. No secret enters model context.
		const respond: Parameters<typeof faux.setResponses>[0][number] = async (request, options) => {
			faux.appendResponses([respond]);
			const match = [
				...JSON.stringify(request.messages.filter((m) => m.role === "system")).matchAll(
					/leitwerk-turn:([a-zA-Z0-9_-]+)/g,
				),
			].at(-1);
			this.core.assertCurrent(match?.[1] ?? "");
			this.boundary.assertPublic(request);
			const response = await fetch(`${this.config.providerUrl}/model`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.config.modelCredential}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
				signal: options?.signal,
			});
			if (!response.ok) throw new Error("Model provider request failed");
			await this.fault("during_model", options?.signal);
			const result = (await response.json()) as {
				content: string;
				toolCalls?: { name: string; arguments: Record<string, unknown> }[];
			};
			this.boundary.assertPublic(result);
			const blocks = result.toolCalls?.map((call) =>
				fauxToolCall(call.name, call.arguments as JsonObject),
			);
			return fauxAssistantMessage(blocks?.length ? blocks : result.content, {
				stopReason: blocks?.length ? "toolUse" : "stop",
			});
		};
		faux.setResponses([respond]);
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install(CodingTools);
		const createTicket = defineTool({
			name: "create_ticket",
			description: "Create one ticket through the server",
			replay: "safe",
			parameters: Type.Object({ title: Type.String() }),
			execute: async (args, api, ctx) => {
				const binding = await this.authorize(api.conversationId, "create_ticket");
				const key = `${binding.turnRecordId}:ticket`;
				const result = await this.core.externalWrites().ensure(
					{ writeType: "prototype_ticket", dedupKey: key },
					{
						reconcile: async () => {
							const response = await this.external(`/tickets/${encodeURIComponent(key)}`);
							return response.status === 404 ? null : this.publicTicket(await response.json());
						},
						execute: async () => {
							const response = await this.external("/tickets", {
								method: "POST",
								body: JSON.stringify({ key, title: args.title }),
							});
							const ticket = this.publicTicket(await response.json());
							await this.fault("after_external_effect", ctx.abortSignal);
							return ticket;
						},
						toMetadata: (ticket) => ticket,
					},
				);
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			},
		});
		const hold = defineTool({
			name: "unsafe_action",
			description: "Run an intentionally non-replayable local operation",
			parameters: Type.Object({}),
			execute: async (_args, api, ctx) => {
				await this.authorize(api.conversationId, "unsafe_action");
				getOrThrow(
					await api.env!.exec("printf 'unsafe-effect\\n' >> unsafe-effects.txt", undefined, ctx),
				);
				await this.fault("during_unsafe_tool", ctx.abortSignal);
				return { content: [{ type: "text", text: "Unsafe effect finished" }] };
			},
		});
		const finish = defineTool({
			name: "finish",
			description: "Record the result, then acknowledge completion in a final answer",
			replay: "safe",
			parameters: Type.Object({ markdown: Type.String() }),
			execute: async (args, api, ctx) => {
				await this.authorize(api.conversationId, "finish");
				if (!args.markdown.trim()) throw new Error("A nonempty result is required");
				this.boundary.assertPublic(args);
				await api.commit(async (tx) => {
					const binding = await tx.doc(BindingDoc, api.conversationId);
					if (binding.outcome !== null && binding.outcome !== args.markdown)
						throw new Error("Conflicting outcome");
					binding.outcome = args.markdown;
				}, ctx);
				return {
					content: [
						{
							type: "text",
							text: "Outcome accepted. Give a brief final acknowledgement without further tool calls.",
						},
					],
				};
			},
		});
		this.extension = defineExtension({
			name: "leitwerk",
			tools: [createTicket, hold, finish],
			sections: [
				section("managed", async (input) => {
					const b = await this.authorize(input.conversationId);
					return `leitwerk-turn:${b.turnRecordId}\n${b.instructions}`;
				}),
			],
			wraps: (CodingTools.tools as readonly ToolRegistration[]).map((tool) =>
				wrapTool(tool, (original) => ({
					...original,
					execute: async (args, api, ctx) => {
						await this.authorize(api.conversationId, original.name);
						return original.execute(args, api, ctx);
					},
				})),
			),
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async (request, api) => {
						await this.authorize(api.conversationId);
						this.boundary.assertPublic(request);
					},
				}),
				hook(ToolTask, {
					beforeTool: async (call, api) => {
						const binding = await this.authorize(api.conversationId, call.name);
						if (binding.outcome !== null)
							return { block: "Outcome already accepted; give a final acknowledgement" };
						return undefined;
					},
				}),
			],
		});
		registry.install(this.extension);
		this.tools = [...CodingTools.tools!, createTicket, hold, finish];
		this.harness = await Harness.open(
			await openNodeSqliteStorage(path.join(this.config.directory, "durable.sqlite")),
			{
				models,
				registry,
				settings: { toolExecution: "sequential", retry: { maxRetries: 0 } },
				env: async ({ conversationId }) => {
					const binding = await this.authorize(conversationId);
					return remoteEnvironment(this.worker, () =>
						this.core.assertCurrent(binding.turnRecordId),
					);
				},
				onReport: (report) => {
					this.boundary.assertPublic(report);
					this.emit("report", report);
				},
			},
			context,
		);
		await this.reconcile();
	}
	private publicTicket(value: unknown): { id: string; title: string } {
		this.boundary.assertPublic(value);
		if (!value || typeof value !== "object" || !("id" in value) || !("title" in value))
			throw new Error("Invalid integration response");
		return { id: String(value.id), title: String(value.title) };
	}
	private async external(route: string, options: RequestInit = {}): Promise<Response> {
		const response = await fetch(`${this.config.providerUrl}${route}`, {
			...options,
			headers: {
				authorization: `Bearer ${this.config.externalCredential}`,
				"content-type": "application/json",
			},
		});
		if (!response.ok && response.status !== 404) throw new Error("External request failed");
		return response;
	}
	private async authorize(conversationId: ConversationId, tool?: string): Promise<Binding> {
		const binding = await this.harness.snapshot(BindingDoc, conversationId, context);
		if (!binding) throw new Error("Conversation has no accepted execution");
		this.core.assertCurrent(binding.turnRecordId);
		if (binding.resourceDigest !== this.digest)
			throw new Error("Managed resource snapshot changed");
		if (tool && !binding.allowedTools.includes(tool))
			throw new Error("Tool not authorized for this turn");
		return binding;
	}
	private async fault(name: string, signal?: AbortSignal): Promise<void> {
		if (this.config.fault !== name) return;
		this.emit("fault", { name });
		await new Promise<void>((_resolve, reject) => {
			if (signal?.aborted) reject(new Error("Fault interrupted"));
			signal?.addEventListener("abort", () => reject(new Error("Fault interrupted")), {
				once: true,
			});
		});
	}
	async prepare(): Promise<{ conversationId: number; turnRecordId: string }> {
		if (this.preparation) return this.preparation;
		this.preparation = this.prepareOnce();
		try {
			return await this.preparation;
		} finally {
			this.preparation = undefined;
		}
	}
	private async prepareOnce(): Promise<{ conversationId: number; turnRecordId: string }> {
		const { start } = this.core.current();
		if (!start) throw new Error("No selected turn start");
		const index = await this.harness.snapshot(RunIndex, context);
		const known = index?.conversations[start.proposedTurnRecordId];
		if (known) {
			const conversation = (await this.harness.conversation(known as ConversationId, context))!;
			const binding = (await this.harness.snapshot(BindingDoc, conversation.id, context))!;
			await conversation.configure(
				{ tools: this.tools.filter((t) => binding.allowedTools.includes(t.name)) },
				context,
			);
			return { conversationId: known, turnRecordId: start.proposedTurnRecordId };
		}
		const agent = {
			model: { provider: "prototype", modelId: "fake-model" },
			cwd: "/workspace/repo",
			extensions: [CodingTools, this.extension],
		};
		const primary = start.recoveryTurnRecordId
			? await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context)
			: index?.primaryId
				? (await this.harness.conversation(index.primaryId as ConversationId, context))!
				: await this.harness.root(context, { agent });
		const side = start.turnId === "review";
		const fork = side ? index?.primaryLeaf : null;
		if (side && !fork) throw new Error("Review has no plan to fork");
		const turnRecordId = await this.core.accept({
			pathType: side ? "leaf_branch" : "primary",
			contextMode: start.turnId === "primary" ? "fresh" : "full",
			startTarget: fork
				? { kind: "entry", entryId: `d${fork}` }
				: start.turnId === "primary"
					? { kind: "root" }
					: { kind: "current_leaf" },
			forkPiEntryId: fork ? `d${fork}` : index?.primaryLeaf ? `d${index.primaryLeaf}` : null,
		});
		await this.fault("after_acceptance");
		// Create the fork and mapping together: a crash cannot orphan a second review.
		const conversationId = await this.harness.commit(async (tx) => {
			const runIndex = await tx.doc(RunIndex);
			let id = primary.id;
			if (fork)
				id = (
					await tx.forkConversation(primary.id, fork as EntryId, {
						ownership: { kind: "ownerless" },
					})
				).id;
			const binding = await tx.doc(BindingDoc, id);
			Object.assign(binding, {
				turnRecordId,
				startId: start.id,
				turnId: start.turnId,
				resourceDigest: this.digest,
				instructions: RESOURCE_TEXT,
				allowedTools: side
					? ["read", "finish"]
					: ["read", "write", "edit", "bash", "create_ticket", "unsafe_action", "finish"],
				outcome: null,
				submissionId: null,
				published: false,
			});
			runIndex.conversations[turnRecordId] = id;
			runIndex.primaryId = primary.id;
			return id;
		}, context);
		await this.fault("after_binding");
		const conversation = (await this.harness.conversation(conversationId, context))!;
		const binding = (await this.harness.snapshot(BindingDoc, conversationId, context))!;
		await conversation.configure(
			{ tools: this.tools.filter((t) => binding.allowedTools.includes(t.name)) },
			context,
		);
		return { conversationId, turnRecordId };
	}
	async run(prompt: string) {
		const prepared = await this.prepare();
		const conversation = (await this.harness.conversation(
			prepared.conversationId as ConversationId,
			context,
		))!;
		this.core.assertCurrent(prepared.turnRecordId);
		const submission = await conversation.submit(
			{ type: "input", content: prompt, requestId: `${prepared.turnRecordId}:kickoff` },
			context,
		);
		await this.harness.commit(async (tx) => {
			(await tx.doc(BindingDoc, conversation.id)).submissionId = submission.id;
		}, context);
		this.emit("submitted", { ...prepared, submissionId: submission.id });
		const settled = await submission.wait(context);
		if (settled.status !== "done")
			throw new Error(`Submission did not finish: ${JSON.stringify(settled)}`);
		const binding = (await this.harness.snapshot(BindingDoc, conversation.id, context))!;
		if (binding.outcome === null || settled.answer === undefined)
			throw new Error("Run ended without an outcome");

		const record = this.core.repos.turnRecords.getById(prepared.turnRecordId)!;
		const payload: TurnOutcomePayload = {
			instanceId: this.core.processId,
			turnRecordId: record.id,
			turnId: record.turnId,
			turnType: "llm",
			outcome: "done",
			params: {},
			pathType: record.pathType,
			forkPiEntryId: record.forkPiEntryId,
			resultPiEntryId: `d${settled.answer}`,
			turnResultMarkdown: binding.outcome,
		};
		await this.harness.commit(async (tx) => {
			(await tx.doc(RunIndex)).receipts[record.id] = {
				payload: JSON.stringify(payload),
				answer: settled.answer!,
				published: false,
			};
		}, context);
		await this.fault("before_business_outcome");
		await this.reconcile();
		return {
			payload,
			submissionId: submission.id,
			conversationId: conversation.id,
			state: this.state(),
		};
	}
	private async reconcile(): Promise<void> {
		const index = await this.harness.snapshot(RunIndex, context);
		for (const [turnRecordId, receipt] of Object.entries(index?.receipts ?? {})) {
			if (receipt.published || receipt.discarded) continue;
			const payload = JSON.parse(receipt.payload) as TurnOutcomePayload;
			const record = this.core.repos.turnRecords.getById(turnRecordId);
			if (record?.status === "failed") {
				await this.harness.commit(async (tx) => {
					(await tx.doc(RunIndex)).receipts[turnRecordId]!.discarded = true;
				}, context);
				continue;
			}
			await this.core.outcome(payload);
			await this.fault("after_business_outcome");
			await this.harness.commit(async (tx) => {
				const runIndex = await tx.doc(RunIndex);
				runIndex.receipts[turnRecordId]!.published = true;
				if (payload.pathType === "primary") runIndex.primaryLeaf = receipt.answer;
			}, context);
		}
	}
	async history() {
		const index = await this.harness.snapshot(RunIndex, context);
		const conversations = [];
		for (const id of new Set(Object.values(index?.conversations ?? {}))) {
			const conversation = (await this.harness.conversation(id as ConversationId, context))!;
			const entries = await conversation.entries({}, 10000, undefined, context);
			const view = await conversation.viewState(context);
			conversations.push({ id, parent: view.value.conversation.parent, entries: entries.items });
			view.dispose();
		}
		return { index, conversations };
	}

	state() {
		return {
			...this.core.current(),
			turns: this.core.repos.turnRecords.listByInstance(this.core.processId),
			externalWrites: this.core.repos.externalWrites.listByInstance(this.core.processId),
		};
	}
	async view(id: number): Promise<unknown> {
		const conversation = (await this.harness.conversation(id as ConversationId, context))!;
		const view = await conversation.viewState(context);
		try {
			const value = structuredClone(view.value);
			this.boundary.assertPublic(value);
			return value;
		} finally {
			view.dispose();
		}
	}
	async watch(id: number, watchId: string): Promise<unknown> {
		const conversation = (await this.harness.conversation(id as ConversationId, context))!;
		const watch = await conversation.watch(context);
		this.watches.set(watchId, watch);
		watch.start(async (value, ops) => {
			this.boundary.assertPublic(value);
			this.emit("view", { watchId, value, ops });
		});
		return watch.value;
	}
	async stop(): Promise<void> {
		const record = this.core.current().record;
		if (!record) throw new Error("Nothing to stop");
		// Revoke command admission before waiting for cancellation. The durable core
		// failure makes late tool and outcome facts stale before Retry can start.
		await this.core.requestStop();
		await this.core.fail(record.id, "Stopped by operator");
		this.workerAllowed = false;
		await this.worker.close();
		const index = await this.harness.snapshot(RunIndex, context);
		const conversation = await this.harness.conversation(
			index!.conversations[record.id] as ConversationId,
			context,
		);
		await conversation!.abort(context);
	}
	async probe(command: string, turnRecordId?: string): Promise<string> {
		this.core.assertCurrent(turnRecordId ?? this.core.current().record?.id ?? "");
		let output = "";
		getOrThrow(
			await remoteEnvironment(this.worker, () =>
				this.core.assertCurrent(turnRecordId ?? this.core.current().record?.id ?? ""),
			).exec(
				command,
				{
					onOutput: (text) => {
						output += text;
					},
				},
				context,
			),
		);
		return output;
	}
	async checkTool(id: number, name: string): Promise<void> {
		await this.authorize(id as ConversationId, name);
	}
	async rejectSecret(): Promise<void> {
		await this.probe(`echo ${this.config.externalCredential}`);
	}
	async submitInput(prompt: string, requestId: string) {
		const prepared = await this.prepare();
		const conversation = (await this.harness.conversation(
			prepared.conversationId as ConversationId,
			context,
		))!;
		return (
			await conversation.submit(
				{ type: "input", content: prompt, requestId, whenBusy: "followUp" },
				context,
			)
		).status(context);
	}
	async awaitInput(id: number) {
		const submission = await this.harness.submission(
			id as import("@earendil-works/pi-durable").SubmissionId,
			context,
		);
		return submission!.wait(context);
	}

	async close(): Promise<void> {
		for (const watch of this.watches.values()) await watch.stop();
		await this.harness?.close(context);
		await this.worker.close();
		this.core.close();
	}
}
