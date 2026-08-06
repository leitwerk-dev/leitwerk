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

export interface WsClientLike {
	readyState: number;
	send(data: string): void;
	on(event: string, handler: () => void): void;
}

export type { WsDurability, WsFrame };

export function createBroadcaster() {
	const clients = new Set<WsClientLike>();

	function addClient(ws: WsClientLike) {
		clients.add(ws);
		ws.on("close", () => clients.delete(ws));
	}

	function broadcast(frame: WsFrame) {
		const data = JSON.stringify(frame);
		for (const client of clients) {
			if (client.readyState === 1) {
				client.send(data);
			}
		}
	}

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

	return { addClient, broadcast, sendDurable, sendEphemeral };
}

export type Broadcaster = ReturnType<typeof createBroadcaster>;
