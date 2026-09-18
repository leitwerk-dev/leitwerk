import { forgejoRepoChangeProcess as process } from "./index.js";

export function deliveryTurn() {
	const turn = process.turns.get("deliver_change")?.definition;
	if (turn?.kind !== "automatic") throw new Error("Missing delivery turn");
	return turn;
}

export function routingState(
	forgejoRepoChange: Record<string, unknown>,
	extensionState: Record<string, unknown> = {},
) {
	return process.stateCodec.parse({ extensionState: { ...extensionState, forgejoRepoChange } });
}
