import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RecoverableError } from "../r-edit/errors.js";
import { inspectRFile } from "../r-edit/tree-sitter.js";
import { fileTargetOutputs } from "./deliverables.js";
import { isSourceFileTarget, type ConstantValue, type ProjectContract, type TargetDefinition } from "./types.js";

export type GeneratedFiles = ReadonlyMap<string, string>;

const MACHINE_OWNED = [
  ".envrc",
  ".gitignore",
  "R/constants.R",
  "_targets.R",
  "flake.lock",
  "flake.nix",
  "pi-r.yml",
] as const;

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function rValue(value: ConstantValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    return String(value);
  }
  throw new Error("Validated constant was not scalar");
}

function constantsFile(contract: ProjectContract): string {
  const entries = Object.entries(contract.constants);
  if (entries.length === 0) return "PI_R_CONSTANTS <- list()\n";
  return `PI_R_CONSTANTS <- list(\n${entries
    .map(([name, value]) => `  ${name} = ${rValue(value)}`)
    .join(",\n")}\n)\n`;
}

function functionFile(name: string, parameters: string[]): string {
  return `${name} <- function(${parameters.join(", ")}) {\n  stop("Not implemented: ${name}", call. = FALSE)\n}\n`;
}

function argumentExpression(reference: TargetDefinition["arguments"][string]): string {
  return "target" in reference ? reference.target : `PI_R_CONSTANTS$${reference.constant}`;
}

function targetExpression(target: TargetDefinition, contract: ProjectContract): string {
  if (isSourceFileTarget(target)) {
    return `  tar_target(${target.name}, PI_R_CONSTANTS$${target.source.constant}, format = "file")`;
  }
  const fn = contract.functions.find((candidate) => candidate.name === target.function);
  if (!fn) throw new Error(`Validated function '${target.function}' disappeared`);
  const callArguments = fn.parameters
    .map((parameter) => {
      const reference = target.arguments[parameter] ?? (
        target.output?.parameter === parameter ? { constant: target.output.constant } : undefined
      );
      if (!reference) throw new Error(`Validated target '${target.name}' lost parameter '${parameter}'`);
      return `${parameter} = ${argumentExpression(reference)}`;
    })
    .join(", ");
  const format = target.artifact === "file" ? "file" : "qs";
  const pattern = target.pattern
    ? `, pattern = ${target.pattern.kind}(${target.pattern.over.join(", ")})`
    : "";
  return `  tar_target(${target.name}, ${target.function}(${callArguments}), format = "${format}"${pattern})`;
}

function targetsFile(contract: ProjectContract): string {
  const sources = ["R/constants.R", ...contract.functions.map((fn) => `R/${fn.name}.R`)];
  const packages = contract.dependencies.map((dependency) => JSON.stringify(dependency)).join(", ");
  return [
    "library(targets)",
    "",
    ...sources.map((path) => `source(${JSON.stringify(path)}, local = TRUE)`),
    "",
    `tar_option_set(packages = c(${packages}), workspace_on_error = TRUE)`,
    "",
    "list(",
    contract.targets.map((target) => targetExpression(target, contract)).join(",\n"),
    ")",
    "",
  ].join("\n");
}

