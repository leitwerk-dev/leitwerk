/** A safe, actionable model-readiness finding. @internal */
export interface DashboardConfigurationIssue {
	/** @internal */
	id: string;
	/** @internal */
	code: string;
	/** @internal */
	severity: "error" | "warning";
	/** @internal */
	message: string;
	/** @internal */
	sources: Array<{
		/** @internal */
		label: string;
		/** Local correction destination, when one exists. @internal */
		href: string | null;
	}>;
}

/** Server-owned overview of the retained installation. @internal */
export interface DashboardResponseBody {
	/** @internal */
	generatedAt: string;
	/** @internal */
	definitions: {
		/** @internal */
		total: number;
		/** @internal */
		items: Array<{
			/** @internal */
			id: string;
			/** @internal */
			name: string;
		}>;
	};
	/** @internal */
	watchers: {
		/** @internal */
		total: number;
		/** @internal */
		enabled: number;
		/** @internal */
		items: Array<{
			/** @internal */
			id: string;
			/** @internal */
			name: string;
			/** @internal */
			enabled: boolean;
		}>;
	};
	/** @internal */
	skills: {
		/** @internal */
		total: number;
		/** Operator-managed and extension-installed skills. @internal */
		installed: number;
		/** Automatically available bundled skills. @internal */
		bundled: number;
	};
	/** @internal */
	processes: {
		/** @internal */
		total: number;
		/** @internal */
		byStatus: Array<{
			/** @internal */
			status: "running" | "waiting" | "error" | "completed" | "aborted";
			/** @internal */
			count: number;
		}>;
		/** @internal */
		byDefinition: Array<{
			/** @internal */
			processId: string;
			/** @internal */
			name: string;
			/** @internal */
			count: number;
		}>;
	};
	/** @internal */
	costs: {
		/** Null when turns exist but no cost has been recorded. @internal */
		totalUsd: number | null;
		/** @internal */
		totalLlmTurnCount: number;
		/** @internal */
		pricedTurnCount: number;
		/** @internal */
		missingCostTurnCount: number;
		/** @internal */
		isPartial: boolean;
		/** Descending by recorded cost. @internal */
		byModel: Array<{
			/** Null when historical model identity is unavailable. @internal */
			providerId: string | null;
			/** @internal */
			modelId: string | null;
			/** @internal */
			costUsd: number;
			/** @internal */
			turnCount: number;
		}>;
	};
	/** @internal */
	configuration: {
		/** @internal */
		issues: DashboardConfigurationIssue[];
	};
}
