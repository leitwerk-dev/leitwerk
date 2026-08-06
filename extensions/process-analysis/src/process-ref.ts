export interface ResolvedProcessRef {
	id: string;
	origin: string;
	apiUrl: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function resolveProcessRef(input: {
	processRef: string;
	serverBaseUrl: string;
}): ResolvedProcessRef {
	const raw = input.processRef.trim();
	if (!raw) throw new Error("processRef is required");
	const currentOrigin = new URL(input.serverBaseUrl).origin;
	let id = "";
	if (ID_RE.test(raw) && !raw.includes("/")) {
		id = raw;
	} else {
		let url: URL;
		try {
			url = raw.startsWith("/") ? new URL(raw, currentOrigin) : new URL(raw);
		} catch {
			throw new Error("processRef must be a process id or process URL");
		}
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error("Only http(s) process URLs are supported");
		if (url.username || url.password)
			throw new Error("Credentials in process URLs are not allowed");
		const parts = url.pathname.split("/").filter(Boolean);
		const apiIndex = parts[0] === "api" ? 1 : 0;
		if (parts[apiIndex] !== "processes" || !parts[apiIndex + 1])
			throw new Error("URL must point to /processes/:id or /api/processes/:id");
		id = decodeURIComponent(parts[apiIndex + 1]);
	}
	if (!ID_RE.test(id)) throw new Error("process id is missing or invalid");
	return {
		id,
		origin: currentOrigin,
		apiUrl: `${currentOrigin}/api/processes/${encodeURIComponent(id)}`,
	};
}
