/** @internal */
export interface PreparationController {
	/** @internal */
	start(): void;
	/** @internal */
	stop(): Promise<void>;
}

/** Controllers own separate asynchronous reconciliation loops. @internal */
export function createKubernetesPreparation(controllers: PreparationController[]) {
	return {
		/** @internal */
		start() {
			for (const controller of controllers) controller.start();
		},
		/** @internal */
		async stop() {
			await Promise.allSettled(controllers.map((controller) => controller.stop()));
		},
	};
}
