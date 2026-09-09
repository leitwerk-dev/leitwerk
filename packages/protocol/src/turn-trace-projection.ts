import type { TurnTraceSnapshot } from "./http-contracts.js";
import {
	type MutableLiveTurnProjection,
	snapshotLiveTurnProjection,
} from "./live-turn-projection.js";
import { extractPiSessionMessageText } from "./pi-session-message.js";
import { isToolResultTruncated } from "./tool-result-truncation.js";

/** Share the recorded tool content presentation between live HTTP history and live frames. */
export function snapshotTurnTrace(
	projection: MutableLiveTurnProjection,
	piInput: TurnTraceSnapshot["piInput"] = null,
): TurnTraceSnapshot {
	const snapshot = snapshotLiveTurnProjection(projection);
	return {
		...snapshot,
		piInput,
		toolCalls: snapshot.toolCalls.map(({ result, ...tool }) => {
			const record =
				result && typeof result === "object" ? (result as Record<string, unknown>) : null;
			const resultText =
				result == null
					? null
					: typeof result === "string"
						? result
						: record && "content" in record
							? extractPiSessionMessageText(record.content)
							: JSON.stringify(result, null, 2);
			return {
				...tool,
				resultText,
				truncated:
					("truncated" in tool && tool.truncated === true) ||
					isToolResultTruncated({
						resultText,
						resultDetails: record?.details,
						resultValue: result,
					}),
			};
		}),
	};
}
