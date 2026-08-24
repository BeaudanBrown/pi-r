import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { RecoverableError } from "../r-edit/errors.js";
import {
  ARTIFACT_KINDS,
  PATTERN_KINDS,
  type ArgumentReference,
  type ConstantValue,
  type ContractSummary,
  type ProjectContract,
  type TargetDefinition,
} from "./types.js";

const execFileAsync = promisify(execFile);
const R_NAME = /^(?:[A-Za-z]|\.(?!\d))[A-Za-z0-9._]*$/;
const R_RESERVED = new Set([
  "if",
  "else",
  "repeat",
  "while",
  "function",
  "for",
  "in",
  "next",
  "break",
  "TRUE",
  "FALSE",
  "NULL",
  "Inf",
  "NaN",
  "NA",
  "NA_integer_",
  "NA_real_",
  "NA_complex_",
  "NA_character_",
  "...",
]);

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new RecoverableError("INVALID_CONTRACT", message, details);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) invalid(`${path} contains unknown fields`, { fields: unknown.sort() });
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${path} must be a non-empty string`);
  return value;
}

function rName(value: unknown, path: string): string {
  const name = string(value, path);
  if (!R_NAME.test(name) || R_RESERVED.has(name) || /^\.\.[0-9]+$/.test(name)) {
    invalid(`${path} must be a non-reserved R name`);
  }
  return name;
}

function stringArray(value: unknown, path: string, names = false): string[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  const result = value.map((entry, index) =>
    names ? rName(entry, `${path}[${index}]`) : string(entry, `${path}[${index}]`),
  );
  if (new Set(result).size !== result.length) invalid(`${path} must not contain duplicates`);
  return result;
}

function constantValue(value: unknown, path: string): ConstantValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} must be finite`);
    return value;
  }
  return invalid(`${path} must be a canonical scalar`);
}

function reference(value: unknown, path: string): ArgumentReference {
  const record = object(value, path);
  exactKeys(record, ["target", "constant"], path);
  if (typeof record.target === "string" && record.constant === undefined) {
    return { target: rName(record.target, `${path}.target`) };
  }
  if (typeof record.constant === "string" && record.target === undefined) {
    return { constant: rName(record.constant, `${path}.constant`) };
  }
  return invalid(`${path} must contain exactly one target or constant reference`);
}

function assertAcyclic(targets: TargetDefinition[]): void {
  const dependencies = new Map(
    targets.map((target) => [
      target.name,
      Object.values(target.arguments).flatMap((argument) => ("target" in argument ? [argument.target] : [])),
    ]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) invalid("targets must form an acyclic graph", { target: name });
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of dependencies.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const target of targets) visit(target.name);
}

