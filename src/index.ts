import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { createEditCandidate } from "./r-edit/scoped-edit.js";
export { errorEnvelope, RecoverableError } from "./r-edit/errors.js";
export type { StructuredError } from "./r-edit/errors.js";
export { inspectRFile } from "./r-edit/tree-sitter.js";
export type { EditCandidate, EditRequest, Inspection, RFunction } from "./r-edit/types.js";

export const VERSION = "0.2.0";

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
