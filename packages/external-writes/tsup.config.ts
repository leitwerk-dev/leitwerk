import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({ entry: ["src/index.ts", "src/internal.ts"], splitting: true });
