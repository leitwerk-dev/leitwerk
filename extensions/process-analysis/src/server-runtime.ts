import path from "node:path";

export interface ProcessAnalysisRuntime {
	analysisCwd: string;
	serverBaseUrl: string;
	processWorkspacesDir: string | null;
}

const runtime: ProcessAnalysisRuntime = {
	analysisCwd: path.resolve(process.cwd()),
	serverBaseUrl: "http://localhost",
	processWorkspacesDir: null,
};

export function configureProcessAnalysisRuntime(overrides: Partial<ProcessAnalysisRuntime>): void {
	runtime.analysisCwd = overrides.analysisCwd
		? path.resolve(overrides.analysisCwd)
		: runtime.analysisCwd;
	runtime.serverBaseUrl = overrides.serverBaseUrl ?? runtime.serverBaseUrl;
	runtime.processWorkspacesDir = overrides.processWorkspacesDir ?? null;
}

export function getProcessAnalysisRuntime(): ProcessAnalysisRuntime {
	return runtime;
}