function nixRAttribute(packageName: string): string {
  return packageName.replace(/[^A-Za-z0-9_'-]/g, "_");
}

function flakeFile(contract: ProjectContract): string {
  const pin = contract.project.nixpkgs;
  const dependencies = [...new Set(["jsonlite", "qs2", "targets", ...contract.dependencies])].sort();
  const rPackages = dependencies
    .map((dependency) => `rPackages.${JSON.stringify(nixRAttribute(dependency))}`)
    .join(" ");
  return `{
  description = ${JSON.stringify(`Generated pi-r project: ${contract.project.name}`)};

  inputs.nixpkgs.url = ${JSON.stringify(`github:${pin.owner}/${pin.repo}/${pin.rev}`)};

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.\${system};
          rEnv = pkgs.rWrapper.override {
            packages = with pkgs; [ ${rPackages} ];
          };
        in {
          default = pkgs.mkShell { packages = [ rEnv ]; };
        });
    };
}
`;
}

function gitignoreFile(contract: ProjectContract): string {
  const versioned = new Set(contract.deliverables.map((deliverable) => deliverable.path));
  const runtimeOutputs = contract.targets
    .flatMap((target) => fileTargetOutputs(target, contract.constants))
    .filter((path) => !versioned.has(path))
    .sort();
  return [
    ".direnv/",
    ".pi/tmp/",
    ".RData",
    ".Rhistory",
    "_targets/",
    ...runtimeOutputs.map((path) => `/${path}`),
    "",
  ].join("\n");
}

function lockFile(contract: ProjectContract): string {
  const pin = contract.project.nixpkgs;
  return `${JSON.stringify(
    {
      nodes: {
        nixpkgs: {
          locked: {
            lastModified: pin.lastModified,
            narHash: pin.narHash,
            owner: pin.owner,
            repo: pin.repo,
            rev: pin.rev,
            type: "github",
          },
          original: {
            owner: pin.owner,
            repo: pin.repo,
            rev: pin.rev,
            type: "github",
          },
        },
        root: { inputs: { nixpkgs: "nixpkgs" } },
      },
      root: "root",
      version: 7,
    },
    null,
    2,
  )}\n`;
}

export function renderScaffold(contract: ProjectContract): GeneratedFiles {
  const canonicalContract = `${JSON.stringify(contract, null, 2)}\n`;
  const files = new Map<string, string>([
    [".envrc", "use flake\n"],
    [".gitignore", gitignoreFile(contract)],
    ["R/constants.R", constantsFile(contract)],
    ["_targets.R", targetsFile(contract)],
    ["flake.lock", lockFile(contract)],
    ["flake.nix", flakeFile(contract)],
    ["pi-r.yml", canonicalContract],
  ]);
  for (const fn of contract.functions) files.set(`R/${fn.name}.R`, functionFile(fn.name, fn.parameters));

  const manifest = {
    contractHash: hash(canonicalContract),
    contractVersion: contract.contractVersion,
    machineOwned: Object.fromEntries(MACHINE_OWNED.map((path) => [path, hash(files.get(path) ?? "")])),
    policyVersion: contract.policyVersion,
    templateVersion: contract.templateVersion,
  };
  files.set(".pi-r/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return new Map([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export async function generateScaffold(contract: ProjectContract, outputPath: string): Promise<string[]> {
  const output = resolve(outputPath);
  try {
    await access(output);
    throw new RecoverableError("OUTPUT_EXISTS", "Generation output already exists", { path: output });
  } catch (error) {
    if (error instanceof RecoverableError) throw error;
  }
  const files = renderScaffold(contract);
  await mkdir(output, { recursive: true });
  for (const [path, content] of files) {
    const destination = join(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  return [...files.keys()];
}

export async function checkScaffold(contract: ProjectContract, projectPath: string): Promise<void> {
  const project = resolve(projectPath);
  const expected = renderScaffold(contract);
  const drift = new Set<string>();
  for (const path of [...MACHINE_OWNED, ".pi-r/manifest.json"]) {
    try {
      if ((await readFile(join(project, path), "utf8")) !== expected.get(path)) drift.add(path);
    } catch {
      drift.add(path);
    }
  }

  for (const fn of contract.functions) {
    const relativePath = `R/${fn.name}.R`;
    try {
      const source = await readFile(join(project, relativePath), "utf8");
      const inspection = await inspectRFile(join(project, relativePath));
      const expectedSignature = `${fn.name} <- function(${fn.parameters.join(", ")})`;
      const discovered = inspection.functions[0];
      const expectedSource = expected.get(relativePath) ?? "";
      const expectedBodyStart = Buffer.byteLength(`${expectedSignature} `, "utf8");
      const expectedBodyEnd = Buffer.byteLength(expectedSource.trimEnd(), "utf8");
      const sourceBytes = Buffer.from(source, "utf8");
      const expectedBytes = Buffer.from(expectedSource, "utf8");
      const outsideBodyMatches =
        discovered &&
        sourceBytes.subarray(0, discovered.bodyRange.startByte).equals(expectedBytes.subarray(0, expectedBodyStart)) &&
        sourceBytes.subarray(discovered.bodyRange.endByte).equals(expectedBytes.subarray(expectedBodyEnd));
      if (
        inspection.functions.length !== 1 ||
        !discovered ||
        discovered.name !== fn.name ||
        discovered.signature !== expectedSignature ||
        !outsideBodyMatches
      ) {
        drift.add(relativePath);
      }
    } catch (error) {
      if (
        error instanceof RecoverableError &&
        ["RUNTIME_INCOMPATIBLE", "TREE_SITTER_FAILURE"].includes(error.structured.code)
      ) {
        throw error;
      }
      drift.add(relativePath);
    }
  }

  if (drift.size > 0) {
    throw new RecoverableError(
      "DRIFT_DETECTED",
      "Generated project does not match its locked contract",
      { paths: [...drift].sort() },
    );
  }
}
