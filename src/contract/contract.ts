import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { RecoverableError } from "../r-edit/errors.js";
import { fileTargetOutputs, validateDeliverablePath, validateSourcePath } from "./deliverables.js";
import {
  ARTIFACT_KINDS,
  BEHAVIOR_REVIEW_CATEGORIES,
  PATTERN_KINDS,
  type BehaviorEvidence,
  type ArgumentReference,
  type ConstantValue,
  type ContractSummary,
  type NixpkgsPin,
  type ProjectContract,
  isSourceFileTarget,
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

function boundedString(value: unknown, path: string, maxLength: number): string {
  const result = string(value, path);
  if (result.length > maxLength) invalid(`${path} must contain at most ${maxLength} characters`);
  return result;
}

function rName(value: unknown, path: string): string {
  const name = string(value, path);
  if (name.length > 100) invalid(`${path} must contain at most 100 characters`);
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

function proposalSemanticIssues(proposal: Record<string, unknown>): string[] {
  if (!Array.isArray(proposal.functions) || !Array.isArray(proposal.targets)) return [];
  const issues: string[] = [];
  const constants = proposal.constants && typeof proposal.constants === "object" && !Array.isArray(proposal.constants)
    ? proposal.constants as Record<string, unknown>
    : {};
  const constantNames = new Set(Object.keys(constants));
  const functions = proposal.functions.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    return typeof value.name === "string" && Array.isArray(value.parameters)
      ? [{ name: value.name, parameters: value.parameters.filter((item): item is string => typeof item === "string") }]
      : [];
  });
  const duplicateFunctions = functions.map((fn) => fn.name).filter((name, index, all) => all.indexOf(name) !== index);
  if (duplicateFunctions.length) issues.push(`functions: duplicate names [${[...new Set(duplicateFunctions)].sort().join(", ")}]`);
  const functionByName = new Map(functions.map((fn) => [fn.name, fn]));
  const functionNames = new Set(functionByName.keys());
  const targetRecords = proposal.targets.map((entry, index) => ({
    index,
    value: entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined,
  }));
  const targetNames = new Set(targetRecords.flatMap(({ value }) => typeof value?.name === "string" ? [value.name] : []));
  const duplicateTargets = [...targetNames].filter((name) => targetRecords.filter(({ value }) => value?.name === name).length > 1);
  if (duplicateTargets.length) issues.push(`targets: duplicate names [${duplicateTargets.sort().join(", ")}]`);
  const sourcePaths = new Set<string>();
  const generatedPaths = new Set<string>();

  targetRecords.forEach(({ value: target, index }) => {
    if (!target) return;
    const path = `targets[${index}]`;
    const name = typeof target.name === "string" ? target.name : path;
    if (functionNames.has(name)) issues.push(`${path}: target name '${name}' must differ from Approved Function names`);
    const source = target.source !== undefined;
    if (source) {
      if (target.artifact !== "file") issues.push(`${path}: Source File Target artifact must be file`);
      if (target.function !== undefined) issues.push(`${path}: Source File Target must omit function`);
      if (target.output !== undefined) issues.push(`${path}: Source File Target must omit generated output binding`);
      if (target.pattern !== undefined) issues.push(`${path}: Source File Target must omit dynamic pattern`);
      if (target.arguments && typeof target.arguments === "object" && Object.keys(target.arguments).length > 0) {
        issues.push(`${path}: Source File Target arguments must be empty`);
      }
      const sourceRecord = target.source && typeof target.source === "object" && !Array.isArray(target.source)
        ? target.source as Record<string, unknown>
        : undefined;
      const constant = sourceRecord?.constant;
      if (typeof constant !== "string" || !constantNames.has(constant)) {
        issues.push(`${path}: Source File Target must reference a declared path constant`);
      } else if (typeof constants[constant] !== "string") {
        issues.push(`${path}: Source File Target constant '${constant}' must be a string path`);
      } else {
        const sourcePath = constants[constant] as string;
        sourcePaths.add(sourcePath);
        try {
          validateSourcePath(sourcePath, `${path}.source path`);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : `${path}: invalid source path`);
        }
      }
      return;
    }
    if (typeof target.function !== "string" || !functionNames.has(target.function)) {
      issues.push(`${path}: target '${name}' must call a declared Approved Function`);
    }
    if (target.artifact === "file" && target.output === undefined) {
      issues.push(`${path}: generated file target must declare output { parameter, constant }; use source for an existing input file`);
    }
    const fn = typeof target.function === "string" ? functionByName.get(target.function) : undefined;
    const argumentsRecord = target.arguments && typeof target.arguments === "object" && !Array.isArray(target.arguments)
      ? target.arguments as Record<string, unknown>
      : {};
    const argumentNames = Object.keys(argumentsRecord);
    for (const [parameter, rawReference] of Object.entries(argumentsRecord)) {
      const reference = rawReference && typeof rawReference === "object" && !Array.isArray(rawReference)
        ? rawReference as Record<string, unknown>
        : {};
      if (typeof reference.target === "string" && !targetNames.has(reference.target)) {
        issues.push(`${path}.arguments.${parameter}: unknown target '${reference.target}'`);
      }
      if (typeof reference.constant === "string" && !constantNames.has(reference.constant)) {
        issues.push(`${path}.arguments.${parameter}: unknown constant '${reference.constant}'`);
      }
    }
    const output = target.output && typeof target.output === "object" && !Array.isArray(target.output)
      ? target.output as Record<string, unknown>
      : undefined;
    if (typeof output?.parameter === "string" && argumentNames.includes(output.parameter)) {
      issues.push(`${path}: output parameter '${output.parameter}' must not also appear in arguments`);
    }
    if (typeof output?.constant === "string") {
      if (!constantNames.has(output.constant) || typeof constants[output.constant] !== "string") {
        issues.push(`${path}: generated output must reference a declared string constant`);
      } else {
        const outputPath = constants[output.constant] as string;
        generatedPaths.add(outputPath);
        try {
          validateDeliverablePath(outputPath, `${path}.output path`);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : `${path}: invalid output path`);
        }
      }
    }
    if (fn) {
      const bound = [...argumentNames, ...(typeof output?.parameter === "string" ? [output.parameter] : [])];
      const missing = fn.parameters.filter((parameter) => !bound.includes(parameter));
      const extra = bound.filter((parameter) => !fn.parameters.includes(parameter));
      if (missing.length || extra.length) {
        issues.push(`${path}: bindings must exactly match ${target.function}(${fn.parameters.join(", ")}); missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`);
      }
    }
  });

  for (const path of sourcePaths) {
    if (generatedPaths.has(path)) issues.push(`targets: source path '${path}' must not also be a generated output`);
  }
  if (Array.isArray(proposal.deliverables)) {
    proposal.deliverables.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const value = entry as Record<string, unknown>;
      if (typeof value.path === "string") {
        try {
          validateDeliverablePath(value.path, `deliverables[${index}].path`);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : `deliverables[${index}]: invalid path`);
        }
      }
      if (typeof value.target === "string") {
        const target = targetRecords.find(({ value: candidate }) => candidate?.name === value.target)?.value;
        if (!target) issues.push(`deliverables[${index}]: unknown target '${value.target}'`);
        else if (target.source !== undefined) issues.push(`deliverables[${index}]: Source File Targets cannot be Versioned Deliverables`);
        else if (target.artifact !== "file") issues.push(`deliverables[${index}]: target '${value.target}' is not a generated file target`);
      }
    });
  }
  return [...new Set(issues)];
}

