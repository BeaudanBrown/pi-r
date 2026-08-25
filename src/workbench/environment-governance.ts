import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateContract } from "../contract/contract.js";
import { renderScaffold } from "../contract/scaffold.js";
import type { ProjectContract } from "../contract/types.js";
import { RecoverableError } from "../r-edit/errors.js";
import {
  classifyPackage,
  resolvePackages,
  technologyPolicyVersion,
  type ApprovalScope,
  type CommandRunner,
  type PackagePolicyDecision,
  type ResolvedPackage,
} from "../environment/package-governance.js";

export const ENVIRONMENT_PATHS = [
  ".pi-r/manifest.json",
  "_targets.R",
  "flake.lock",
  "flake.nix",
  "pi-r.yml",
] as const;

const INTERNAL_PACKAGES = ["jsonlite", "qs2", "targets"] as const;
const CANDIDATE_PATH = ".pi/tmp/pi-r-environment-candidate.json";
const STAGING_PATH = ".pi/tmp/pi-r-environment-candidate";

export interface DependencyProposal {
  operation: "add" | "remove";
  package: string;
  domain: string;
  rationale: string;
  scope: ApprovalScope;
}

export interface EnvironmentCandidate {
  version: 1;
  policyRegistryVersion: string;
  expectedHead: string;
  proposal: DependencyProposal;
  policy: PackagePolicyDecision;
  resolvedPackages: ResolvedPackage[];
  nextContract: ProjectContract;
  files: Record<string, string>;
  fileHashes: Record<string, string>;
  runtime: string;
}

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function validateProposal(value: DependencyProposal): DependencyProposal {
  if (value.operation !== "add" && value.operation !== "remove") {
    throw new RecoverableError("INVALID_DEPENDENCY_PROPOSAL", "Dependency operation must be add or remove");
  }
  if (value.scope !== "project" && value.scope !== "shared") {
    throw new RecoverableError("INVALID_DEPENDENCY_PROPOSAL", "Dependency approval scope must be project or shared");
  }
  if (typeof value.rationale !== "string" || !value.rationale.trim() || value.rationale.length > 1000) {
    throw new RecoverableError("INVALID_DEPENDENCY_PROPOSAL", "Dependency rationale must contain between 1 and 1000 characters");
  }
  if (typeof value.domain !== "string" || !value.domain.trim() || value.domain.length > 100) {
    throw new RecoverableError("INVALID_DEPENDENCY_PROPOSAL", "Dependency domain must contain between 1 and 100 characters");
  }
  return { ...value, domain: value.domain.trim(), rationale: value.rationale.trim() };
}

