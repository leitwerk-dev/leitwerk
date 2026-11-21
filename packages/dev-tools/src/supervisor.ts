import { develop } from "./dev.js";

await develop({
	workspaceRoot: process.cwd(),
	compositionPath: process.env.LEITWERK_COMPOSITION_PATH,
});
