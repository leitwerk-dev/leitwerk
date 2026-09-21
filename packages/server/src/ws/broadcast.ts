import {
	createDurableWsFrame,
	createEphemeralWsFrame,
	type DurableWsFrameInput,
	type EphemeralWsFrameInput,
	type KnownDurableWsFrameType,
	type KnownEphemeralWsFrameType,
	type WsDurability,
	type WsFrame,
	type WsPayloadByType,
} from "@leitwerk-dev/protocol";

/** @internal */
export interface WsClientLike {
	/** @internal */
	readyState: number;
	/** @internal */
	send(data: string): void;
	/** @internal */
	on(event: string, handler: () => void): void;
}

export type { WsDurability, WsFrame };

/** @internal */
export function createBroadcaster() {
	const clients = new Set<WsClientLike>();

	/** @internal */
	function addClient(ws: WsClientLike) {
		clients.add(ws);
		ws.on("close", () => clients.delete(ws));
	}

	/** @internal */
	function broadcast(frame: WsFrame) {
		const data = JSON.stringify(frame);
		for (const client of clients) {
			if (client.readyState === 1) {
				client.send(data);
			}
		}
	}

	/** @internal */
	function sendDurable<T extends KnownDurableWsFrameType>(
		type: T,
		payload: WsPayloadByType[T],
		instanceId?: string,
	) {
		const frame = createDurableWsFrame({
			type,
			payload,
			instanceId,
		} as Extract<DurableWsFrameInput, { type: T }>);
		broadcast(frame);
	}

	/** @internal */
	function sendEphemeral<T extends KnownEphemeralWsFrameType>(
		type: T,
		payload: WsPayloadByType[T],
		instanceId?: string,
	) {
		const frame = createEphemeralWsFrame({
			type,
			payload,
			instanceId,
		} as Extract<EphemeralWsFrameInput, { type: T }>);
		broadcast(frame);
	}

	return {
		/** @internal */
		addClient,
		/** @internal */
		broadcast,
		/** @internal */
		sendDurable,
		/** @internal */
		sendEphemeral,
	};
}

/** @internal */
export type Broadcaster = ReturnType<typeof createBroadcaster>;
