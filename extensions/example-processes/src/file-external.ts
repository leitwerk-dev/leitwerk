import { defineFileExternalSource, type FileExternalInput } from "@leitwerk-dev/process-sdk";

// Keep the persisted source kind stable when moving the process between extensions.
/** @internal */
export const FILE_EXTERNAL_PRESENCE_KIND = "@leitwerk-dev/showcase-processes.file.presence";

/** @internal */
export const fileExternal = {
	/** @internal */
	presence(input: FileExternalInput) {
		return defineFileExternalSource(input, {
			kind: FILE_EXTERNAL_PRESENCE_KIND,
			label: `File present: ${input.path}`,
			description: `Fires when ${input.path} exists`,
			inputMode: "none",
		});
	},
};
