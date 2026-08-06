export type StorageLike = Pick<Storage, "getItem" | "setItem"> &
	Partial<Pick<Storage, "removeItem">>;

export function getBrowserStorage(): StorageLike | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}
