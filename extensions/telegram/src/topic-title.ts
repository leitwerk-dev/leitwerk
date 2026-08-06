import type { ProcessInstance } from "@leitwerk-dev/domain";

const MAX_TOPIC_TITLE_LENGTH = 128;

function flatten(value: string): string {
	return value
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function getProcessTopicBaseTitle(process: ProcessInstance): string {
	return (
		flatten(process.title ?? "") ||
		flatten(process.externalId ?? "") ||
		flatten(process.processId) ||
		process.id
	);
}

export function buildTopicTitle(input: { process: ProcessInstance; template: string }): string {
	const shortId = input.process.id.slice(-8);
	const title = getProcessTopicBaseTitle(input.process);
	const rendered = input.template
		.replaceAll("{title}", title)
		.replaceAll("{shortId}", shortId)
		.replaceAll("{processId}", input.process.processId)
		.replaceAll("{externalId}", input.process.externalId ?? "");
	return truncate(flatten(rendered) || `Process ${shortId}`, MAX_TOPIC_TITLE_LENGTH);
}
