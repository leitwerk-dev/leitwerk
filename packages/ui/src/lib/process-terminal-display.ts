export type ProcessTerminalStatus = "completed" | "aborted";

export function getProcessTerminalIcon(status: ProcessTerminalStatus): string {
	return status === "completed" ? "✓" : "✕";
}

export function getProcessTerminalHeading(status: ProcessTerminalStatus): string {
	return status === "completed" ? "Completed" : "Aborted";
}

export function getProcessTerminalRailTitle(status: ProcessTerminalStatus): string {
	return getProcessTerminalHeading(status);
}

export function getProcessTerminalVerb(status: ProcessTerminalStatus): string {
	return status === "completed" ? "Completed" : "Aborted";
}
