import path from "node:path";

/** @internal */
export interface ProcessAnalysisRuntime {
	/** @internal */
	analysisCwd: string;
	/** @internal */
	serverBaseUrl: string;
	/** @internal */
	processWorkspacesDir: string | null;
}

const runtime: ProcessAnalysisRuntime = {
	analysisCwd: path.resolve(process.cwd()),
	serverBaseUrl: "http://localhost",
	processWorkspacesDir: null,
};

/** @internal */
export function configureProcessAnalysisRuntime(overrides: Partial<ProcessAnalysisRuntime>): void {
	runtime.analysisCwd = overrides.analysisCwd
		? path.resolve(overrides.analysisCwd)
		: runtime.analysisCwd;
	runtime.serverBaseUrl = overrides.serverBaseUrl ?? runtime.serverBaseUrl;
	runtime.processWorkspacesDir = overrides.processWorkspacesDir ?? null;
}

/** @internal */
export function getProcessAnalysisRuntime(): ProcessAnalysisRuntime {
	return runtime;
}
