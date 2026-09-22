import { createHash, randomBytes } from "node:crypto";

const BASE_DIGEST_SUFFIX_LENGTH = 12;
const MAX_BRANCH_SLUG_LENGTH = 48;
const PROMPT_WORD_COUNT = 5;
const RANDOM_HEX_LENGTH = 3;

function slugifyBranchSource(sourceText: string): string {
	const words =
		sourceText
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[’']/g, "")
			.match(/[a-z0-9]+/g) ?? [];
	const normalized = words.slice(0, PROMPT_WORD_COUNT).join("-");
	const slug =
		normalized.length <= MAX_BRANCH_SLUG_LENGTH
			? normalized
			: normalized.slice(0, MAX_BRANCH_SLUG_LENGTH).replace(/-+$/g, "");
	return slug || "change";
}

function randomHex(): string {
	return randomBytes(2).toString("hex").slice(0, RANDOM_HEX_LENGTH);
}

/** Build a safe branch name without requiring authenticated remote access. */
/** @public */
export function buildAutoWorkBranchFromSeed(
	sourceText: string,
	seed: string,
	suffix = randomHex(),
): string {
	const normalizedSuffix = suffix.trim().toLowerCase();
	if (!new RegExp(`^[0-9a-f]{${RANDOM_HEX_LENGTH}}$`).test(normalizedSuffix)) {
		throw new Error(`Expected ${RANDOM_HEX_LENGTH} random hex characters, got '${suffix}'`);
	}
	const digest = createHash("sha256").update(seed).digest("hex");
	return `${slugifyBranchSource(sourceText)}-${normalizedSuffix}-${digest.slice(0, BASE_DIGEST_SUFFIX_LENGTH)}`;
}
