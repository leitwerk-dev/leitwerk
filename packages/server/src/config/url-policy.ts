export function parseHttpUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url : null;
	} catch {
		return null;
	}
}

export function isValidHttpUrl(value: string): boolean {
	return parseHttpUrl(value) !== null;
}

export function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function isLoopbackHttpUrl(value: string): boolean {
	const url = parseHttpUrl(value);
	return url?.protocol === "http:" && isLoopbackHostname(url.hostname);
}

export function isHttpsOrLoopbackHttpUrl(value: string): boolean {
	const url = parseHttpUrl(value);
	return (
		url !== null &&
		(url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname)))
	);
}
