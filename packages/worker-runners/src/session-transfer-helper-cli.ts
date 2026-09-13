import { runSessionTransferHelper } from "./session-transfer-helper.js";

runSessionTransferHelper().catch(() => {
	process.exitCode = 1;
});
