import { preserveDeclarationAnnotations } from "../packages/dev-tools/src/api-declarations.js";

const diagnostics = preserveDeclarationAnnotations(process.cwd(), true);
if (diagnostics.length) throw new Error(diagnostics.join("\n"));
