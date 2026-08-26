import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { readContract, summarizeContract, validateContract } from "./contract/contract.js";
export { checkScaffold, generateScaffold, renderScaffold } from "./contract/scaffold.js";
export type { ProjectContract, ContractSummary, VersionedDeliverable } from "./contract/types.js";
export { classifyPackage, policyForDomain, resolveContractPackages, resolvePackages, technologyPolicyVersion } from "./environment/package-governance.js";
export type { ApprovalScope, PackagePolicyDecision, PackagePolicyStatus, ResolvedPackage } from "./environment/package-governance.js";
export { createEditCandidate } from "./r-edit/scoped-edit.js";
export { errorEnvelope, RecoverableError } from "./r-edit/errors.js";
export type { StructuredError } from "./r-edit/errors.js";
export { assertTreeSitterParse, inspectRFile } from "./r-edit/tree-sitter.js";
export { assertBaseRParse } from "./r-edit/tooling.js";
export { validateContractEnvironment } from "./workbench/environment-governance.js";
export type { EditCandidate, EditRequest, Inspection, RFunction } from "./r-edit/types.js";

export const VERSION = "0.20.0";

export interface ResourcePaths {
  resources: string;
  extension: string;
  scoutExtension: string;
  skill: string;
  reference: string;
  rHelper: string;
  technologyPolicy: string;
}

export function resourcePaths(environment = process.env): ResourcePaths {
  const installedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const resources = environment.PI_R_TEST_RESOURCE_ROOT ?? environment.PI_R_RESOURCE_ROOT ?? join(installedRoot, "share", "pi-r");
  return {
    resources,
    extension: join(resources, "extensions", "pi-r.ts"),
    scoutExtension: join(resources, "extensions", "pi-r-dependency-scout.ts"),
    skill: join(resources, "skills", "pi-r", "SKILL.md"),
    reference: join(resources, "skills", "pi-r", "references", "workbench.md"),
    rHelper: join(resources, "R", "pi_r_runtime.R"),
    technologyPolicy: join(resources, "resources", "technology-policy-v1.json"),
  };
}
