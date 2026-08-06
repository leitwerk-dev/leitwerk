export type { Page, ProcessDetailOverlayState, ProcessPathOptions, Route } from "./router-logic.js";
export {
	buildAvailableSkillPath,
	buildFutureLaunchPath,
	buildHomePath,
	buildInstalledSkillPath,
	buildProcessesPath,
	buildProcessPath,
	buildSkillsPath,
	buildWatchersPath,
	matchRoute,
	readProcessDetailOverlay,
} from "./router-logic.js";

import { derived, writable } from "svelte/store";
import { matchRoute } from "./router-logic.js";

interface NavigateOptions {
	replace?: boolean;
}

function readCurrentLocationPath(): string {
	return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

const currentLocationPath = writable(readCurrentLocationPath());
export const locationStore = derived(currentLocationPath, (locationPath) => locationPath);
export const routeStore = derived(currentLocationPath, (locationPath) => matchRoute(locationPath));

export function followLink(event: MouseEvent, to: string): void {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	) {
		return;
	}
	event.preventDefault();
	navigate(to);
}

export function navigate(to: string, options: NavigateOptions = {}) {
	if (options.replace) {
		history.replaceState(null, "", to);
	} else {
		history.pushState(null, "", to);
	}
	currentLocationPath.set(readCurrentLocationPath());
}

window.addEventListener("popstate", () => {
	currentLocationPath.set(readCurrentLocationPath());
});
