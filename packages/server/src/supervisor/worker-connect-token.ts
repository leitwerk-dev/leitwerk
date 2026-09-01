import { createOpaqueToken, hashOpaqueToken, verifyOpaqueToken } from "../auth/auth-tokens.js";

export const createWorkerConnectToken = createOpaqueToken;
export const hashWorkerConnectToken = (token: string): string => hashOpaqueToken(token, "hex");
export const verifyWorkerConnectToken = (token: string, expectedHash: string): boolean =>
	verifyOpaqueToken(token, expectedHash, "hex");
