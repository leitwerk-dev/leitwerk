import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Repository-local JSON with atomic replacement. Callers own validation and locking. @internal */
export function repositoryRecord<T>(gitDirectory: string, name: string) {
	const file = join(gitDirectory, `leitwerk-${name}.json`);
	return {
		read: (): T | null => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null),
		save: (record: T): void => {
			writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
			renameSync(`${file}.tmp`, file);
		},
	};
}
