/** Canonical, credential-free HTTPS repository URL. Reject ambiguous Git credential paths. */
export function repositoryHttpsUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Repository authentication requires a valid HTTPS URL");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.pathname.slice(1) ||
		/[%\\\s]/.test(url.pathname) ||
		url.pathname.split("/").some((part) => part === "." || part === "..") ||
		url.href !== value
	)
		throw new Error("Repository authentication requires a canonical credential-free HTTPS URL");
	return url;
}
