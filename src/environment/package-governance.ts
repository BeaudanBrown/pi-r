import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import technologyPolicy from "../../resources/technology-policy-v1.json" with { type: "json" };
import { readContract } from "../contract/contract.js";
import type { ProjectContract } from "../contract/types.js";
import { RecoverableError } from "../r-edit/errors.js";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9.]{0,99}$/;
const MAX_CANDIDATES = 5;

export type PackagePolicyStatus = "required" | "preferred" | "allowed" | "prohibited" | "unregistered";
export type ApprovalScope = "project" | "shared";

export interface PolicyDomainSnapshot {
  version: string;
  domain: string;
  packages: Array<{
    package: string;
    status: Exclude<PackagePolicyStatus, "unregistered">;
    rationale: string;
    alternatives: string[];
  }>;
}

export interface SharedPolicyUpdate {
  path: string;
  previous: string | undefined;
  content: string;
}

interface PolicyEntry {
  status: Exclude<PackagePolicyStatus, "unregistered">;
  domains: string[];
  rationale: string;
  alternatives: string[];
}

export interface PackagePolicyDecision {
  package: string;
  domain: string;
  status: PackagePolicyStatus;
  rationale: string;
  alternatives: string[];
  registered: boolean;
}

export interface ResolvedPackage {
  name: string;
  attribute: string;
  exists: boolean;
  available: boolean;
  broken: boolean;
  version: string | null;
  candidates: string[];
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<CommandResult>;

function packageName(value: string): string {
  if (!PACKAGE_NAME.test(value)) {
    throw new RecoverableError("INVALID_PACKAGE_NAME", "R package names must start with a letter and contain only letters, digits, or dots", { package: value });
  }
  return value;
}

export function nixRAttribute(name: string): string {
  return packageName(name).replaceAll(".", "_");
}

export function sharedTechnologyPolicyPath(environment = process.env): string {
  return resolve(
    environment.PI_R_SHARED_POLICY_PATH ??
      `${environment.XDG_CONFIG_HOME ?? resolve(homedir(), ".config")}/pi-r/technology-policy-overrides-v1.json`,
  );
}

function policyEntries(): Record<string, PolicyEntry> {
  let shared: Record<string, PolicyEntry> = {};
  try {
    const parsed = JSON.parse(readFileSync(sharedTechnologyPolicyPath(), "utf8")) as { packages?: unknown };
    if (parsed.packages && typeof parsed.packages === "object" && !Array.isArray(parsed.packages)) {
      shared = parsed.packages as Record<string, PolicyEntry>;
    }
  } catch {
    shared = {};
  }
  return { ...(technologyPolicy.packages as Record<string, PolicyEntry>), ...shared };
}

export function prepareSharedPolicyUpdate(nameInput: string, domain: string, rationale: string): SharedPolicyUpdate {
  const name = packageName(nameInput);
  const path = sharedTechnologyPolicyPath();
  let previous: string | undefined;
  let packages: Record<string, PolicyEntry> = {};
  try {
    previous = readFileSync(path, "utf8");
    const parsed = JSON.parse(previous) as { packages?: unknown };
    if (parsed.packages && typeof parsed.packages === "object" && !Array.isArray(parsed.packages)) {
      packages = parsed.packages as Record<string, PolicyEntry>;
    }
  } catch {
    previous = undefined;
  }
  packages[name] = { status: "allowed", domains: [domain], rationale, alternatives: [] };
  const sorted = Object.fromEntries(Object.entries(packages).sort(([left], [right]) => left.localeCompare(right)));
  const content = `${JSON.stringify({ version: "pi-r-shared-technology-overrides-v1", packages: sorted }, null, 2)}\n`;
  return { path, previous, content };
}

export function classifyPackage(nameInput: string, domainInput: string): PackagePolicyDecision {
  const name = packageName(nameInput);
  const domain = domainInput.trim();
  if (!domain || domain.length > 100) {
    throw new RecoverableError("INVALID_PACKAGE_DOMAIN", "Package problem domain must contain between 1 and 100 characters");
  }
  const entry = policyEntries()[name];
  const globallyBinding = entry?.status === "required" || entry?.status === "prohibited";
  if (!entry || (!globallyBinding && !entry.domains.includes(domain))) {
    return {
      package: name,
      domain,
      status: "unregistered",
      rationale: "No technology-policy decision is registered for this package and problem domain",
      alternatives: [],
      registered: false,
    };
  }
  return {
    package: name,
    domain,
    status: entry.status,
    rationale: entry.rationale,
    alternatives: [...entry.alternatives],
    registered: true,
  };
}

export function declaredPackagePolicy(nameInput: string): PackagePolicyDecision {
  const name = packageName(nameInput);
  const entry = policyEntries()[name];
  if (!entry) {
    return {
      package: name,
      domain: "unclassified",
      status: "unregistered",
      rationale: "No technology-policy decision is registered for this package",
      alternatives: [],
      registered: false,
    };
  }
  return {
    package: name,
    domain: entry.domains[0] ?? "general",
    status: entry.status,
    rationale: entry.rationale,
    alternatives: [...entry.alternatives],
    registered: true,
  };
}

export function technologyPolicyVersion(): string {
  return technologyPolicy.version;
}

export function policyForDomain(domainInput: string): PolicyDomainSnapshot {
  const domain = domainInput.trim();
  if (!domain || domain.length > 100) throw new RecoverableError("INVALID_PACKAGE_DOMAIN", "Package problem domain must contain between 1 and 100 characters");
  const packages = Object.entries(policyEntries())
    .filter(([, entry]) => entry.domains.includes(domain) || entry.status === "required" || entry.status === "prohibited")
    .map(([name, entry]) => ({
      package: name,
      status: entry.status,
      rationale: entry.rationale,
      alternatives: [...entry.alternatives],
    }))
    .sort((left, right) => left.package.localeCompare(right.package));
  return { version: technologyPolicy.version, domain, packages };
}

function nixString(value: string): string {
  return JSON.stringify(value);
}

function pinnedPackagesExpression(projectPath: string): string {
  const local = process.env.PI_R_NIXPKGS_PATH;
  if (local) return `import (builtins.toPath ${nixString(local)}) { system = builtins.currentSystem; }`;
  return `(builtins.getFlake ${nixString(`path:${projectPath}`)}).inputs.nixpkgs.legacyPackages.\${builtins.currentSystem}`;
}

function exactResolutionExpression(projectPath: string, names: string[]): string {
  const requested = names.map((name) => nixString(name)).join(" ");
  return `let
  pkgs = ${pinnedPackagesExpression(projectPath)};
  rPackages = pkgs.rPackages;
  inspect = name:
    let attribute = builtins.replaceStrings [ "." ] [ "_" ] name;
    in if !(builtins.hasAttr attribute rPackages) then {
      inherit name attribute;
      exists = false; available = false; broken = false; version = null;
    } else let package = builtins.getAttr attribute rPackages; in {
      inherit name attribute;
      exists = true;
      broken = package.meta.broken or false;
      available = pkgs.lib.meta.availableOn pkgs.stdenv.hostPlatform package;
      version = package.version or ((builtins.parseDrvName package.name).version or null);
    };
in map inspect [ ${requested} ]`;
}

function attributeNamesExpression(projectPath: string): string {
  return `let
  pkgs = ${pinnedPackagesExpression(projectPath)};
in builtins.attrNames pkgs.rPackages`;
}

async function defaultRunner(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
      timeout: options?.timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : String(error),
    };
  }
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function candidateNames(name: string, attributes: string[]): string[] {
  const packages = [...new Set(attributes.map((attribute) => attribute.replaceAll("_", ".")))];
  return packages
    .map((candidate) => ({ candidate, distance: editDistance(name.toLowerCase(), candidate.toLowerCase()) }))
    .filter(({ distance }) => distance <= Math.max(3, Math.floor(name.length / 2)))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
    .slice(0, MAX_CANDIDATES)
    .map(({ candidate }) => candidate);
}

