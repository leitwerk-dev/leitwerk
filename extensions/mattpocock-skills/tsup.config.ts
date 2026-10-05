import { buildSkillPack } from "@leitwerk-dev/dev-tools/skill-pack";
import type { Options } from "tsup";
import { workspaceBuild } from "../../scripts/tsup-config.js";

export default (options: Options) =>
	workspaceBuild({
		watch: options.watch ? ["src", "upstream", "patches", "skill-pack.json"] : false,
		onSuccess: () => buildSkillPack(import.meta.dirname),
	})(options);
