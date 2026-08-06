import {
	addLauncherRecentValue,
	DEFAULT_LAUNCHER_RECENT_VALUE_LIMIT,
	normalizeLauncherRecentValue,
	normalizeLauncherRecentValues,
} from "@leitwerk-dev/domain";
import type { StorageLike } from "./browser-storage.js";

export type { StorageLike } from "./browser-storage.js";

const STORAGE_KEY_PREFIX = "leitwerk.launcher-recents:";
const DEFAULT_RECENT_VALUE_LIMIT = DEFAULT_LAUNCHER_RECENT_VALUE_LIMIT;

export {
	addLauncherRecentValue,
	DEFAULT_RECENT_VALUE_LIMIT,
	normalizeLauncherRecentValue,
	normalizeLauncherRecentValues,
};

export function buildLauncherRecentValuesStorageKey(launcherId: string, fieldId: string): string {
	return `${STORAGE_KEY_PREFIX}${launcherId}:${fieldId}`;
}

export function readLauncherRecentValues(
	storage: StorageLike,
	launcherId: string,
	fieldId: string,
	limit = DEFAULT_RECENT_VALUE_LIMIT,
): string[] {
	let rawValue: string | null;
	try {
		rawValue = storage.getItem(buildLauncherRecentValuesStorageKey(launcherId, fieldId));
	} catch {
		return [];
	}
	if (!rawValue) {
		return [];
	}
	try {
		const parsed = JSON.parse(rawValue);
		return Array.isArray(parsed) ? normalizeLauncherRecentValues(parsed, limit) : [];
	} catch {
		return [];
	}
}

export function writeLauncherRecentValue(
	storage: StorageLike,
	launcherId: string,
	fieldId: string,
	value: string,
	limit = DEFAULT_RECENT_VALUE_LIMIT,
): string[] {
	const existingValues = readLauncherRecentValues(storage, launcherId, fieldId, limit);
	const nextValues = addLauncherRecentValue(existingValues, value, limit);
	const key = buildLauncherRecentValuesStorageKey(launcherId, fieldId);
	try {
		if (nextValues.length === 0) {
			storage.removeItem?.(key);
			return nextValues;
		}
		storage.setItem(key, JSON.stringify(nextValues));
		return nextValues;
	} catch {
		return existingValues;
	}
}
