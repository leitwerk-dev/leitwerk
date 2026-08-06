import type { PiEvent } from "./pi-adapter.js";

export interface TranslatedEvent {
	eventType: string;
	selectedTurnId: string | null;
	data: Record<string, unknown>;
}

export function translatePiEvent(
	piEvent: PiEvent,
	currentSelectedTurnId: string | null,
): TranslatedEvent {
	return {
		eventType: `pi.${piEvent.type}`,
		selectedTurnId: currentSelectedTurnId,
		data: {
			turnId: piEvent.turnId,
			timestamp: piEvent.timestamp,
			...piEvent.data,
		},
	};
}
