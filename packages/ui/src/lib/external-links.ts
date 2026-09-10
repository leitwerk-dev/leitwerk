export const EXTERNAL_LINK_CLASS = "external-link";
export const EXTERNAL_LINK_ICON_CLASS = "external-link-icon";
export const EXTERNAL_LINK_A11Y_CLASS = "external-link-a11y";
export const EXTERNAL_LINK_ICON = "↗";
export const NEW_TAB_ANNOUNCEMENT = "opens in a new tab";
export const NEW_TAB_REL = "noopener noreferrer";
export const NEW_TAB_WINDOW_FEATURES = "noopener,noreferrer";

export type ExternalResourceType =
	| "issue"
	| "pull_request"
	| "merge_request"
	| "commit"
	| "pipeline"
	| "project"
	| "external_resource";

const RESOURCE_LABELS: Record<ExternalResourceType, string> = {
	issue: "Issue",
	pull_request: "Pull request",
	merge_request: "Merge request",
	commit: "Commit",
	pipeline: "Pipeline",
	project: "External project",
	external_resource: "External resource",
};

export function externalResourceLabel(type: ExternalResourceType): string {
	return RESOURCE_LABELS[type];
}

export function isExternalHref(href: string, baseUri: string = document.baseURI): boolean {
	if (href.trim().startsWith("#")) return false;
	try {
		const base = new URL(baseUri);
		const destination = new URL(href, base);
		return destination.origin !== base.origin;
	} catch {
		return false;
	}
}

function removeDecoration(link: HTMLAnchorElement): void {
	link.classList.remove(EXTERNAL_LINK_CLASS);
	link
		.querySelectorAll(`.${EXTERNAL_LINK_ICON_CLASS}, .${EXTERNAL_LINK_A11Y_CLASS}`)
		.forEach((node) => {
			node.remove();
		});
}

export function secureAnchorNewTab(link: HTMLAnchorElement): void {
	link.target = "_blank";
	link.rel = NEW_TAB_REL;
}

export function decorateExternalLink(link: HTMLAnchorElement): void {
	removeDecoration(link);
	link.classList.add(EXTERNAL_LINK_CLASS);
	secureAnchorNewTab(link);

	const icon = document.createElement("span");
	icon.className = EXTERNAL_LINK_ICON_CLASS;
	icon.setAttribute("aria-hidden", "true");
	icon.textContent = EXTERNAL_LINK_ICON;
	const announcement = document.createElement("span");
	announcement.className = EXTERNAL_LINK_A11Y_CLASS;
	announcement.textContent = ` (${NEW_TAB_ANNOUNCEMENT})`;
	link.append(icon, announcement);
}

export function normalizeLinkNavigation(link: HTMLAnchorElement, baseUri?: string): void {
	const href = link.getAttribute("href") ?? "";
	if (isExternalHref(href, baseUri)) {
		decorateExternalLink(link);
		return;
	}
	removeDecoration(link);
	link.removeAttribute("target");
	link.removeAttribute("rel");
}