function generatedEnvironmentFiles(contract: ProjectContract): Record<string, string> {
  const scaffold = renderScaffold(contract);
  return Object.fromEntries(ENVIRONMENT_PATHS.map((path) => [path, scaffold.get(path) ?? ""]));
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function stageFiles(root: string, files: Record<string, string>): Promise<string> {
  const staging = resolve(root, STAGING_PATH);
  await rm(staging, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const destination = resolve(staging, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  return staging;
}

function localNixpkgsOverride(): string[] {
  const path = process.env.PI_R_NIXPKGS_PATH;
  return path ? ["--override-input", "nixpkgs", `path:${path}`] : [];
}

async function validateCandidateEnvironment(
  staging: string,
  dependencies: string[],
  runner: CommandRunner,
): Promise<string> {
  const nix = process.env.PI_R_NIX ?? "nix";
  const validationCode = [
    "args <- commandArgs(TRUE)",
    "parse(file = args[[1L]])",
    "packages <- args[-1L]",
    "missing <- packages[!vapply(packages, requireNamespace, logical(1L), quietly = TRUE)]",
    "if (length(missing)) stop(sprintf('packages failed to load: %s', paste(missing, collapse = ', ')), call. = FALSE)",
    "cat(sprintf('PI_R_RUNTIME:%s\\n', unname(Sys.which('Rscript'))))",
  ].join("; ");
  const explicitRuntime = process.env.PI_R_PROJECT_RSCRIPT;
  const validation = explicitRuntime
    ? await runner(explicitRuntime, [
      "--vanilla", "-e", validationCode,
      resolve(staging, "_targets.R"), ...dependencies,
    ], { cwd: staging, timeout: 180_000 })
    : await runner(nix, [
      "--extra-experimental-features", "nix-command flakes",
      "develop", ...localNixpkgsOverride(), `path:${staging}`,
      "--command", "Rscript", "--vanilla", "-e", validationCode,
      resolve(staging, "_targets.R"), ...dependencies,
    ], { cwd: staging, timeout: 180_000 });
  if (validation.code !== 0) {
    throw new RecoverableError("ENVIRONMENT_VALIDATION_FAILED", "Candidate R environment or generated target package list failed validation", {
      message: (validation.stderr || validation.stdout).slice(0, 2000),
    });
  }
  if (explicitRuntime) return explicitRuntime;
  const runtimeMatch = validation.stdout.match(/^PI_R_RUNTIME:(\/.+)$/m);
  const path = runtimeMatch?.[1]?.trim();
  if (!path?.startsWith("/")) {
    throw new RecoverableError("ENVIRONMENT_VALIDATION_FAILED", "Candidate environment did not report an absolute Rscript runtime", {
      message: (validation.stderr || validation.stdout).slice(0, 2000),
    });
  }
  return path;
}

export async function validateContractEnvironment(
  projectRoot: string,
  contract: ProjectContract,
  runner: CommandRunner,
  onProgress?: (phase: string) => void,
): Promise<{ runtime: string; resolvedPackages: ResolvedPackage[]; files: Record<string, string> }> {
  onProgress?.("staging candidate environment");
  const files = generatedEnvironmentFiles(contract);
  const staging = await stageFiles(resolve(projectRoot), files);
  const packageNames = [...new Set([...INTERNAL_PACKAGES, ...contract.dependencies])].sort();
  onProgress?.(`resolving ${packageNames.length} R packages`);
  const resolution = await resolvePackages(staging, packageNames, runner);
  onProgress?.("realising environment and loading package namespaces");
  const runtime = await validateCandidateEnvironment(staging, packageNames, runner);
  return { runtime, resolvedPackages: resolution.packages, files };
}

export async function prepareEnvironmentCandidate(
  projectRoot: string,
  expectedHead: string,
  input: DependencyProposal,
  runner: CommandRunner,
): Promise<EnvironmentCandidate> {
  const root = resolve(projectRoot);
  const proposal = validateProposal(input);
  const current = validateContract(JSON.parse(await readFile(resolve(root, "pi-r.yml"), "utf8")));
  const policy = classifyPackage(proposal.package, proposal.domain);
  if (proposal.operation === "add" && policy.status === "prohibited") {
    throw new RecoverableError("PROHIBITED_PACKAGE", policy.rationale, {
      package: proposal.package,
      alternatives: policy.alternatives,
    });
  }
  if (proposal.operation === "add" && current.dependencies.includes(proposal.package)) {
    throw new RecoverableError("DEPENDENCY_PRESENT", `Package is already declared: ${proposal.package}`);
  }
  if (proposal.operation === "remove" && !current.dependencies.includes(proposal.package)) {
    throw new RecoverableError("DEPENDENCY_MISSING", `Package is not declared: ${proposal.package}`);
  }
  if (proposal.operation === "remove" && policy.status === "required") {
    throw new RecoverableError("REQUIRED_PACKAGE", `Technology policy requires package ${proposal.package} for ${proposal.domain}`, {
      package: proposal.package,
      rationale: policy.rationale,
    });
  }

  const dependencies = proposal.operation === "add"
    ? [...current.dependencies, proposal.package].sort()
    : current.dependencies.filter((name) => name !== proposal.package);
  const approvals = { ...current.dependencyApprovals };
  if (proposal.operation === "add") {
    approvals[proposal.package] = {
      scope: proposal.scope,
      domain: proposal.domain,
      rationale: proposal.rationale,
      policyStatus: policy.status === "prohibited" ? "unregistered" : policy.status,
    };
  } else {
    delete approvals[proposal.package];
  }
  const nextContract = validateContract({ ...current, dependencies, dependencyApprovals: approvals });
  const validated = await validateContractEnvironment(root, nextContract, runner);
  const candidate: EnvironmentCandidate = {
    version: 1,
    policyRegistryVersion: technologyPolicyVersion(),
    expectedHead,
    proposal,
    policy,
    resolvedPackages: validated.resolvedPackages,
    nextContract,
    files: validated.files,
    fileHashes: Object.fromEntries(Object.entries(validated.files).map(([path, content]) => [path, hash(content)])),
    runtime: validated.runtime,
  };
  await atomicWrite(resolve(root, CANDIDATE_PATH), `${JSON.stringify(candidate, null, 2)}\n`);
  return candidate;
}

export async function readEnvironmentCandidate(projectRoot: string): Promise<EnvironmentCandidate> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(projectRoot, CANDIDATE_PATH), "utf8"));
  } catch {
    throw new RecoverableError("ENVIRONMENT_CANDIDATE_MISSING", "No validated environment candidate exists; use r_dependency_propose first");
  }
  if (!parsed || typeof parsed !== "object") throw new RecoverableError("INVALID_ENVIRONMENT_CANDIDATE", "Environment candidate is invalid");
  const candidate = parsed as EnvironmentCandidate;
  if (candidate.version !== 1 || typeof candidate.expectedHead !== "string" || typeof candidate.runtime !== "string") {
    throw new RecoverableError("INVALID_ENVIRONMENT_CANDIDATE", "Environment candidate is invalid");
  }
  const nextContract = validateContract(candidate.nextContract);
  const files = generatedEnvironmentFiles(nextContract);
  for (const path of ENVIRONMENT_PATHS) {
    if (candidate.files?.[path] !== files[path] || candidate.fileHashes?.[path] !== hash(files[path])) {
      throw new RecoverableError("INVALID_ENVIRONMENT_CANDIDATE", "Environment candidate generated files failed integrity validation", { path });
    }
  }
  return { ...candidate, nextContract, files };
}

export async function discardEnvironmentCandidate(projectRoot: string): Promise<void> {
  await Promise.all([
    rm(resolve(projectRoot, CANDIDATE_PATH), { force: true }),
    rm(resolve(projectRoot, STAGING_PATH), { recursive: true, force: true }),
  ]);
}