export function validateContract(input: unknown): ProjectContract {
  const root = object(input, "contract");
  exactKeys(
    root,
    [
      "contractVersion",
      "templateVersion",
      "policyVersion",
      "project",
      "dependencies",
      "constants",
      "functions",
      "targets",
    ],
    "contract",
  );
  if (root.contractVersion !== 1) invalid("contractVersion must be 1");
  if (root.templateVersion !== "pi-r-template-v1") invalid("templateVersion is not supported");
  if (root.policyVersion !== "pi-r-policy-v1") invalid("policyVersion is not supported");

  const projectInput = object(root.project, "project");
  exactKeys(projectInput, ["name", "nixpkgs"], "project");
  const pinInput = object(projectInput.nixpkgs, "project.nixpkgs");
  exactKeys(pinInput, ["owner", "repo", "rev", "narHash", "lastModified"], "project.nixpkgs");
  const rev = string(pinInput.rev, "project.nixpkgs.rev");
  if (!/^[0-9a-f]{40}$/.test(rev)) invalid("project.nixpkgs.rev must be a full Git revision");
  const narHash = string(pinInput.narHash, "project.nixpkgs.narHash");
  if (!narHash.startsWith("sha256-")) invalid("project.nixpkgs.narHash must be an SRI sha256 hash");
  if (!Number.isInteger(pinInput.lastModified) || (pinInput.lastModified as number) <= 0) {
    invalid("project.nixpkgs.lastModified must be a positive integer");
  }

  const dependencies = stringArray(root.dependencies, "dependencies").sort();
  const constantsInput = object(root.constants, "constants");
  const constants = Object.fromEntries(
    Object.keys(constantsInput)
      .sort()
      .map((name) => [rName(name, `constants.${name}`), constantValue(constantsInput[name], `constants.${name}`)]),
  );
  const functionsInput = root.functions;
  if (!Array.isArray(functionsInput) || functionsInput.length === 0) invalid("functions must be a non-empty array");
  const functions = functionsInput.map((entry, index) => {
    const fn = object(entry, `functions[${index}]`);
    exactKeys(fn, ["name", "parameters"], `functions[${index}]`);
    return {
      name: rName(fn.name, `functions[${index}].name`),
      parameters: stringArray(fn.parameters, `functions[${index}].parameters`, true),
    };
  });
  if (new Set(functions.map((fn) => fn.name)).size !== functions.length) invalid("function names must be unique");

  const targetsInput = root.targets;
  if (!Array.isArray(targetsInput) || targetsInput.length === 0) invalid("targets must be a non-empty array");
  if (targetsInput.length > 200) invalid("targets must contain at most 200 entries");
  const targets: TargetDefinition[] = targetsInput.map((entry, index) => {
    const path = `targets[${index}]`;
    const target = object(entry, path);
    exactKeys(target, ["name", "function", "artifact", "arguments", "pattern"], path);
    const artifact = string(target.artifact, `${path}.artifact`);
    if (!(ARTIFACT_KINDS as readonly string[]).includes(artifact)) {
      invalid(`${path}.artifact must be table, object, or file`);
    }
    const argumentsInput = object(target.arguments, `${path}.arguments`);
    const args = Object.fromEntries(
      Object.keys(argumentsInput).map((name) => [
        rName(name, `${path}.arguments.${name}`),
        reference(argumentsInput[name], `${path}.arguments.${name}`),
      ]),
    );
    let pattern: TargetDefinition["pattern"];
    if (target.pattern !== undefined) {
      const patternInput = object(target.pattern, `${path}.pattern`);
      exactKeys(patternInput, ["kind", "over"], `${path}.pattern`);
      const kind = string(patternInput.kind, `${path}.pattern.kind`);
      if (!(PATTERN_KINDS as readonly string[]).includes(kind)) {
        invalid(`${path}.pattern.kind must be map or cross; static branching is not representable`);
      }
      const over = stringArray(patternInput.over, `${path}.pattern.over`, true);
      if (over.length === 0) invalid(`${path}.pattern.over must not be empty`);
      pattern = { kind: kind as "map" | "cross", over };
    }
    return {
      name: rName(target.name, `${path}.name`),
      function: rName(target.function, `${path}.function`),
      artifact: artifact as "table" | "object" | "file",
      arguments: args,
      ...(pattern ? { pattern } : {}),
    };
  });
  if (new Set(targets.map((target) => target.name)).size !== targets.length) invalid("target names must be unique");

  const functionByName = new Map(functions.map((fn) => [fn.name, fn]));
  const targetNames = new Set(targets.map((target) => target.name));
  const constantNames = new Set(Object.keys(constants));
  for (const target of targets) {
    const fn = functionByName.get(target.function);
    if (!fn) invalid(`target '${target.name}' calls an unapproved function`, { function: target.function });
    const argumentNames = Object.keys(target.arguments);
    if (
      argumentNames.length !== fn.parameters.length ||
      fn.parameters.some((parameter) => !argumentNames.includes(parameter))
    ) {
      invalid(`target '${target.name}' arguments must exactly match required function parameters`);
    }
    for (const argument of Object.values(target.arguments)) {
      if ("target" in argument && !targetNames.has(argument.target)) {
        invalid(`target '${target.name}' references unknown target '${argument.target}'`);
      }
      if ("constant" in argument && !constantNames.has(argument.constant)) {
        invalid(`target '${target.name}' references unknown constant '${argument.constant}'`);
      }
    }
    if (target.pattern) {
      const argumentTargets = new Set(
        Object.values(target.arguments).flatMap((argument) => ("target" in argument ? [argument.target] : [])),
      );
      for (const dimension of target.pattern.over) {
        if (!targetNames.has(dimension) || !argumentTargets.has(dimension)) {
          invalid(`target '${target.name}' pattern dimensions must be target arguments`, { dimension });
        }
      }
    }
  }
  assertAcyclic(targets);

  return {
    contractVersion: 1,
    templateVersion: "pi-r-template-v1",
    policyVersion: "pi-r-policy-v1",
    project: {
      name: string(projectInput.name, "project.name"),
      nixpkgs: {
        owner: string(pinInput.owner, "project.nixpkgs.owner"),
        repo: string(pinInput.repo, "project.nixpkgs.repo"),
        rev,
        narHash,
        lastModified: pinInput.lastModified as number,
      },
    },
    dependencies,
    constants,
    functions,
    targets,
  };
}

export async function readContract(path: string): Promise<ProjectContract> {
  try {
    const { stdout } = await execFileAsync(
      process.env.PI_R_RSCRIPT ?? "Rscript",
      ["--vanilla", process.env.PI_R_CONTRACT_READER ?? "", resolve(path)],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    return validateContract(JSON.parse(stdout));
  } catch (error) {
    if (error instanceof RecoverableError) throw error;
    invalid("Contract must be readable YAML", { path: resolve(path) });
  }
}

export function summarizeContract(contract: ProjectContract): ContractSummary {
  return {
    contractVersion: contract.contractVersion,
    templateVersion: contract.templateVersion,
    policyVersion: contract.policyVersion,
    project: contract.project.name,
    dependencies: contract.dependencies,
    functions: contract.functions.map((fn) => fn.name),
    constants: Object.keys(contract.constants),
    targets: contract.targets.map((target) => target.name),
  };
}
