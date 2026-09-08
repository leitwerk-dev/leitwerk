export interface TicketResultSelection {
	artifactId: string;
	text: string;
}

/** Accept selections only when both endpoints are inside the same durable result host. */
export function readTicketResultSelection(
	selection: Selection | null,
): TicketResultSelection | null {
	if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
	const range = selection.getRangeAt(0);
	const hostFor = (node: Node | null): HTMLElement | null => {
		const element = node instanceof Element ? node : node?.parentElement;
		return element?.closest<HTMLElement>("[data-ticket-result-artifact]") ?? null;
	};
	const start = hostFor(range.startContainer);
	const end = hostFor(range.endContainer);
	if (!start || start !== end || start.dataset.ticketResultDurable !== "true") return null;
	const artifactId = start.dataset.ticketResultArtifact?.trim();
	const text = selection.toString().replace(/\s+/gu, " ").trim();
	if (!artifactId || !text) return null;
	return { artifactId, text };
}
