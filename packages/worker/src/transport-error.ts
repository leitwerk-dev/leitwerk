// Native transport messages can contain URLs, credentials and request bodies.
const transportCodes = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EPIPE",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_ABORTED",
	"UND_ERR_DESTROYED",
	"UND_ERR_CLOSED",
]);
const transportNames = new Set([
	"Error",
	"TypeError",
	"AggregateError",
	"AbortError",
	"TimeoutError",
	"SystemError",
	"ConnectTimeoutError",
	"HeadersTimeoutError",
	"BodyTimeoutError",
	"SocketError",
	"RequestAbortedError",
	"ClientDestroyedError",
	"ClientClosedError",
]);

/** @internal */
export interface TransportErrorDetails {
	/** @internal */
	causes: Array<{ name?: string; code?: string; parent?: number }>;
	/** @internal */
	truncated?: true;
}

function property(value: object, key: string): unknown {
	try {
		return (value as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

/** Only bounded allowlisted names/codes cross the durable diagnostic boundary. @internal */
export function transportErrorDetails(error: unknown): TransportErrorDetails {
	const causes: TransportErrorDetails["causes"] = [];
	const seen = new Set<object>();
	let truncated = false;
	function visit(value: unknown, depth: number, parent?: number): void {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		if (depth >= 6 || causes.length >= 8) {
			truncated = true;
			return;
		}
		seen.add(value);
		const name = property(value, "name"),
			code = property(value, "code");
		const index = causes.length;
		causes.push({
			...(typeof name === "string" && transportNames.has(name) ? { name } : {}),
			...(typeof code === "string" && transportCodes.has(code) ? { code } : {}),
			...(parent !== undefined ? { parent } : {}),
		});
		visit(property(value, "error") ?? property(value, "cause"), depth + 1, index);
		const children = property(value, "errors");
		if (value instanceof AggregateError && Array.isArray(children)) {
			if (children.length > 4) truncated = true;
			for (const child of children.slice(0, 4)) visit(child, depth + 1, index);
		}
	}
	visit(error, 0);
	return { causes, ...(truncated ? { truncated: true } : {}) };
}

/** @internal */
export function transportErrorCode(error: unknown): string | undefined {
	return transportErrorDetails(error).causes.find((cause) => cause.code)?.code;
}
