export interface ProcessLaunchNotice {
	instanceId: string;
	message: string;
}

let currentNotice: ProcessLaunchNotice | null = null;

export function queueProcessLaunchNotice(notice: ProcessLaunchNotice): void {
	currentNotice = notice;
}

export function consumeProcessLaunchNotice(instanceId: string): ProcessLaunchNotice | null {
	if (!currentNotice || currentNotice.instanceId !== instanceId) {
		return null;
	}
	const notice = currentNotice;
	currentNotice = null;
	return notice;
}

export function clearProcessLaunchNotice(instanceId?: string): void {
	if (!instanceId || currentNotice?.instanceId === instanceId) {
		currentNotice = null;
	}
}
