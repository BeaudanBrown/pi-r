import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { readContract, summarizeContract, validateContract } from "./contract/contract.js";
export { checkScaffold, generateScaffold, renderScaffold } from "./contract/scaffold.js";
export type { ProjectContract, ContractSummary } from "./contract/types.js";
export { createEditCandidate } from "./r-edit/scoped-edit.js";
export { errorEnvelope, RecoverableError } from "./r-edit/errors.js";
export type { StructuredError } from "./r-edit/errors.js";
export { inspectRFile } from "./r-edit/tree-sitter.js";
export type { EditCandidate, EditRequest, Inspection, RFunction } from "./r-edit/types.js";

export const VERSION = "0.6.0";

export interface ResourcePaths {
  resources: string;
  extension: string;
  rHelper: string;
}

export function resourcePaths(environment = process.env): ResourcePaths {
  const installedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const resources = environment.PI_R_RESOURCE_ROOT ?? join(installedRoot, "share", "pi-r");
  return {
    resources,
    extension: join(resources, "extensions", "pi-r.ts"),
    rHelper: join(resources, "R", "pi_r_runtime.R"),
  };
}
