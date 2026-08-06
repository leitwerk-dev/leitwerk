export function resolveWorkerHttpUrl(serverUrl: string, pathname: string): string {
	const base = new URL(serverUrl);
	if (base.protocol === "ws:") base.protocol = "http:";
	if (base.protocol === "wss:") base.protocol = "https:";
	return new URL(pathname, base).toString();
}
