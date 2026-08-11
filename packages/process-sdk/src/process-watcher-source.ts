import type { ProcessWatcherSource } from "./extension-api.js";

export function defineProcessWatcherSource<TConfig, TEvent = unknown>(
	source: ProcessWatcherSource<TConfig, TEvent>,
): ProcessWatcherSource<TConfig, TEvent> {
	if (source.id.trim() === "") {
		throw new Error("Process watcher source id must not be empty");
	}
	if (source.label.trim() === "") {
		throw new Error(`Process watcher source '${source.id}' must define a non-empty label`);
	}
	return source;
}
