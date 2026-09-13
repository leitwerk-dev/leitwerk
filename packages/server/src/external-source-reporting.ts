import type { ExternalEventDescription, ExternalObservationInput } from "@leitwerk-dev/process-sdk";
import { normalizeTurnProgressLinks } from "./turn-progress.js";

export function normalizeExternalEventDescription(value: unknown): ExternalEventDescription | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const links = normalizeTurnProgressLinks(raw.links);
	if (typeof raw.summary !== "string" || !raw.summary.trim() || !links) return null;
	return {
		summary: raw.summary.trim().slice(0, 2000),
		...(typeof raw.markdown === "string" ? { markdown: raw.markdown } : {}),
		...(links.length ? { links } : {}),
	};
}

export function normalizeExternalObservation(
	value: unknown,
): ExternalObservationInput["observation"] | null {
	const description = normalizeExternalEventDescription(value);
	if (!description) return null;
	const raw = value as Record<string, unknown>;
	if (
		typeof raw.observedAt !== "string" ||
		!Number.isFinite(Date.parse(raw.observedAt)) ||
		typeof raw.subject !== "string" ||
		!raw.subject.trim() ||
		typeof raw.revision !== "string"
	)
		return null;
	return {
		summary: description.summary,
		...(description.links ? { links: description.links } : {}),
		observedAt: raw.observedAt,
		subject: raw.subject,
		revision: raw.revision,
	};
}
