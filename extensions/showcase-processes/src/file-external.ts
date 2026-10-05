import {
	type CoreServerSetupDeps,
	createFileExternalSourceProvider as createProvider,
	defineFileExternalSource,
	type FileExternalInput,
} from "@leitwerk-dev/process-sdk";

/** @internal */
export const FILE_EXTERNAL_INSTRUCTION_KIND = "@leitwerk-dev/showcase-processes.file.instruction";

/** @internal */
export const fileExternal = {
	/** @internal */
	instruction(input: FileExternalInput) {
		return defineFileExternalSource(input, {
			kind: FILE_EXTERNAL_INSTRUCTION_KIND,
			label: `File instruction: ${input.path}`,
			description: `Reads ${input.path} as instruction text`,
			inputMode: "instruction",
		});
	},
};

/** @internal */
export function createFileExternalSourceProvider(
	deps: CoreServerSetupDeps,
	aliases: Partial<Record<string, string>> = {},
) {
	return createProvider(deps, {
		id: "showcase-file-external",
		kind: FILE_EXTERNAL_INSTRUCTION_KIND,
		inputMode: "instruction",
		aliases,
	});
}
