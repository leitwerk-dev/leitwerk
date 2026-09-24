// npm's trust list --json mixes browser-auth output with publisher output.
// Keep npm's terminal intact and send only its structured registry response on fd 3.
// This adapter depends on npm internals; unsupported versions must fail closed.
const { writeSync } = require("node:fs");
const path = require("node:path");

const cli = process.argv[1];
if (!cli || process.argv[2] !== "trust" || process.argv[3] !== "list") {
	throw new Error("The npm trust JSON adapter only supports trust list");
}
const root = path.resolve(path.dirname(cli), "..");
const { version } = require(path.join(root, "package.json"));
const [major, minor] = version.split(".").map(Number);
if (major !== 11 || minor < 16) {
	throw new Error("The npm trust JSON adapter requires npm 11.16+ within npm 11");
}
const TrustList = require(path.join(root, "lib/commands/trust/list.js"));
if (typeof TrustList.prototype.displayResponseBody !== "function") {
	throw new Error("Unsupported npm trust response API");
}
let emitted = false;
TrustList.prototype.displayResponseBody = ({ body, packageName }) => {
	if (emitted || !Array.isArray(body)) {
		throw new Error("Unexpected npm trust registry response");
	}
	emitted = true;
	writeSync(3, JSON.stringify({ packageName, publishers: body }));
};
