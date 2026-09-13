import { existsSync, writeFileSync } from "node:fs";

// Keep the first failure and latest observation within Kubernetes' 4 KiB limit.
// Inputs are fixed transport summaries, never raw errors, URLs, or credentials.
export function createConnectionDiagnosticRecorder(
	deps = {
		log: (message: string) => console.error(message),
		persist: (message: string) => {
			if (existsSync("/dev/termination-log")) writeFileSync("/dev/termination-log", message);
		},
	},
): (message: string) => void {
	let first = "";
	return (message) => {
		if (!message) {
			first = "";
		} else {
			first ||= message;
			deps.log(message);
		}
		try {
			deps.persist(message && first !== message ? `${first}\n${message}` : message);
		} catch {
			// Read-only filesystems must not prevent connection recovery; stderr remains available.
		}
	};
}
