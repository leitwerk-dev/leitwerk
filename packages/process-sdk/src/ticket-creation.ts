import { asUnknownRecord } from "@leitwerk-dev/domain";

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
