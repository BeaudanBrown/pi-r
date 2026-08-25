import { isAbsolute, posix } from "node:path";
import type { ConstantValue, TargetDefinition } from "./types.js";

const OUTPUT_PARAMETER = /(?:^|_)(?:output|file)?path$/i;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/;
const RESERVED_ROOTS = new Set([".git", ".pi", ".pi-r", "_targets", "R"]);
const RESERVED_FILES = new Set([".envrc", ".gitignore", "_targets.R", "flake.lock", "flake.nix", "pi-r.yml"]);

export function validateDeliverablePath(value: unknown, label = "deliverable path"): string {
  if (typeof value !== "string" || !SAFE_PATH.test(value) || value.includes("//")) {
    throw new Error(`${label} must be a bounded project-relative portable path`);
  }
  const normalized = posix.normalize(value);
  const segments = value.split("/");
  if (normalized !== value || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain traversal or redundant segments`);
  }
  if (RESERVED_ROOTS.has(segments[0]) || RESERVED_FILES.has(value)) {
    throw new Error(`${label} overlaps pi-r runtime or source control paths`);
  }
  return value;
}

export function validateSourcePath(value: unknown, label = "source file path"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || value.includes("\0")) {
    throw new Error(`${label} must be a bounded path`);
  }
  if (!isAbsolute(value)) return validateDeliverablePath(value, label);
  const normalized = posix.normalize(value);
  if (normalized !== value || value.includes("//") || value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain traversal or redundant segments`);
  }
  return value;
}

export function fileTargetOutputs(
  target: TargetDefinition,
  constants: Readonly<Record<string, ConstantValue>>,
): string[] {
  if (target.artifact !== "file") return [];
  if (target.output) {
    const value = constants[target.output.constant];
    return typeof value === "string" ? [value] : [];
  }
  return Object.entries(target.arguments)
    .filter(([parameter, reference]) => OUTPUT_PARAMETER.test(parameter) && "constant" in reference)
    .flatMap(([, reference]) => {
      if (!("constant" in reference)) return [];
      const value = constants[reference.constant];
      return typeof value === "string" ? [value] : [];
    });
}
