import { chmod, lstat, mkdir, readdir, rename, rmdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

export async function reserveWorkspaceDestination(
	destination: string,
	marker: { name: string; ownerId: string },
): Promise<void> {
	// mkdir is the exclusive claim: never replace even an empty existing directory.
	await mkdir(destination, { recursive: false, mode: 0o700 });
	try {
		await writeFile(path.join(destination, marker.name), `${marker.ownerId}\n`, {
			mode: 0o600,
			flag: "wx",
		});
	} catch (error) {
		// An unsuccessful marker write must not recursively remove any intervening data.
		await rmdir(destination).catch(() => undefined);
		throw error;
	}
}

export async function populateWorkspaceDestination(source: string, destination: string) {
	const metadata = await lstat(source);
	// Staging stays writable for moves and recovery; restore the imported mode last.
	await chmod(source, (metadata.mode & 0o7777) | 0o700);
	for (const name of await readdir(source)) {
		await rename(path.join(source, name), path.join(destination, name));
	}
	return metadata;
}

export async function restoreWorkspaceMetadata(
	destination: string,
	metadata: { mode: number; atime: Date; mtime: Date },
): Promise<void> {
	await chmod(destination, metadata.mode & 0o7777);
	await utimes(destination, metadata.atime, metadata.mtime);
}