export function normalizeContractProposal(input: unknown, nixpkgs: NixpkgsPin): ProjectContract {
  const proposal = object(input, "proposal");
  exactKeys(
    proposal,
    ["project", "dependencies", "dependencyApprovals", "deliverables", "constants", "functions", "targets"],
    "proposal",
  );
  const project = object(proposal.project, "proposal.project");
  exactKeys(project, ["name"], "proposal.project");
  const issues = proposalSemanticIssues(proposal);
  if (Array.isArray(proposal.functions)) {
    proposal.functions.forEach((entry, index) => {
      const candidate = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      if (typeof candidate.purpose !== "string" || candidate.purpose.length === 0) {
        issues.push(`functions[${index}].purpose: new proposals must state the user-approved domain purpose`);
      }
      if (!Array.isArray(candidate.requirements) || candidate.requirements.length === 0) {
        issues.push(`functions[${index}].requirements: new proposals must state at least one user-approved behavioral requirement`);
      }
      if (!candidate.behaviorReview || typeof candidate.behaviorReview !== "object" || Array.isArray(candidate.behaviorReview)) {
        issues.push(`functions[${index}].behaviorReview: new proposals must review every behavioral category`);
      }
      if (!Array.isArray(candidate.behaviorEvidence) || candidate.behaviorEvidence.length === 0) {
        issues.push(`functions[${index}].behaviorEvidence: new proposals must identify user, source, or policy evidence`);
      }
    });
  }
  if (issues.length > 0) {
    invalid(`proposal has ${issues.length} semantic issue${issues.length === 1 ? "" : "s"}:\n- ${issues.join("\n- ")}\nAll listed issues must be corrected together; unlisted fields have not yet passed authoritative validation.`, {
      issues,
    });
  }
  return validateContract({
    contractVersion: 1,
    templateVersion: "pi-r-template-v1",
    policyVersion: "pi-r-policy-v1",
    ...proposal,
    project: { name: project.name, nixpkgs },
  });
}

