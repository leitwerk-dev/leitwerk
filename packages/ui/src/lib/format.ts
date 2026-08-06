import type { ProcessLifecycleStatus } from "@leitwerk-dev/domain";

const STATUS_LABELS: Record<ProcessLifecycleStatus, string> = {
	discovered: "Queued",
	active: "Running",
	waiting: "Waiting",
	error: "Error",
	completed: "Completed",
	aborted: "Aborted",
};

const IDENTIFIER_WORD_LABELS: Record<string, string> = {
	api: "API",
	gitlab: "GitLab",
	id: "ID",
	jira: "Jira",
	llm: "LLM",
	mr: "MR",
	pi: "Pi",
	ui: "UI",
};

function formatIdentifier(value: string): string {
	return value
		.split(/[_-]+/)
		.filter((part) => part.length > 0)
		.map((part) => {
			const normalizedPart = part.toLowerCase();
			return IDENTIFIER_WORD_LABELS[normalizedPart] ?? part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

export function formatStatus(status: ProcessLifecycleStatus): string {
	return STATUS_LABELS[status] ?? status;
}

export function formatTurnId(turnId: string | null): string {
	if (!turnId) return "Unknown";
	return formatIdentifier(turnId);
}

export function formatDefinition(id: string): string {
	return formatIdentifier(id);
}

export function formatRelativeTime(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	if (diffMs < 0) return "just now";
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

export function formatLocalDateTime(iso: string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(iso));
}

export function formatUtcDateTime(iso: string): string {
	return `${new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC",
	}).format(new Date(iso))} UTC`;
}

export function formatLocalDateTime24Hour(iso: string): string {
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(new Date(iso));
}

export function formatUtcDateTime24Hour(iso: string): string {
	return `${new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZone: "UTC",
	}).format(new Date(iso))} UTC`;
}
