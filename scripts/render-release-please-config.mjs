import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export function releaseAppBotSignoff(appId, appSlug) {
	if (!/^\d+$/u.test(appId)) throw new Error("Release App ID must contain only digits");
	if (!/^[a-z0-9-]+$/u.test(appSlug)) throw new Error("Release App slug is invalid");
	const bot = `${appSlug}[bot]`;
	return `${bot} <${appId}+${bot}@users.noreply.github.com>`;
}

export function renderReleasePleaseConfig({ sourcePath, destinationPath, appId, appSlug }) {
	const config = JSON.parse(readFileSync(sourcePath, "utf8"));
	config.signoff = releaseAppBotSignoff(appId, appSlug);
	writeFileSync(destinationPath, `${JSON.stringify(config, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
	renderReleasePleaseConfig({
		sourcePath: process.env.RELEASE_CONFIG_SOURCE ?? "release-please-config.json",
		destinationPath:
			process.env.RELEASE_CONFIG_DESTINATION ?? ".release-please-runtime-config.json",
		appId: process.env.RELEASE_APP_ID ?? "",
		appSlug: process.env.RELEASE_APP_SLUG ?? "",
	});
}
