import type { Codec } from "./extension-api.js";

export const emptyParamsCodec: Codec<Record<string, never>> = {
	parse() {
		return {};
	},
	serialize(value) {
		return value;
	},
};
