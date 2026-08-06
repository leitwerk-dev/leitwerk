export const TURN_ACCEPTANCE_STATES = ["accepted", "requires_changes", "neutral"] as const;

export type TurnAcceptanceState = (typeof TURN_ACCEPTANCE_STATES)[number];
