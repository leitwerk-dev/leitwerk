import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export interface ReleaseChartOptions {
	sourceDir: string;
	destinationDir: string;
	version: string;
	gitSha: string;
	serverImage: string;
	workerImage: string;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const IMAGE_PATTERN = /^(?<repository>[^@\s]+)@sha256:[a-f0-9]{64}$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;

export function prepareReleaseChart(options: ReleaseChartOptions): void {
	if (!SEMVER_PATTERN.test(options.version)) {
		throw new Error(`Release chart version is not SemVer: ${options.version}`);
	}
	if (!GIT_SHA_PATTERN.test(options.gitSha)) {
		throw new Error(`Release Git SHA is invalid: ${options.gitSha}`);
	}
	const serverImage = IMAGE_PATTERN.exec(options.serverImage);
	if (!serverImage?.groups?.repository) {
		throw new Error(`Server image must be digest-pinned: ${options.serverImage}`);
	}
	if (!IMAGE_PATTERN.test(options.workerImage)) {
		throw new Error(`Worker image must be digest-pinned: ${options.workerImage}`);
	}

	mkdirSync(path.dirname(options.destinationDir), { recursive: true });
	cpSync(options.sourceDir, options.destinationDir, {
		recursive: true,
		force: false,
		errorOnExist: true,
	});

	updateYaml(path.join(options.destinationDir, "Chart.yaml"), (document) => {
		document.set("version", options.version);
		document.set("appVersion", options.version);
		document.setIn(["annotations", "leitwerk.dev/git-sha"], options.gitSha);
		document.setIn(
			["annotations", "leitwerk.dev/server-image-digest"],
			options.serverImage.split("@")[1],
		);
		document.setIn(
			["annotations", "leitwerk.dev/worker-image-digest"],
			options.workerImage.split("@")[1],
		);
	});
	updateYaml(path.join(options.destinationDir, "values.yaml"), (document) => {
		document.setIn(["server", "image", "repository"], serverImage.groups.repository);
		document.setIn(["server", "image", "tag"], options.version);
		document.setIn(["server", "image", "digest"], options.serverImage.split("@")[1]);
		document.setIn(["workerRuntimeProfiles", "generic", "image"], options.workerImage);
	});
}

function updateYaml(
	filePath: string,
	update: (document: ReturnType<typeof parseDocument>) => void,
) {
	const document = parseDocument(readFileSync(filePath, "utf8"));
	if (document.errors.length > 0) {
		throw new Error(`${filePath}: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	update(document);
	writeFileSync(filePath, document.toString({ lineWidth: 0 }));
}

function readOption(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index < 0 ? undefined : process.argv[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing required option ${name}`);
	}
	return value;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	prepareReleaseChart({
		sourceDir: readOption("--source"),
		destinationDir: readOption("--destination"),
		version: readOption("--version"),
		gitSha: readOption("--git-sha"),
		serverImage: readOption("--server-image"),
		workerImage: readOption("--worker-image"),
	});
}
