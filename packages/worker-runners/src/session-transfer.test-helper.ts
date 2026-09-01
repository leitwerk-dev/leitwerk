import { PassThrough } from "node:stream";
import type { LeitwerkTransferManifestV1 } from "@leitwerk-dev/session-transfer";
import type { ProcessStateExportHelperRelay } from "./types.js";

export function createExportTestFixture() {
	const manifest: LeitwerkTransferManifestV1 = {
		version: 1,
		instanceId: "proc-1",
		processId: "demo",
		processTitle: "Demo",
		createdAt: "2026-09-01T00:00:00.000Z",
		session: {
			relativePath: "session.jsonl",
			sourceCwd: "/state/workspace",
			cwdRelativeToWorkspace: ".",
		},
		workspace: { relativePath: "workspace", hasLocalState: true },
		projects: [],
	};
	const upload = new PassThrough();
	const relay: ProcessStateExportHelperRelay = {
		exportId: "exp-1",
		credential: "internal-secret",
		waitForPreflight: async () => ({
			manifest,
			preflight: { entriesTotal: 3, logicalBytesTotal: 10 },
		}),
		activateStream: () => upload,
		fail() {},
	};
	return { manifest, relay };
}
