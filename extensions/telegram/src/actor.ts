import type { Actor } from "@leitwerk-dev/domain";

/** Single collapsed principal for all actions originating from this channel. */
export const TELEGRAM_ACTOR: Actor = {
	id: "telegram",
	kind: "channel",
	provider: "telegram",
};
