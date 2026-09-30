import { asUnknownRecord } from "@leitwerk-dev/domain";
import type {
	IntegrationToolDefinition,
	TicketCreationDestinationList,
	TicketCreationDestinationProvider,
	TicketCreationDestinationSummary,
} from "./extension-api.js";

/** @internal */
export function markdownTicketCreationDefinition(
	displayName: string,
	destinations: TicketCreationDestinationProvider,
	descriptionKey = "body",
	labelDescription = "Optional existing label names",
): Pick<IntegrationToolDefinition, "parameters" | "capability"> {
	return {
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "Concise issue title" },
				[descriptionKey]: { type: "string", description: "Complete Markdown issue description" },
				labels: { type: "array", items: { type: "string" }, description: labelDescription },
			},
			required: ["title", descriptionKey],
		},
		capability: {
			kind: "ticket_creation",
			displayName,
			processId: "ticket_creation_process",
			startTurnId: "create_ticket",
			titlePath: "/title",
			descriptionPath: `/${descriptionKey}`,
			descriptionFormat: "markdown",
			destinations,
		},
	};
}

/** @internal */
export async function listTicketDestinations(
	provider: string,
	profiles: readonly string[],
	list: (profile: string) => Promise<readonly TicketCreationDestinationSummary[]>,
): Promise<TicketCreationDestinationList> {
	const results = await Promise.all(
		profiles.map(async (profile) => {
			try {
				return { destinations: await list(profile), warnings: [] };
			} catch {
				return {
					destinations: [],
					warnings: [`${provider} profile '${profile}' is currently unavailable.`],
				};
			}
		}),
	);
	return {
		destinations: results.flatMap((result) => result.destinations),
		warnings: results.flatMap((result) => result.warnings),
	};
}

/** @internal */
export interface TicketCreationConfig {
	/** @internal */
	enabled: boolean;
	/** @internal */
	defaultLabels: string[];
}

/** @internal */
export function ticketLabelNames(value: unknown, label = "labels"): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name.trim()))
		throw new Error(`${label} must be an array of nonempty label names`);
	return [...new Set(value.map((name: string) => name.trim()))];
}

/** @internal */
export function parseTicketCreationConfig(value: unknown, provider: string): TicketCreationConfig {
	const raw = asUnknownRecord(value)?.ticket_creation;
	const config = raw === undefined ? {} : asUnknownRecord(raw);
	if (!config || (config.enabled !== undefined && typeof config.enabled !== "boolean"))
		throw new Error(`${provider} ticket_creation.enabled must be a boolean`);
	return {
		enabled: config.enabled === true,
		defaultLabels: ticketLabelNames(
			config.default_labels === undefined ? ["created-by-leitwerk"] : config.default_labels,
			`${provider} ticket_creation.default_labels`,
		),
	};
}

/** @internal */
export function ticketDestinationId(profile: string, resourceId: string | number): string {
	return `${encodeURIComponent(profile)}.${resourceId}`;
}

/** @internal */
export function parseTicketDestinationId(value: string): {
	/** @internal */ profile: string;
	/** @internal */ resourceId: string;
} {
	const separator = value.lastIndexOf(".");
	try {
		const profile = decodeURIComponent(value.slice(0, separator));
		const resourceId = value.slice(separator + 1);
		if (separator <= 0 || !profile.trim() || !/^[1-9]\d*$/.test(resourceId)) throw new Error();
		return { profile, resourceId };
	} catch {
		throw new Error("Unknown ticket destination");
	}
}
