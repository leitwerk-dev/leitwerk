export type ProcessTerminalStatus = "completed" | "aborted";

export function getProcessTerminalIcon(status: ProcessTerminalStatus): string {
	return status === "completed" ? "✓" : "✕";
}

export function getProcessTerminalHeading(status: ProcessTerminalStatus): string {
	return status === "completed" ? "Completed" : "Aborted";
}

export {
	getProcessTerminalHeading as getProcessTerminalRailTitle,
	getProcessTerminalHeading as getProcessTerminalVerb,
};