function parseResolution(value: string): Omit<ResolvedPackage, "candidates">[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RecoverableError("INVALID_NIX_RESULT", "Pinned Nixpkgs resolver returned invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new RecoverableError("INVALID_NIX_RESULT", "Pinned Nixpkgs resolver returned an invalid package list");
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.attribute !== "string" || typeof item.exists !== "boolean") return [];
    return [{
      name: item.name,
      attribute: item.attribute,
      exists: item.exists,
      available: item.available === true,
      broken: item.broken === true,
      version: typeof item.version === "string" ? item.version : null,
    }];
  });
}

export async function resolvePackages(
  projectPath: string,
  namesInput: string[],
  runner: CommandRunner = defaultRunner,
): Promise<{ packages: ResolvedPackage[] }> {
  const names = [...new Set(namesInput.map(packageName))];
  if (names.length === 0 || names.length > 100) {
    throw new RecoverableError("INVALID_PACKAGE_REQUEST", "Resolve between 1 and 100 unique R package names");
  }
  const nix = process.env.PI_R_NIX ?? "nix";
  const exact = await runner(nix, [
    "--extra-experimental-features", "nix-command flakes",
    "eval", "--json", "--impure", "--expr", exactResolutionExpression(projectPath, names),
  ], { cwd: projectPath, timeout: 120_000 });
  if (exact.code !== 0) {
    throw new RecoverableError("PACKAGE_RESOLUTION_FAILED", "Pinned Nixpkgs package resolution failed", {
      message: exact.stderr.slice(0, 2000),
    });
  }
  const resolved = parseResolution(exact.stdout);
  if (resolved.length !== names.length) throw new RecoverableError("INVALID_NIX_RESULT", "Pinned Nixpkgs resolver omitted requested packages");
  const missing = resolved.filter((entry) => !entry.exists);
  let attributes: string[] = [];
  if (missing.length) {
    const candidates = await runner(nix, [
      "--extra-experimental-features", "nix-command flakes",
      "eval", "--json", "--impure", "--expr", attributeNamesExpression(projectPath),
    ], { cwd: projectPath, timeout: 120_000 });
    if (candidates.code === 0) {
      try {
        const parsed = JSON.parse(candidates.stdout);
        if (Array.isArray(parsed)) attributes = parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 50_000);
      } catch {
        attributes = [];
      }
    }
  }
  const packages = resolved.map((entry) => ({
    ...entry,
    candidates: entry.exists ? [] : candidateNames(entry.name, attributes),
  }));
  if (missing.length) {
    throw new RecoverableError("UNKNOWN_PACKAGE", "Some R packages do not exist in the project's pinned Nixpkgs", {
      packages: packages.filter((entry) => !entry.exists).map(({ name, candidates }) => ({ name, candidates })),
    });
  }
  const unavailable = packages.filter((entry) => !entry.available || entry.broken);
  if (unavailable.length) {
    throw new RecoverableError("PACKAGE_UNAVAILABLE", "Some R packages are unavailable or broken in the project's pinned Nixpkgs", {
      packages: unavailable.map(({ name, attribute, version, available, broken }) => ({ name, attribute, version, available, broken })),
    });
  }
  return { packages };
}

export async function resolveContractPackages(contractPath: string, names: string[]): Promise<{ contract: ProjectContract; packages: ResolvedPackage[] }> {
  const contract = await readContract(contractPath);
  const result = await resolvePackages(dirname(resolve(contractPath)), names);
  return { contract, packages: result.packages };
}
