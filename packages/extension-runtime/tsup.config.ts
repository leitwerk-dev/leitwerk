import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({ entry: ["src/index.ts", "src/testing-entry.ts"] });