export function unspecifiedBehaviorFunctions(contract: ProjectContract): string[] {
  return contract.functions
    .filter((fn) =>
      typeof fn.purpose !== "string" ||
      fn.purpose.length === 0 ||
      !Array.isArray(fn.requirements) ||
      fn.requirements.length === 0 ||
      !fn.behaviorReview ||
      BEHAVIOR_REVIEW_CATEGORIES.some((category) => !fn.behaviorReview?.[category]) ||
      !Array.isArray(fn.behaviorEvidence) ||
      fn.behaviorEvidence.length === 0,
    )
    .map((fn) => fn.name);
}

export function validateLockableContract(input: unknown): ProjectContract {
  const contract = validateContract(input);
  const unspecified = unspecifiedBehaviorFunctions(contract);
  if (unspecified.length > 0) {
    invalid(
      `contract cannot be locked: ${unspecified.length} Approved Function${unspecified.length === 1 ? "" : "s"} lack purpose or behavioral requirements: ${unspecified.join(", ")}. Use the behavior proposal capability and resolve every missing decision before /r lock`,
      { code: "BEHAVIOR_INCOMPLETE", functions: unspecified },
    );
  }
  return contract;
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
      "dependencyApprovals",
      "deliverables",
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
  if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(narHash)) invalid("project.nixpkgs.narHash must be a complete SRI sha256 hash");
  if (!Number.isInteger(pinInput.lastModified) || (pinInput.lastModified as number) <= 0) {
    invalid("project.nixpkgs.lastModified must be a positive integer");
  }

  const dependencies = stringArray(root.dependencies, "dependencies").sort();
  const approvalsInput = root.dependencyApprovals === undefined ? {} : object(root.dependencyApprovals, "dependencyApprovals");
  const dependencyApprovals = Object.fromEntries(Object.keys(approvalsInput).sort().map((name) => {
    if (!/^[A-Za-z][A-Za-z0-9.]{0,99}$/.test(name)) invalid(`dependencyApprovals.${name} must name an R package`);
    if (!dependencies.includes(name)) invalid(`dependencyApprovals.${name} must refer to a declared dependency`);
    const path = `dependencyApprovals.${name}`;
    const approval = object(approvalsInput[name], path);
    exactKeys(approval, ["scope", "domain", "rationale", "policyStatus"], path);
    const scope = string(approval.scope, `${path}.scope`);
    if (scope !== "project" && scope !== "shared") invalid(`${path}.scope must be project or shared`);
    const policyStatus = string(approval.policyStatus, `${path}.policyStatus`);
    if (!["required", "preferred", "allowed", "unregistered"].includes(policyStatus)) {
      invalid(`${path}.policyStatus is not approvable`);
    }
    return [name, {
      scope: scope as "project" | "shared",
      domain: string(approval.domain, `${path}.domain`),
      rationale: string(approval.rationale, `${path}.rationale`),
      policyStatus: policyStatus as "required" | "preferred" | "allowed" | "unregistered",
    }];
  }));
  const constantsInput = object(root.constants, "constants");
  const constants = Object.fromEntries(
    Object.keys(constantsInput)
      .sort()
      .map((name) => [rName(name, `constants.${name}`), constantValue(constantsInput[name], `constants.${name}`)]),
  );
  const functionsInput = root.functions;
  if (!Array.isArray(functionsInput)) invalid("functions must be an array");
  if (functionsInput.length > 200) invalid("functions must contain at most 200 entries");
  const functions = functionsInput.map((entry, index) => {
    const fn = object(entry, `functions[${index}]`);
    const path = `functions[${index}]`;
    exactKeys(fn, ["name", "parameters", "purpose", "requirements", "behaviorReview", "behaviorEvidence"], path);
    let requirements: string[] | undefined;
    if (fn.requirements !== undefined) {
      requirements = stringArray(fn.requirements, `${path}.requirements`).map((requirement, requirementIndex) =>
        boundedString(requirement, `${path}.requirements[${requirementIndex}]`, 300),
      );
      if (requirements.length === 0 || requirements.length > 10) {
        invalid(`${path}.requirements must contain between 1 and 10 entries`);
      }
    }
    let behaviorReview: Record<(typeof BEHAVIOR_REVIEW_CATEGORIES)[number], string> | undefined;
    if (fn.behaviorReview !== undefined) {
      const review = object(fn.behaviorReview, `${path}.behaviorReview`);
      exactKeys(review, [...BEHAVIOR_REVIEW_CATEGORIES], `${path}.behaviorReview`);
      behaviorReview = Object.fromEntries(BEHAVIOR_REVIEW_CATEGORIES.map((category) => {
        const statement = boundedString(review[category], `${path}.behaviorReview.${category}`, 300);
        if (/^(?:tbd|todo|unknown|unresolved|pending|not yet|to be determined)(?:\b|:)/i.test(statement.trim())) {
          invalid(`${path}.behaviorReview.${category} must state the rule or why it is not applicable, not an unresolved placeholder`);
        }
        return [category, statement];
      })) as Record<(typeof BEHAVIOR_REVIEW_CATEGORIES)[number], string>;
    }
    let behaviorEvidence: BehaviorEvidence[] | undefined;
    if (fn.behaviorEvidence !== undefined) {
      if (!Array.isArray(fn.behaviorEvidence) || fn.behaviorEvidence.length < 1 || fn.behaviorEvidence.length > 10) {
        invalid(`${path}.behaviorEvidence must contain between 1 and 10 entries`);
      }
      behaviorEvidence = fn.behaviorEvidence.map((entry, evidenceIndex) => {
        const evidencePath = `${path}.behaviorEvidence[${evidenceIndex}]`;
        const evidence = object(entry, evidencePath);
        exactKeys(evidence, ["kind", "reference"], evidencePath);
        const kind = string(evidence.kind, `${evidencePath}.kind`);
        if (!(["user-decision", "authoritative-source", "project-policy"] as const).includes(kind as any)) {
          invalid(`${evidencePath}.kind is not supported`);
        }
        const reference = boundedString(evidence.reference, `${evidencePath}.reference`, 300).trim();
        if (!reference || /^(?:tbd|todo|unknown|unresolved|pending|not yet|to be determined)(?:\b|:)/i.test(reference)) {
          invalid(`${evidencePath}.reference must identify a concrete user decision, authoritative source, or project policy`);
        }
        return {
          kind: kind as BehaviorEvidence["kind"],
          reference,
        };
      });
    }
    return {
      name: rName(fn.name, `${path}.name`),
      parameters: stringArray(fn.parameters, `${path}.parameters`, true),
      ...(fn.purpose !== undefined ? { purpose: boundedString(fn.purpose, `${path}.purpose`, 500) } : {}),
      ...(requirements ? { requirements } : {}),
      ...(behaviorReview ? { behaviorReview } : {}),
      ...(behaviorEvidence ? { behaviorEvidence } : {}),
    };
  });
  if (new Set(functions.map((fn) => fn.name)).size !== functions.length) invalid("function names must be unique");

  const targetsInput = root.targets;
  if (!Array.isArray(targetsInput)) invalid("targets must be an array");
  if (targetsInput.length > 200) invalid("targets must contain at most 200 entries");
  const targets: TargetDefinition[] = targetsInput.map((entry, index) => {
    const path = `targets[${index}]`;
    const target = object(entry, path);
    exactKeys(target, ["name", "function", "artifact", "arguments", "source", "output", "pattern"], path);
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
    let source: { constant: string } | undefined;
    if (target.source !== undefined) {
      const sourceInput = object(target.source, `${path}.source`);
      exactKeys(sourceInput, ["constant"], `${path}.source`);
      source = { constant: rName(sourceInput.constant, `${path}.source.constant`) };
    }
    let output: { parameter: string; constant: string } | undefined;
    if (target.output !== undefined) {
      const outputInput = object(target.output, `${path}.output`);
      exactKeys(outputInput, ["parameter", "constant"], `${path}.output`);
      output = {
        parameter: rName(outputInput.parameter, `${path}.output.parameter`),
        constant: rName(outputInput.constant, `${path}.output.constant`),
      };
    }
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
    const name = rName(target.name, `${path}.name`);
    if (source) {
      if (artifact !== "file") invalid(`${path}.source requires artifact file`);
      if (target.function !== undefined || output !== undefined || pattern !== undefined) {
        invalid(`${path} Source File Target must omit function, output, and pattern`);
      }
      if (Object.keys(args).length > 0) invalid(`${path} Source File Target arguments must be empty`);
      return { name, artifact: "file", source, arguments: {} };
    }
    if (target.function === undefined) invalid(`${path}.function is required unless source is declared`);
    return {
      name,
      function: rName(target.function, `${path}.function`),
      artifact: artifact as "table" | "object" | "file",
      arguments: args,
      ...(output ? { output } : {}),
      ...(pattern ? { pattern } : {}),
    };
  });
  if (new Set(targets.map((target) => target.name)).size !== targets.length) invalid("target names must be unique");
  const conflictingNames = targets.map((target) => target.name).filter((name) => functions.some((fn) => fn.name === name));
  if (conflictingNames.length > 0) {
    invalid("target names must differ from Approved Function names", { names: conflictingNames.sort() });
  }

  const functionByName = new Map(functions.map((fn) => [fn.name, fn]));
  const targetNames = new Set(targets.map((target) => target.name));
  const constantNames = new Set(Object.keys(constants));
  for (const target of targets) {
    if (isSourceFileTarget(target)) {
      if (!constantNames.has(target.source.constant)) {
        invalid(`Source File Target '${target.name}' references unknown constant '${target.source.constant}'`);
      }
      const sourcePath = constants[target.source.constant];
      if (typeof sourcePath !== "string") {
        invalid(`Source File Target '${target.name}' must reference a string constant`);
      }
      try {
        validateSourcePath(sourcePath, `Source File Target '${target.name}' path`);
      } catch (error) {
        invalid(error instanceof Error ? error.message : `Source File Target '${target.name}' path is invalid`);
      }
      continue;
    }
    const fn = functionByName.get(target.function);
    if (!fn) invalid(`target '${target.name}' calls an unapproved function`, { function: target.function });
    const argumentNames = Object.keys(target.arguments);
    if (target.output && argumentNames.includes(target.output.parameter)) {
      invalid(`file target '${target.name}' output parameter must not be duplicated in arguments`);
    }
    const boundNames = [...argumentNames, ...(target.output ? [target.output.parameter] : [])];
    if (
      boundNames.length !== fn.parameters.length ||
      fn.parameters.some((parameter) => !boundNames.includes(parameter))
    ) {
      invalid(`target '${target.name}' arguments and explicit output must exactly match required function parameters`);
    }
    if (target.output && target.artifact !== "file") {
      invalid(`non-file target '${target.name}' must not declare an output`);
    }
    if (target.output) {
      const outputValue = constants[target.output.constant];
      if (typeof outputValue !== "string") {
        invalid(`file target '${target.name}' output must reference a string constant`);
      }
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

  for (const target of targets.filter((candidate) => candidate.artifact === "file" && !isSourceFileTarget(candidate))) {
    const outputs = fileTargetOutputs(target, constants);
    if (outputs.length !== 1) invalid(`file target '${target.name}' must declare exactly one constant output path`);
    try {
      validateDeliverablePath(outputs[0], `file target '${target.name}' output`);
    } catch (error) {
      invalid(error instanceof Error ? error.message : `file target '${target.name}' output is invalid`);
    }
  }

  const sourcePaths = new Set(
    targets.filter(isSourceFileTarget).map((target) => constants[target.source.constant]).filter((value): value is string => typeof value === "string"),
  );
  const generatedPaths = new Set(
    targets.filter((target) => target.artifact === "file" && !isSourceFileTarget(target))
      .flatMap((target) => fileTargetOutputs(target, constants)),
  );
  const inputOutputCollisions = [...sourcePaths].filter((path) => generatedPaths.has(path));
  if (inputOutputCollisions.length > 0) {
    invalid("Source File Target paths must not also be generated file outputs", { paths: inputOutputCollisions.sort() });
  }

  const deliverablesInput = root.deliverables ?? [];
  if (!Array.isArray(deliverablesInput)) invalid("deliverables must be an array");
  if (deliverablesInput.length > 100) invalid("deliverables must contain at most 100 entries");
  const deliverables = deliverablesInput.map((entry, index) => {
    const path = `deliverables[${index}]`;
    const value = object(entry, path);
    exactKeys(value, ["target", "path"], path);
    const targetName = rName(value.target, `${path}.target`);
    let declaredPath: string;
    try {
      declaredPath = validateDeliverablePath(value.path, `${path}.path`);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : `${path}.path is invalid`);
    }
    const target = targets.find((candidate) => candidate.name === targetName);
    if (!target) invalid(`${path}.target must refer to a declared target`);
    if (target.artifact !== "file") invalid(`${path}.target must be a file target`);
    if (isSourceFileTarget(target)) invalid(`${path}.target must be a generated file target, not a Source File Target`);
    if (target.pattern) invalid(`${path}.target must not use dynamic branching`);
    if (!fileTargetOutputs(target, constants).includes(declaredPath)) {
      invalid(`${path}.path must equal the file target's declared output path`);
    }
    return { target: targetName, path: declaredPath };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(deliverables.map((entry) => entry.path)).size !== deliverables.length) invalid("deliverable paths must be unique");
  if (new Set(deliverables.map((entry) => entry.target)).size !== deliverables.length) invalid("deliverable targets must be unique");

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
    dependencyApprovals,
    deliverables,
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
    deliverables: contract.deliverables.map((deliverable) => deliverable.path),
    functions: contract.functions.map((fn) => fn.name),
    constants: Object.keys(contract.constants),
    targets: contract.targets.map((target) => target.name),
  };
}
