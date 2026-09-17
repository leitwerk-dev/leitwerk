import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	createWriteIdentity,
	type ExternalWriteLogRepoLike,
	ensureWrite,
} from "@leitwerk-dev/external-writes";
import {
	coreHostCapabilities,
	type IntegrationToolDefinition,
	type LeitwerkExtensionModule,
	type TicketCreationDestinationSummary,
} from "@leitwerk-dev/process-sdk";

/** @internal */
export interface LocalTicket {
	/** @internal */
	id: string;
	/** @internal */
	writeKey: string;
	/** @internal */
	destinationId: string;
	/** @internal */
	title: string;
	/** @internal */
	body: string;
	/** @internal */
	url: string;
}
/** @internal */
interface LocalTicketState {
	/** @internal */
	version: 1;
	/** @internal */
	tickets: LocalTicket[];
	/** @internal */
	failAfterPersistence: boolean;
}
/** @internal */
export interface LocalTicketAdapterOptions {
	/** @internal */
	file: string;
	/** @internal */
	baseUrl: string;
	/** @internal */
	destinations: readonly TicketCreationDestinationSummary[];
}

/** Local persistence only. This entrypoint is never loaded by production registration. */
/** @internal */
export class LocalTicketAdapter {
	/** @internal */
	readonly state: LocalTicketState;
	/** @internal */
	constructor(
		/** @internal */
		readonly options: LocalTicketAdapterOptions,
	) {
		this.state = existsSync(options.file)
			? JSON.parse(readFileSync(options.file, "utf8"))
			: { version: 1, tickets: [], failAfterPersistence: false };
		if (this.state.version !== 1) throw new Error("Unsupported local ticket state version");
		if (
			!options.destinations.length ||
			new Set(options.destinations.map((d) => d.id)).size !== options.destinations.length
		)
			throw new Error("Local ticket destinations must be nonempty and unique");
	}
	private save(): void {
		mkdirSync(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
		writeFileSync(`${this.options.file}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
		renameSync(`${this.options.file}.tmp`, this.options.file);
	}
	/** @internal */
	injectLostResponse(enabled = true): void {
		this.state.failAfterPersistence = enabled;
		this.save();
	}
	/** @internal */
	tool(writes: ExternalWriteLogRepoLike): IntegrationToolDefinition<{
		/** @internal */
		title: string;
		/** @internal */
		body: string;
	}> {
		const target = (id: unknown) => {
			const destination = this.options.destinations.find((d) => d.id === id);
			if (!destination) throw new Error("Unknown local ticket destination");
			return destination;
		};
		return {
			name: "local_create_ticket",
			description: "Create a ticket in a local notebook",
			parameters: {
				type: "object",
				properties: { title: { type: "string" }, body: { type: "string" } },
				required: ["title", "body"],
			},
			capability: {
				kind: "ticket_creation",
				processId: "ticket_creation_process",
				startTurnId: "create_ticket",
				displayName: "Local tickets",
				titlePath: "/title",
				descriptionPath: "/body",
				destinations: {
					list: async () => ({ destinations: this.options.destinations }),
					resolve: async ({ destinationId }) => ({
						summary: target(destinationId),
						data: { id: destinationId },
						agentContext: "A local notebook ticket. No external network requests are made.",
					}),
					validate: async (snapshot) => {
						const current = target(snapshot.summary.id);
						if (
							JSON.stringify(snapshot.summary) !== JSON.stringify(current) ||
							JSON.stringify(snapshot.data) !== JSON.stringify({ id: current.id })
						)
							throw new Error("Local ticket destination changed");
					},
				},
			},
			parse(value) {
				const data = value as Record<string, unknown> | null;
				if (
					!data ||
					typeof data.title !== "string" ||
					!data.title.trim() ||
					typeof data.body !== "string" ||
					!data.body.trim()
				)
					throw new Error("A ticket title and body are required");
				return { title: data.title, body: data.body };
			},
			execute: async (ctx, args) => {
				const destination = target(ctx.ticketDestination?.summary.id);
				const identity = createWriteIdentity("local.create_ticket", ctx.idempotencyKey);
				const find = () =>
					this.state.tickets.find((ticket) => ticket.writeKey === ctx.idempotencyKey);
				const receipt = (ticket: LocalTicket) => ({
					externalId: ticket.id,
					url: ticket.url,
					result: ticket,
				});
				try {
					await ensureWrite(writes, ctx.process.id, identity, async () => {
						let ticket = find();
						if (!ticket) {
							const id = String(this.state.tickets.length + 1);
							ticket = {
								id,
								writeKey: ctx.idempotencyKey,
								destinationId: destination.id,
								...args,
								url: `${this.options.baseUrl}/__local/tickets/${id}`,
							};
							this.state.tickets.push(ticket);
							const fail = this.state.failAfterPersistence;
							this.state.failAfterPersistence = false;
							this.save();
							if (fail)
								throw new Error(
									"Local ticket persisted, but its response was lost. Retry to reconcile.",
								);
						}
						return receipt(ticket);
					});
				} catch (error) {
					// Reconcile a lost adapter response before recording the durable receipt.
					const confirmed = find();
					if (!confirmed) throw error;
					await ensureWrite(writes, ctx.process.id, identity, async () => receipt(confirmed));
				}

				const ticket = find();
				if (!ticket) throw new Error("Local ticket receipt could not be reconciled");
				return receipt(ticket);
			},
		};
	}
	/** @internal */
	extension(): LeitwerkExtensionModule {
		return {
			manifest: { id: "local-tickets", version: "1.0.0", requires: ["ticket-creation"] },
			setupServer: (api) => {
				const deps = api.require(coreHostCapabilities.serverSetup);
				if (Array.isArray(deps)) throw new Error("Expected one server setup capability");
				api.tool(this.tool(deps.externalWrites as ExternalWriteLogRepoLike));
			},
		};
	}
}
