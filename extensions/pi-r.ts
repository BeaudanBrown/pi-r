import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import contractSchema from "../resources/project-contract.schema.json" with { type: "json" };
import {
  normalizeContractProposal,
  unspecifiedBehaviorFunctions,
  validateContract,
  validateLockableContract,
} from "../src/contract/contract.js";
import { fileTargetOutputs } from "../src/contract/deliverables.js";
import { isSourceFileTarget, type NixpkgsPin, type ProjectContract } from "../src/contract/types.js";
import { checkScaffold, renderScaffold } from "../src/contract/scaffold.js";
import { RecoverableError } from "../src/r-edit/errors.js";
import { inspectApprovedFunctions, prepareScopedMutation } from "../src/workbench/scoped-mutation.js";
import { SandboxedRWorker, type WorkerEnvironment, type WorkerObject, type WorkerState } from "../src/workbench/r-worker.js";
import { listTargets, runTargets } from "../src/workbench/target-runner.js";
import { inspectArtifact, type ArtifactFacet } from "../src/workbench/artifact-inspector.js";
import { inspectData } from "../src/workbench/data-inspector.js";
import {
  discardEnvironmentCandidate,
  ENVIRONMENT_PATHS,
  prepareEnvironmentCandidate,
  readEnvironmentCandidate,
  validateContractEnvironment,
  type DependencyProposal,
  type EnvironmentCandidate,
} from "../src/workbench/environment-governance.js";
import { declaredPackagePolicy, prepareSharedPolicyUpdate } from "../src/environment/package-governance.js";
import { prepareDeliverablePublication, type DeliverablePublication } from "../src/workbench/deliverable-publisher.js";
import { scoutDependencies, type DependencyScoutRequest } from "../src/workbench/dependency-scout.js";

const STATE_ENTRY = "pi-r-workbench-state";
const WORKBENCH_BRANCH = "pi-r/workbench";
const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
const WORKER_TOOLS = ["evaluate_r", "r_object_inspect", "r_worker_status", "r_worker_clear", "r_worker_reset"] as const;
const TARGET_TOOLS = ["r_targets_list", "r_targets_run", "r_target_workspace"] as const;
const ARTIFACT_TOOL = "r_artifact_inspect";
const DATA_TOOL = "r_data_inspect";
const ENVIRONMENT_TOOL = "r_dependency_propose";
const SCOUT_TOOL = "r_dependency_scout";
const LIVE_STATE_MESSAGE = "pi-r-current-state";
const PI_R_RUNTIME_VERSION = "0.21.0";
const MAX_LIVE_STATE_BYTES = 4096;
const MAX_LIVE_OBJECTS = 50;
const MODEL_R_NAME_PATTERN = "^[A-Za-z.][A-Za-z0-9._]*$";

function llamaCompatibleSchema(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  delete record.not;
  delete record.propertyNames;
  if (typeof record.pattern === "string" && record.pattern.includes("?!")) {
    record.pattern = MODEL_R_NAME_PATTERN;
  }
  for (const child of Object.values(record)) llamaCompatibleSchema(child);
}

const BEHAVIOR_PROPOSAL_TOOL = "r_function_behavior_propose";
const BEHAVIOR_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["functions"],
  properties: {
    functions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: false,
      description: "Behavior decisions for existing Approved Functions. Include only facts supplied by the user or an identified authoritative source; never infer them from names or observed values.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "purpose", "requirements", "basis"],
        properties: {
          name: { type: "string", pattern: MODEL_R_NAME_PATTERN, maxLength: 100 },
          purpose: { type: "string", minLength: 1, maxLength: 500 },
          requirements: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 300 } },
          basis: { type: "string", minLength: 1, maxLength: 300, description: "User decision or authoritative source establishing these requirements; do not cite observed data as semantic authority." },
        },
      },
    },
  },
} as const;

const CONTRACT_PROPOSAL_SCHEMA = (() => {
  const schema = structuredClone(contractSchema) as Record<string, any>;
  schema.required = schema.required.filter((name: string) => !["contractVersion", "templateVersion", "policyVersion"].includes(name));
  delete schema.properties.contractVersion;
  delete schema.properties.templateVersion;
  delete schema.properties.policyVersion;
  schema.properties.project.required = ["name"];
  delete schema.properties.project.properties.nixpkgs;
  schema.properties.functions.items.required = ["name", "parameters", "purpose", "requirements"];
  schema.description = "Complete Design or Revision Mode project decisions. Approved Functions declare signatures plus user-approved purpose and behavioral requirements, never bodies. Requirements state relevant missing-value, duplicate, coding, cohort, and output rules. Targets call those functions, while Source File Targets use source.constant and omit function/output.";
  llamaCompatibleSchema(schema);
  return schema;
})();

const DATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "columns", "columnOffset", "columnLimit"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 500 },
    columns: { type: "array", maxItems: 10, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
    key: { type: "string", minLength: 1, maxLength: 200 },
    comparePath: { type: "string", minLength: 1, maxLength: 500 },
    columnOffset: { type: "integer", minimum: 0, maximum: 10000 },
    columnLimit: { type: "integer", minimum: 1, maximum: 50 },
  },
} as const;

const EVALUATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["code", "targets", "retain"],
  properties: {
    code: { type: "string", minLength: 1, maxLength: 50_000, description: "R expressions to evaluate. Make the final expression the structured value to return; do not use cat(), print(), cbind(), or hand-formatted text for inspection." },
    targets: { type: "array", maxItems: 100, uniqueItems: true, description: "Existing canonical targets artifacts to load before evaluation. These are not assignment names created by code.", items: { type: "string", pattern: MODEL_R_NAME_PATTERN, maxLength: 200 } },
    retain: { type: "array", maxItems: 100, uniqueItems: true, description: "Assignment names to preserve only after complete successful evaluation. The final expression is returned whether or not it is retained.", items: { type: "string", pattern: MODEL_R_NAME_PATTERN, maxLength: 200 } },
  },
} as const;
const OBJECT_INSPECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "columns", "columnOffset", "columnLimit"],
  properties: {
    name: { type: "string", pattern: MODEL_R_NAME_PATTERN, maxLength: 200 },
    columns: { type: "array", maxItems: 10, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
    columnOffset: { type: "integer", minimum: 0, maximum: 10000 },
    columnLimit: { type: "integer", minimum: 1, maximum: 50 },
  },
} as const;
const EMPTY_SCHEMA = { type: "object", additionalProperties: false, properties: {} } as const;
const ARTIFACT_INSPECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["target", "facets"],
  properties: {
    target: { type: "string", pattern: MODEL_R_NAME_PATTERN },
    facets: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["structure", "summary"] } },
  },
} as const;
const DEPENDENCY_SCOUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["requirement", "domain", "ecosystem", "platforms"],
  properties: {
    requirement: { type: "string", minLength: 10, maxLength: 1000 },
    domain: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z][A-Za-z0-9 -]{0,99}$" },
    ecosystem: { const: "R" },
    platforms: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["x86_64-linux", "aarch64-linux"] } },
    candidateHints: { type: "array", maxItems: 5, uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9.]{0,99}$" } },
  },
} as const;
const DEPENDENCY_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operation", "package", "domain", "rationale", "scope"],
  properties: {
    operation: { enum: ["add", "remove"] },
    package: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9.]{0,99}$" },
    domain: { type: "string", minLength: 1, maxLength: 100 },
    rationale: { type: "string", minLength: 1, maxLength: 1000 },
    scope: { enum: ["project", "shared"] },
  },
} as const;
const TARGET_WORKSPACE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["target"],
  properties: { target: { type: "string", pattern: MODEL_R_NAME_PATTERN } },
} as const;
const RUN_TARGETS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["names", "all"],
  properties: {
    names: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", pattern: MODEL_R_NAME_PATTERN } },
    all: { type: "boolean" },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 1800 },
  },
} as const;
const INSPECT_TOOL = "r_function_inspect";
const EDIT_TOOL = "r_function_edit";
const INSPECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["functions", "sourceOffset", "sourceLimit"],
  properties: {
    functions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      description: "Approved Functions to inspect together. Batch inspection returns compact status; use one function with a positive sourceLimit immediately before editing.",
      items: { type: "string", pattern: MODEL_R_NAME_PATTERN, maxLength: 100 },
    },
    sourceOffset: { type: "integer", minimum: 0, maximum: 50000, description: "Character offset for a one-function source page." },
    sourceLimit: { type: "integer", minimum: 0, maximum: 3000, description: "Source characters to return. Use 0 for compact batch inspection; positive values require exactly one function." },
  },
} as const;
const EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["function", "expectedSourceHash", "statements"],
  properties: {
    function: { type: "string", minLength: 1 },
    expectedSourceHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    statements: {
      type: "string",
      minLength: 1,
      description: "R statements inside the function body; omit the function declaration and outer braces",
    },
  },
} as const;

type NoticeLevel = "info" | "warning" | "error";
type Phase = "design" | "revision" | "implementation";

interface WorkbenchState {
  version: 3;
  runtimeVersion: typeof PI_R_RUNTIME_VERSION;
  phase: Phase;
  projectRoot: string;
  workingDirectory: string;
  branch: string;
  head: string;
  contractState: "missing" | "draft" | "locked";
  policyState: "pi-r-policy-v1";
  editableScopeCount: number;
  behaviorBlockedCount: number;
  pendingApproval: "none" | "contract-lock" | "environment-change" | "deliverable-publish";
  workerState: WorkerState;
  readOnlyRoots: string[];
  allowedTools: string[];
}

interface CommandContext {
  cwd: string;
  sessionManager: {
    getBranch(): unknown[];
    getEntries(): unknown[];
  };
  ui: {
    notify(message: string, level: NoticeLevel): void;
    setWidget?(key: string, content: string[] | undefined): void;
    setStatus?(key: string, content: string | undefined): void;
    confirm?(title: string, message: string): Promise<boolean>;
  };
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface ExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, context: CommandContext): Promise<void>;
    },
  ): void;
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: CommandContext,
    ): Promise<unknown>;
  }): void;
  on(name: string, handler: (event: any, context: CommandContext) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  exec(command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
  getAllTools(): Array<{ name: string; sourceInfo?: { source?: string } }>;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

function scoutPiInvocation(): { command: string; arguments: string[] } {
  if (process.env.PI_R_SCOUT_PI) {
    return {
      command: process.env.PI_R_SCOUT_PI,
      arguments: process.env.PI_R_SCOUT_PI_ENTRY ? [process.env.PI_R_SCOUT_PI_ENTRY] : [],
    };
  }
  const executable = basename(process.execPath).toLowerCase();
  if (/^(?:node|bun)(?:\.exe)?$/.test(executable) && process.argv[1]) {
    return { command: process.execPath, arguments: [process.argv[1]] };
  }
  return { command: process.execPath, arguments: [] };
}

function words(input: string): string[] {
  const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((value) => {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  });
}

function isWorkbenchState(value: unknown): value is WorkbenchState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<WorkbenchState>;
  return (
    state.version === 3 &&
    state.runtimeVersion === PI_R_RUNTIME_VERSION &&
    (state.phase === "design" || state.phase === "revision" || state.phase === "implementation") &&
    typeof state.projectRoot === "string" &&
    typeof state.workingDirectory === "string" &&
    state.branch === WORKBENCH_BRANCH &&
    typeof state.head === "string" &&
    /^[0-9a-f]{40,64}$/.test(state.head) &&
    (state.contractState === "missing" || state.contractState === "draft" || state.contractState === "locked") &&
    state.policyState === "pi-r-policy-v1" &&
    typeof state.editableScopeCount === "number" &&
    typeof state.behaviorBlockedCount === "number" &&
    (state.pendingApproval === "none" || state.pendingApproval === "contract-lock" || state.pendingApproval === "environment-change" || state.pendingApproval === "deliverable-publish") &&
    (state.workerState === "stopped" || state.workerState === "running" || state.workerState === "crashed") &&
    Array.isArray(state.readOnlyRoots) &&
    state.readOnlyRoots.every((root) => typeof root === "string" && isAbsolute(root)) &&
    Array.isArray(state.allowedTools)
  );
}

function restoreState(entries: unknown[]): WorkbenchState | "stale" | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    if ((entry.data as { inactive?: unknown } | undefined)?.inactive === true) return undefined;
    if (isWorkbenchState(entry.data)) return entry.data;
    return "stale";
  }
  return undefined;
}

function shortHead(head: string): string {
  return head.slice(0, 12);
}

function hud(state: WorkbenchState): string {
  const duty = state.phase === "design" ? "contract-design" : state.phase === "revision" ? "contract-revision" : "scoped-implementation";
  return [
    `mode=${state.phase}`,
    `duty=${duty}`,
    `contract=${state.contractState}`,
    `topology=${state.phase === "implementation" ? "locked" : "editable"}`,
    `scopes=${state.editableScopeCount}`,
    `behavior-blocked=${state.behaviorBlockedCount}`,
    `approval=${state.behaviorBlockedCount > 0 && state.phase === "implementation" ? "revision-required" : state.pendingApproval}`,
    `worker=${state.workerState}`,
    `runtime=${state.runtimeVersion}`,
    `branch=${state.branch}@${shortHead(state.head)}`,
  ].join(" ");
}

function showHud(context: CommandContext, state: WorkbenchState): void {
  const line = hud(state);
  context.ui.setWidget?.("pi-r-hud", [line]);
  context.ui.setStatus?.("pi-r", `R:${state.phase} ${state.branch}@${shortHead(state.head)}`);
}

function showStartProgress(context: CommandContext, step: string): void {
  context.ui.setWidget?.("pi-r-hud", [`pi-r STARTING — ${step}`]);
  context.ui.setStatus?.("pi-r", `R:starting · ${step}`);
}

function showLockProgress(context: CommandContext, step: string): void {
  context.ui.setWidget?.("pi-r-hud", [`pi-r LOCKING — ${step}`]);
  context.ui.setStatus?.("pi-r", `R:locking · ${step}`);
}

function resultMessage(result: ExecResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

function contractSummary(contract: ProjectContract): string {
  const functions = contract.functions.map((fn) => [
    `- ${fn.name}(${fn.parameters.join(", ")}): ${fn.purpose ?? "legacy behavior unspecified"}`,
    ...(fn.requirements ?? []).map((requirement) => `  - ${requirement}`),
  ].join("\n")).join("\n");
  const constants = Object.entries(contract.constants)
    .map(([name, value]) => `- ${name} = ${JSON.stringify(value)}`)
    .join("\n") || "- none";
  const dependencies = contract.dependencies.map((name) => `- ${name}`).join("\n") || "- none";
  const deliverables = contract.deliverables.map((entry) => `- ${entry.target}: ${entry.path}`).join("\n") || "- none";
  const graph = contract.targets
    .map((target) => {
      const inputs = Object.values(target.arguments).map((argument) =>
        "target" in argument ? argument.target : `constant:${argument.constant}`,
      );
      const pattern = target.pattern ? ` ${target.pattern.kind}(${target.pattern.over.join(", ")})` : "";
      return isSourceFileTarget(target)
        ? `- ${target.name} <- [constant:${target.source.constant}] => source file (file)`
        : `- ${target.name} <- [${inputs.join(", ")}] => ${target.function} (${target.artifact})${pattern}`;
    })
    .join("\n");
  return `Functions and signatures\n${functions}\n\nConstants\n${constants}\n\nDependencies\n${dependencies}\n\nVersioned deliverables\n${deliverables}\n\nTarget graph\n${graph}`;
}

async function canonicalDestination(path: string): Promise<string> {
  let ancestor = dirname(path);
  const missing = [basename(path)];
  while (true) {
    const canonical = await realpath(ancestor).catch(() => undefined);
    if (canonical) return resolve(canonical, ...missing);
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve output path: ${path}`);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
}

async function validateSourceFileAuthority(
  contract: ProjectContract,
  projectRoot: string,
  readOnlyRoots: string[],
  fallbackProjectRoot?: string,
): Promise<void> {
  const generatedPaths = contract.targets.filter((target) => target.artifact === "file" && !isSourceFileTarget(target))
    .flatMap((target) => fileTargetOutputs(target, contract.constants))
    .map((path) => resolve(projectRoot, path));
  const generated = new Set(await Promise.all(generatedPaths.map((path) =>
    realpath(path).catch(() => canonicalDestination(path)),
  )));
  for (const target of contract.targets.filter(isSourceFileTarget)) {
    const declared = contract.constants[target.source.constant];
    if (typeof declared !== "string") throw new Error(`Source File Target ${target.name} lost its string path`);
    const absoluteSource = isAbsolute(declared);
    const primary = absoluteSource ? declared : resolve(projectRoot, declared);
    let requested = primary;
    let canonical = await realpath(primary).catch(() => undefined);
    let relativeRoot = projectRoot;
    if (!absoluteSource && !canonical && fallbackProjectRoot) {
      requested = resolve(fallbackProjectRoot, declared);
      canonical = await realpath(requested).catch(() => undefined);
      relativeRoot = fallbackProjectRoot;
    }
    if (!canonical) throw new Error(`Source File Target ${target.name} does not exist: ${declared}`);
    const permittedRoots = absoluteSource ? readOnlyRoots : [relativeRoot];
    const permitted = permittedRoots.some((root) => {
      const rel = relative(root, canonical);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    });
    if (!permitted) {
      throw new Error(
        absoluteSource
          ? `Source File Target ${target.name} uses an absolute path outside attached Read-Only Roots`
          : `Source File Target ${target.name} is outside the project root`,
      );
    }
    if (generated.has(canonical)) {
      throw new Error(`Source File Target ${target.name} must not also be a generated file output`);
    }
  }
}

async function sourceDiff(root: string, files: ReadonlyMap<string, string>, removedPaths: readonly string[] = []): Promise<string> {
  const sections: string[] = [];
  for (const [path, generated] of files) {
    const current = await readFile(resolve(root, path), "utf8").catch(() => undefined);
    if (current === generated) continue;
    const removed = current === undefined ? [] : current.split("\n").map((line) => `-${line}`);
    const added = generated.split("\n").map((line) => `+${line}`);
    sections.push(`diff --pi-r ${path}\n--- current/${path}\n+++ generated/${path}\n${[...removed, ...added].join("\n")}`);
  }
  for (const path of removedPaths) {
    const current = await readFile(resolve(root, path), "utf8").catch(() => undefined);
    if (current === undefined) continue;
    sections.push(`diff --pi-r ${path}\n--- current/${path}\n+++ /dev/null\n${current.split("\n").map((line) => `-${line}`).join("\n")}`);
  }
  const complete = sections.join("\n\n");
  return complete.length <= 40_000 ? complete : `${complete.slice(0, 40_000)}\n[generated-source diff truncated]`;
}

/** The only model-context surface is activated after an explicit /r start. */
export default function piRExtension(pi: ExtensionAPI): void {
  let state: WorkbenchState | undefined;
  let previousActiveTools: string[] | undefined;
  let proposalRegistered = false;
  let editRegistered = false;
  let workerRegistered = false;
  let targetRegistered = false;
  let artifactRegistered = false;
  let dataRegistered = false;
  let environmentRegistered = false;
  let scoutRegistered = false;
  let worker: SandboxedRWorker | undefined;
  let projectRscript: string | undefined;

  const resourceRoot = process.env.PI_R_RESOURCE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const guidanceRoots = Promise.all([
    realpath(resolve(resourceRoot, "skills/pi-r/SKILL.md")).catch(() => undefined),
    realpath(resolve(resourceRoot, "skills/pi-r/references")).catch(() => undefined),
  ]).then((roots) => roots.filter((root): root is string => root !== undefined));

  const configuredLauncherTools = process.env.PI_R_INITIAL_TOOLS?.split(",").filter(Boolean);
  if (configuredLauncherTools?.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) {
    throw new Error("PI_R_INITIAL_TOOLS contains an invalid tool name");
  }
  let proposalQueue: Promise<void> = Promise.resolve();
  let editQueue: Promise<void> = Promise.resolve();
  let workerQueue: Promise<void> = Promise.resolve();
  let environmentQueue: Promise<void> = Promise.resolve();
  let scoutQueue: Promise<void> = Promise.resolve();
  let publishQueue: Promise<void> = Promise.resolve();
  let liveObjects: WorkerObject[] = [];
  let liveTransientStateLost = false;
  let liveTransition = "inactive";
  let previousCompletionTruncated = false;
  let quarantineReason: string | undefined;
  let lastEditInspection: { function: string; sourceHash: string } | undefined;

  function updateLiveWorker(objects: WorkerObject[], transientStateLost: boolean, transition?: string): void {
    const originOrder: Record<WorkerObject["origin"], number> = { temporary: 0, target: 1, global: 2 };
    liveObjects = [...objects].sort(
      (left, right) => originOrder[left.origin] - originOrder[right.origin] || left.name.localeCompare(right.name),
    );
    liveTransientStateLost = transientStateLost;
    if (transition) liveTransition = transition;
  }

  function environmentIdentity(): string {
    if (!state || state.phase !== "implementation") return "design:bundled";
    if (!projectRscript) return "project:generated";
    const store = projectRscript.match(/^\/nix\/store\/([^/]+)/)?.[1];
    return `project:${store ?? basename(dirname(dirname(projectRscript)))}`.slice(0, 200);
  }

  function liveStateContent(): string {
    if (!state) return "";
    const allObjects = liveObjects.map((object) => ({
      name: object.name.slice(0, 200),
      origin: object.origin,
      class: object.class.slice(0, 8).map((name) => name.slice(0, 200)),
      bytes: object.bytes,
      ...(object.createdByCall !== undefined ? { createdByCall: object.createdByCall } : {}),
      ...(object.lastModifiedByCall !== undefined ? { lastModifiedByCall: object.lastModifiedByCall } : {}),
    }));
    const agentDuty = state.phase === "design"
      ? "contract_design"
      : state.phase === "revision" ? "contract_revision" : "scoped_implementation";
    const snapshot = {
      version: 1,
      origin: "pi-r-extension",
      runtimeVersion: state.runtimeVersion,
      mode: state.phase,
      agentDuty,
      contract: {
        state: state.contractState,
        topologyChanges: state.phase !== "implementation",
        proposalToolAvailable: state.phase !== "implementation",
      },
      authority: {
        editableFunctionCount: state.editableScopeCount,
        behaviorBlockedFunctionCount: state.behaviorBlockedCount,
        behaviorRevisionRequired: state.phase === "implementation" && state.behaviorBlockedCount > 0,
        generalMutation: false,
      },
      transition: state.phase === "implementation"
        ? { topologyChange: { command: "/r revise", requiresUser: true } }
        : { publishDraft: { command: "/r lock", requiresUser: true } },
      approval: state.pendingApproval,
      environment: { identity: environmentIdentity() },
      worker: {
        state: state.workerState,
        transientStateLost: liveTransientStateLost,
        targetsCache: "preserved",
        lastTransition: liveTransition,
      },
      provenance: { branch: state.branch, head: shortHead(state.head) },
      ...(previousCompletionTruncated
        ? { previousCompletion: { status: "truncated", safeToAssumeCompleted: false } }
        : {}),
      objectCount: allObjects.length,
      objectsTruncated: allObjects.length > MAX_LIVE_OBJECTS,
      objects: allObjects.slice(0, MAX_LIVE_OBJECTS),
    };
    const safeJson = () => JSON.stringify(snapshot).replace(/[<>&]/g, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const wrap = () => `<pi_r_current_state>\n${safeJson()}\n</pi_r_current_state>`;
    let content = wrap();
    while (Buffer.byteLength(content) > MAX_LIVE_STATE_BYTES && snapshot.objects.length) {
      snapshot.objects.pop();
      snapshot.objectsTruncated = true;
      content = wrap();
    }
    if (previousCompletionTruncated) previousCompletionTruncated = false;
    return content;
  }

  async function git(args: string[], cwd: string, allowFailure = false): Promise<ExecResult> {
    const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
    if (!allowFailure && result.code !== 0) throw new Error(resultMessage(result));
    return result;
  }

  function safeReadTools(): string[] {
    return pi
      .getAllTools()
      .filter(
        (tool) =>
          tool.sourceInfo?.source === "builtin" && (READ_TOOLS as readonly string[]).includes(tool.name),
      )
      .map((tool) => tool.name);
  }

  function phaseTools(phase: Phase, editableScopeCount = state?.editableScopeCount ?? 0): string[] {
    const workerTools = workerRegistered ? [...WORKER_TOOLS] : [];
    const dataTools = dataRegistered ? [DATA_TOOL] : [];
    if ((phase === "design" || phase === "revision") && proposalRegistered) {
      return [
        ...safeReadTools(),
        "r_contract_propose",
        ...(phase === "revision" ? [BEHAVIOR_PROPOSAL_TOOL] : []),
        ...workerTools,
        ...dataTools,
      ];
    }
    const targetTools = targetRegistered ? [...TARGET_TOOLS] : [];
    const artifactTools = artifactRegistered ? [ARTIFACT_TOOL] : [];
    const environmentTools = environmentRegistered ? [ENVIRONMENT_TOOL] : [];
    const scoutTools = scoutRegistered ? [SCOUT_TOOL] : [];
    if (phase === "implementation" && editRegistered) {
      const editTools = [INSPECT_TOOL, ...(editableScopeCount > 0 ? [EDIT_TOOL] : [])];
      return [...safeReadTools(), ...editTools, ...workerTools, ...dataTools, ...targetTools, ...artifactTools, ...environmentTools, ...scoutTools];
    }
    return safeReadTools();
  }

  function workerInstance(): SandboxedRWorker {
    if (!state) throw new RecoverableError("INVALID_PHASE", "R exploration requires an active Workbench Session");
    worker ??= new SandboxedRWorker({
      projectRoot: state.projectRoot,
      readOnlyRoots: state.readOnlyRoots,
      workerScript: process.env.PI_R_WORKER_SCRIPT ?? "",
      bwrap: process.env.PI_R_BWRAP,
      sandboxPath: process.env.PI_R_SANDBOX_PATH,
      onState(nextState) {
        if (state) state = { ...state, workerState: nextState };
        if (nextState !== "running") {
          const lost = liveTransientStateLost || liveObjects.some((object) => object.origin !== "global");
          updateLiveWorker([], lost, nextState === "crashed" ? "worker-crashed" : "worker-stopped");
        }
      },
    });
    return worker;
  }

  async function resolveProjectRuntime(projectRoot: string): Promise<string> {
    const explicitProjectRuntime = process.env.PI_R_PROJECT_RSCRIPT;
    if (explicitProjectRuntime) {
      if (!isAbsolute(explicitProjectRuntime)) {
        throw new RecoverableError("WORKER_START_FAILED", "Generated project R runtime override must be absolute");
      }
      return explicitProjectRuntime;
    }
    const result = await pi.exec(
      "nix",
      ["--extra-experimental-features", "nix-command flakes", "develop", `path:${projectRoot}`, "--command", "which", "Rscript"],
      { cwd: projectRoot, timeout: 120_000 },
    );
    if (result.code !== 0 || !isAbsolute(result.stdout.trim())) {
      throw new RecoverableError("WORKER_START_FAILED", `Generated project R environment is unavailable: ${resultMessage(result)}`);
    }
    return result.stdout.trim();
  }

  async function workerRuntime(environment: WorkerEnvironment): Promise<string> {
    if (!state) throw new RecoverableError("INVALID_PHASE", "R exploration requires an active Workbench Session");
    if (environment === "design") {
      const rscript = process.env.PI_R_WORKER_RSCRIPT ?? process.env.PI_R_RSCRIPT;
      if (!rscript) throw new RecoverableError("WORKER_START_FAILED", "Bundled design R runtime is unavailable");
      return rscript;
    }
    projectRscript ??= await resolveProjectRuntime(state.projectRoot);
    return projectRscript;
  }

  function boundedJson(value: unknown): string {
    const clone = structuredClone(value) as unknown;
    const omissions = new Map<string, number>();
    const candidates = (): Array<{ path: string; value: unknown[] | string; parent: any; key: string | number }> => {
      const found: Array<{ path: string; value: unknown[] | string; parent: any; key: string | number }> = [];
      const visit = (current: any, path: string, parent?: any, key?: string | number): void => {
        if (typeof current === "string" && parent !== undefined && current.length > 200) {
          found.push({ path, value: current, parent, key: key! });
          return;
        }
        if (Array.isArray(current)) {
          if (parent !== undefined && current.length > 1) found.push({ path, value: current, parent, key: key! });
          current.forEach((item, index) => visit(item, `${path}[${index}]`, current, index));
          return;
        }
        if (current && typeof current === "object") {
          for (const [childKey, child] of Object.entries(current)) visit(child, `${path}.${childKey}`, current, childKey);
        }
      };
      visit(clone, "$ ".trim());
      return found;
    };
    let text = JSON.stringify(clone, null, 2);
    while (Buffer.byteLength(text) > 7600) {
      const options = candidates().sort((left, right) => JSON.stringify(right.value).length - JSON.stringify(left.value).length);
      const selected = options[0];
      if (!selected) break;
      if (Array.isArray(selected.value)) {
        const keep = Math.max(1, Math.floor(selected.value.length / 2));
        const omitted = selected.value.length - keep;
        selected.value.splice(keep);
        omissions.set(selected.path, (omissions.get(selected.path) ?? 0) + omitted);
      } else {
        const keep = Math.max(200, Math.floor(selected.value.length / 2));
        const omitted = selected.value.length - keep;
        selected.parent[selected.key] = `${selected.value.slice(0, keep)}\n[truncated]`;
        omissions.set(selected.path, (omissions.get(selected.path) ?? 0) + omitted);
      }
      text = JSON.stringify(clone, null, 2);
    }
    if (clone && typeof clone === "object" && !Array.isArray(clone) && omissions.size > 0) {
      Object.assign(clone as Record<string, unknown>, {
        modelOutputTruncated: true,
        omissions: [...omissions.entries()].map(([path, omitted]) => ({ path, omitted })),
      });
      text = JSON.stringify(clone, null, 2);
    }
    if (Buffer.byteLength(text) <= 8192) return text;
    return JSON.stringify({
      modelOutputTruncated: true,
      error: "Structured result exceeded the model-output limit after bounded projection",
      availableInToolDetails: true,
    }, null, 2);
  }

  async function workerStatusText(): Promise<string> {
    const status = worker
      ? await worker.status().catch(() => ({ state: "crashed" as const, objects: [], transientStateLost: true }))
      : { state: "stopped" as const, objects: [], transientStateLost: liveTransientStateLost };
    updateLiveWorker(status.objects, status.transientStateLost);
    const inventory = status.objects.length
      ? status.objects.map((object) => `${object.name}~${object.bytes}B`).join(", ")
      : "none";
    return `objects=${inventory}${status.transientStateLost ? " transient-state-lost=true" : ""}`;
  }

  async function assertWorkerProvenance(context: CommandContext): Promise<void> {
    if (!state) throw new RecoverableError("INVALID_PHASE", "R exploration requires an active Workbench Session");
    const mismatch = await verifyState(state, context);
    if (mismatch) throw new RecoverableError("PROVENANCE_MISMATCH", mismatch);
    const staged = await git(["diff", "--cached", "--name-only", "-z"], state.projectRoot);
    if (staged.stdout) throw new RecoverableError("STALE_CONTENT", "The Git index changed outside scoped capabilities");
    const changed = (await git(["diff", "--name-only", "-z"], state.projectRoot)).stdout.split("\0").filter(Boolean);
    let allowedOutputs = new Set<string>();
    if (state.phase === "implementation") {
      const lockedContract = await git(["show", "HEAD:pi-r.yml"], state.projectRoot);
      const contract = validateContract(JSON.parse(lockedContract.stdout));
      allowedOutputs = new Set(contract.deliverables.map((deliverable) => deliverable.path));
    }
    const sourceChanges = changed.filter((path) => !allowedOutputs.has(path));
    if (sourceChanges.length) {
      throw new RecoverableError("STALE_CONTENT", "Tracked source changed outside scoped capabilities", { paths: sourceChanges.sort() });
    }
  }

  function registerWorkerTools(): void {
    if (workerRegistered) return;
    workerRegistered = true;
    pi.registerTool({
      name: "evaluate_r",
      label: "Evaluate temporary R code",
      description: "Transactionally evaluate bounded R code in the persistent read-only Bubblewrap worker. Failed calls roll back; successful calls retain only explicitly named objects.",
      promptSnippet: "targets loads existing pipeline artifacts; retain preserves successful assignment names. Return a named list or vector as the final expression instead of printing, cbind, or formatted text",
      parameters: EVALUATE_SCHEMA,
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        const operation = workerQueue.then(async () => {
          await assertWorkerProvenance(context);
          const environment: WorkerEnvironment = state?.phase === "implementation" ? "project" : "design";
          const runtime = await workerRuntime(environment);
          const input = params as { code?: unknown; targets?: unknown; retain?: unknown };
          const result = await workerInstance().evaluate(
            { code: input.code as string, targets: input.targets as string[], retain: input.retain as string[] },
            environment,
            runtime,
            signal,
          );
          updateLiveWorker(result.objects, result.worker.transientStateLost, result.worker.started ? "worker-started" : "evaluation-complete");
          if (state) {
            state = { ...state, workerState: worker?.state ?? "stopped" };
            showHud(context, state);
          }
          return result;
        });
        workerQueue = operation.then(() => undefined, () => undefined);
        try {
          const result = await operation;
          const {
            objects: _liveInventory,
            value: _duplicateValue,
            preview: _duplicatePreview,
            previewTruncated: _duplicatePreviewTruncated,
            ...modelResult
          } = result;
          return { content: [{ type: "text", text: boundedJson(modelResult) }], details: result };
        } catch (error) {
          if (state) {
            state = { ...state, workerState: worker?.state ?? "crashed" };
            showHud(context, state);
          }
          throw actionableToolError(error);
        }
      },
    });
    pi.registerTool({
      name: "r_object_inspect",
      label: "Inspect retained R object",
      description: "Inspect bounded structure and selected-column summaries for one worker-held object without reevaluating or returning rows.",
      promptSnippet: "Inspect retained objects instead of rereading source files or writing formatting code",
      parameters: OBJECT_INSPECT_SCHEMA,
      async execute(_toolCallId, params, _signal, _onUpdate, context) {
        await assertWorkerProvenance(context);
        const input = params as { name?: unknown; columns?: unknown; columnOffset?: unknown; columnLimit?: unknown };
        const result = await workerInstance().inspectObject({
          name: input.name as string,
          columns: input.columns as string[],
          columnOffset: input.columnOffset as number,
          columnLimit: input.columnLimit as number,
        });
        updateLiveWorker(result.objects, liveTransientStateLost, "object-inspected");
        return { content: [{ type: "text", text: boundedJson(result) }], details: result };
      },
    });
    pi.registerTool({
      name: "r_worker_status",
      label: "Inspect temporary R state",
      description: "List current worker objects and approximate sizes without starting a worker.",
      parameters: EMPTY_SCHEMA,
      async execute(_toolCallId, _params, _signal, _onUpdate, context) {
        await assertWorkerProvenance(context);
        const status = worker
          ? await worker.status()
          : { state: "stopped" as const, objects: [], transientStateLost: liveTransientStateLost };
        updateLiveWorker(status.objects, status.transientStateLost);
        return { content: [{ type: "text", text: boundedJson(status) }], details: status };
      },
    });
    pi.registerTool({
      name: "r_worker_clear",
      label: "Clear temporary R objects",
      description: "Remove only retained temporary worker objects while preserving generated project globals, loaded target context, and the targets cache.",
      parameters: EMPTY_SCHEMA,
      async execute(_toolCallId, _params, _signal, _onUpdate, context) {
        await assertWorkerProvenance(context);
        const result = worker ? await worker.clearTemporary() : { removed: [], objects: [] };
        updateLiveWorker(result.objects, liveTransientStateLost, "temporaries-cleared");
        if (state) showHud(context, state);
        return { content: [{ type: "text", text: boundedJson(result) }], details: result };
      },
    });
    pi.registerTool({
      name: "r_worker_reset",
      label: "Reset temporary R state",
      description: "Stop the session worker and clearly report how many transient objects were lost.",
      parameters: EMPTY_SCHEMA,
      async execute(_toolCallId, _params, _signal, _onUpdate, context) {
        await assertWorkerProvenance(context);
        const instance = workerInstance();
        const reset = await instance.reset();
        const environment: WorkerEnvironment = state?.phase === "implementation" ? "project" : "design";
        const runtime = await workerRuntime(environment);
        let result: Record<string, unknown>;
        try {
          await instance.healthCheck(environment, runtime);
          result = {
            ...reset,
            reset: "completed",
            environmentHealthy: true,
            workerState: "running",
            transientStateLost: reset.lostObjects > 0,
            targetsCache: "preserved",
          };
        } catch {
          const diagnostics = await instance.status();
          result = {
            ...reset,
            reset: "failed",
            environmentHealthy: false,
            workerState: diagnostics.state,
            transientStateLost: reset.lostObjects > 0,
            targetsCache: "preserved",
            ...(diagnostics.lastCrash ? { lastCrash: diagnostics.lastCrash } : {}),
          };
        }
        updateLiveWorker([], reset.lostObjects > 0 || liveTransientStateLost, "worker-reset");
        if (state) {
          state = { ...state, workerState: instance.state };
          showHud(context, state);
        }
        return {
          content: [{ type: "text", text: boundedJson(result) }],
          details: result,
        };
      },
    });
  }

  function registerTargetTools(): void {
    if (targetRegistered) return;
    targetRegistered = true;
    pi.registerTool({
      name: "r_targets_list",
      label: "List contracted R targets",
      description: "List the locked target manifest and bounded freshness metadata using the read-only project runner.",
      promptSnippet: "Inspect target freshness before requesting explicit target execution",
      parameters: EMPTY_SCHEMA,
      async execute(_toolCallId, _params, signal, _onUpdate, context) {
        try {
          await assertWorkerProvenance(context);
          if (!state || state.phase !== "implementation") {
            throw new RecoverableError("INVALID_PHASE", "Target listing requires Implementation Mode");
          }
          const contract = validateContract(JSON.parse(await readFile(resolve(state.projectRoot, "pi-r.yml"), "utf8")));
          const runtime = await workerRuntime("project");
          const result = await listTargets(contract.targets.map((target) => target.name), {
            projectRoot: state.projectRoot,
            readOnlyRoots: state.readOnlyRoots,
            rscript: runtime,
            runnerScript: process.env.PI_R_TARGET_RUNNER_SCRIPT ?? "",
            bwrap: process.env.PI_R_BWRAP,
          }, signal);
          const details = {
            ...result,
            targets: result.targets.map((status) => {
              const declaration = contract.targets.find((target) => target.name === status.name)!;
              return {
                ...status,
                function: isSourceFileTarget(declaration) ? null : declaration.function,
                sourceConstant: isSourceFileTarget(declaration) ? declaration.source.constant : null,
                artifact: declaration.artifact,
                arguments: declaration.arguments,
                pattern: declaration.pattern ?? null,
              };
            }),
          };
          return { content: [{ type: "text", text: boundedJson(details) }], details };
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
    pi.registerTool({
      name: "r_targets_run",
      label: "Run contracted R targets",
      description: "Run explicit locked target names, or deliberately run the full contract with all=true, in the controlled project runner.",
      promptSnippet: "Run only necessary contracted targets; full-pipeline execution requires all=true",
      parameters: RUN_TARGETS_SCHEMA,
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        try {
          await assertWorkerProvenance(context);
          if (!state || state.phase !== "implementation") {
            throw new RecoverableError("INVALID_PHASE", "Target execution requires Implementation Mode");
          }
          const input = params as { names?: unknown; all?: unknown; timeoutSeconds?: unknown };
          const requested = Array.isArray(input.names) ? input.names.filter((name): name is string => typeof name === "string") : [];
          if (input.all !== true && requested.length === 0) {
            throw new RecoverableError("TARGET_SELECTION_REQUIRED", "Specify at least one target name or deliberately set all=true");
          }
          if (input.all === true && requested.length > 0) {
            throw new RecoverableError("AMBIGUOUS_TARGET_SELECTION", "Use either explicit target names or all=true, not both");
          }
          const contract = validateContract(JSON.parse(await readFile(resolve(state.projectRoot, "pi-r.yml"), "utf8")));
          await validateSourceFileAuthority(contract, state.projectRoot, state.readOnlyRoots);
          const contractNames = contract.targets.map((target) => target.name);
          const names = input.all === true ? contractNames : requested;
          const unknown = names.filter((name) => !contractNames.includes(name));
          if (unknown.length) throw new RecoverableError("UNKNOWN_TARGET", `Targets are not declared in the locked contract: ${unknown.join(", ")}`, { targets: unknown });
          const writableFiles: string[] = [];
          for (const target of contract.targets.filter((candidate) => names.includes(candidate.name) && candidate.artifact === "file")) {
            for (const value of fileTargetOutputs(target, contract.constants)) {
              if (isAbsolute(value)) {
                throw new RecoverableError("INVALID_OUTPUT_PATH", `File target ${target.name} requires a relative declared output path`);
              }
              const requestedOutput = resolve(state.projectRoot, value);
              const outputMetadata = await lstat(requestedOutput).catch(() => undefined);
              if (outputMetadata?.isSymbolicLink() || (outputMetadata && outputMetadata.nlink !== 1)) {
                throw new RecoverableError("INVALID_OUTPUT_PATH", `File target ${target.name} output must not be a symbolic or hard link`);
              }
              const output = await realpath(requestedOutput).catch(() => canonicalDestination(requestedOutput));
              const rel = relative(state.projectRoot, output);
              if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || [".git", ".pi", "_targets"].includes(rel.split(sep)[0])) {
                throw new RecoverableError("INVALID_OUTPUT_PATH", `File target ${target.name} output escapes permitted runtime paths`);
              }
              const tracked = await git(["ls-files", "--error-unmatch", "--", rel], state.projectRoot, true);
              const declaredDeliverable = contract.deliverables.some((deliverable) => deliverable.target === target.name && deliverable.path === rel);
              if (tracked.code === 0 && !declaredDeliverable) {
                throw new RecoverableError("INVALID_OUTPUT_PATH", `File target ${target.name} cannot write tracked source: ${rel}`);
              }
              writableFiles.push(output);
            }
          }
          const runtime = await workerRuntime("project");
          const timeoutMs = typeof input.timeoutSeconds === "number" ? input.timeoutSeconds * 1000 : undefined;
          const result = await runTargets(names, {
            projectRoot: state.projectRoot,
            readOnlyRoots: state.readOnlyRoots,
            rscript: runtime,
            runnerScript: process.env.PI_R_TARGET_RUNNER_SCRIPT ?? "",
            bwrap: process.env.PI_R_BWRAP,
            timeoutMs,
            writableFiles: [...new Set(writableFiles)].sort(),
          }, signal);
          const remaining = await worker?.invalidateTargets().catch(() => undefined);
          if (remaining) updateLiveWorker(remaining, liveTransientStateLost, "targets-invalidated");
          const reachable = new Set<string>();
          const includeUpstream = (name: string): void => {
            if (reachable.has(name)) return;
            reachable.add(name);
            const declaration = contract.targets.find((target) => target.name === name);
            if (!declaration) return;
            for (const argument of Object.values(declaration.arguments)) {
              if ("target" in argument) includeUpstream(argument.target);
            }
          };
          names.forEach(includeUpstream);
          const checks = contract.targets.flatMap((target) => {
            if (!reachable.has(target.name) || isSourceFileTarget(target)) return [];
            const fn = contract.functions.find((candidate) => candidate.name === target.function)!;
            return [{
              target: target.name,
              function: fn.name,
              artifact: target.artifact,
              purpose: fn.purpose ?? null,
              requirements: fn.requirements ?? [],
              behaviorSpecified: typeof fn.purpose === "string" && (fn.requirements?.length ?? 0) > 0,
            }];
          });
          const verification = {
            status: checks.every((check) => check.behaviorSpecified) ? "inspection-required" : "behavior-unspecified",
            totalChecks: checks.length,
            checksTruncated: false,
            checks,
            agentAction: checks.every((check) => check.behaviorSpecified)
              ? "Inspect each current target artifact and compare it with every listed requirement before claiming implementation complete"
              : "Do not infer missing behavior; ask the user to revise the legacy contract before claiming implementation complete",
          };
          const details = { ...result, verification };
          return { content: [{ type: "text", text: boundedJson(details) }], details };
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
    pi.registerTool({
      name: "r_target_workspace",
      label: "Load failed target workspace",
      description: "Load one contracted failed target workspace into the persistent project worker for temporary diagnosis.",
      promptSnippet: "After a failed target run, load its workspace before evaluating diagnostic expressions",
      parameters: TARGET_WORKSPACE_SCHEMA,
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        try {
          await assertWorkerProvenance(context);
          if (!state || state.phase !== "implementation") {
            throw new RecoverableError("INVALID_PHASE", "Failed target workspace diagnosis requires Implementation Mode");
          }
          const target = (params as { target?: unknown }).target;
          if (typeof target !== "string") throw new RecoverableError("INVALID_REQUEST", "A canonical target name is required");
          const runtime = await workerRuntime("project");
          const result = await workerInstance().loadWorkspace(target, runtime, signal);
          updateLiveWorker(result.objects, result.worker.transientStateLost, result.worker.started ? "worker-started" : "workspace-loaded");
          if (state) {
            state = { ...state, workerState: worker?.state ?? "stopped" };
            showHud(context, state);
          }
          return { content: [{ type: "text", text: boundedJson(result) }], details: result };
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
  }

  async function canonicalDataPath(input: string): Promise<string> {
    if (!state) throw new RecoverableError("INVALID_PHASE", "Raw data inspection requires an active Workbench Session");
    const requested = isAbsolute(input) ? input : resolve(state.projectRoot, input.replace(/^@/, ""));
    const canonical = await realpath(requested).catch(() => undefined);
    const roots = [state.projectRoot, ...state.readOnlyRoots];
    const permitted = canonical !== undefined && roots.some((root) => {
      const rel = relative(root, canonical);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    });
    if (!permitted || !canonical) throw new RecoverableError("DATA_PATH_OUTSIDE_ROOTS", "Raw data path is outside approved Read-Only Roots");
    const metadata = await lstat(canonical);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new RecoverableError("INVALID_DATA_PATH", "Raw data path must be one regular file");
    if (metadata.size > 2 * 1024 * 1024 * 1024) throw new RecoverableError("DATA_FILE_TOO_LARGE", "Raw data inspection is limited to files at most 2 GiB");
    if (!/[.](?:csv|tsv)$/i.test(canonical)) throw new RecoverableError("UNSUPPORTED_DATA_FORMAT", "Raw data inspection currently supports CSV and TSV files");
    return canonical;
  }

  function registerDataTool(): void {
    if (dataRegistered) return;
    dataRegistered = true;
    pi.registerTool({
      name: DATA_TOOL,
      label: "Profile raw tabular data",
      description: "Profile paginated CSV/TSV schema, selected columns, key cardinality, and optional cross-file key overlap without returning rows or creating a target.",
      promptSnippet: "Profile selected columns and keys directly; paginate schema instead of loading raw files through evaluate_r",
      parameters: DATA_SCHEMA,
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        try {
          await assertWorkerProvenance(context);
          if (!state) throw new RecoverableError("INVALID_PHASE", "Raw data inspection requires an active Workbench Session");
          const input = params as {
            path?: unknown; columns?: unknown; key?: unknown; comparePath?: unknown;
            columnOffset?: unknown; columnLimit?: unknown;
          };
          if (typeof input.path !== "string" || !Array.isArray(input.columns)) {
            throw new RecoverableError("INVALID_REQUEST", "Raw data inspection requires a path and selected-column array");
          }
          if (input.comparePath !== undefined && (typeof input.comparePath !== "string" || typeof input.key !== "string")) {
            throw new RecoverableError("INVALID_REQUEST", "Comparison inspection requires comparePath and key");
          }
          const canonical = await canonicalDataPath(input.path);
          const comparePath = typeof input.comparePath === "string" ? await canonicalDataPath(input.comparePath) : undefined;
          const environment: WorkerEnvironment = state.phase === "implementation" ? "project" : "design";
          const runtime = await workerRuntime(environment);
          const result = await inspectData({
            path: canonical,
            columns: input.columns as string[],
            columnOffset: input.columnOffset as number,
            columnLimit: input.columnLimit as number,
            ...(typeof input.key === "string" ? { key: input.key } : {}),
            ...(comparePath ? { comparePath } : {}),
          }, {
            projectRoot: state.projectRoot,
            readOnlyRoots: state.readOnlyRoots,
            rscript: runtime,
            inspectorScript: process.env.PI_R_DATA_INSPECTOR_SCRIPT ?? "",
            valueSummaryScript: process.env.PI_R_VALUE_SUMMARY_SCRIPT ?? "",
            bwrap: process.env.PI_R_BWRAP,
            sandboxPath: process.env.PI_R_SANDBOX_PATH,
          }, signal);
          return { content: [{ type: "text", text: boundedJson(result) }], details: result };
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
  }

  function registerArtifactTool(): void {
    if (artifactRegistered) return;
    artifactRegistered = true;
    pi.registerTool({
      name: ARTIFACT_TOOL,
      label: "Inspect target-backed artifact",
      description: "Inspect bounded structure and optional summaries for one current contracted table, object, or file target without returning rows by default.",
      promptSnippet: "Inspect artifact structure before loading raw values; request summary only when needed",
      parameters: ARTIFACT_INSPECT_SCHEMA,
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        try {
          await assertWorkerProvenance(context);
          if (!state || state.phase !== "implementation") {
            throw new RecoverableError("INVALID_PHASE", "Artifact inspection requires Implementation Mode");
          }
          const input = params as { target?: unknown; facets?: unknown };
          if (typeof input.target !== "string" || !Array.isArray(input.facets)) {
            throw new RecoverableError("INVALID_REQUEST", "Artifact inspection requires a target and requested facets");
          }
          const contract = validateContract(JSON.parse(await readFile(resolve(state.projectRoot, "pi-r.yml"), "utf8")));
          const target = contract.targets.find((candidate) => candidate.name === input.target);
          if (!target) throw new RecoverableError("UNKNOWN_TARGET", `Target is not declared in the locked contract: ${input.target}`, { target: input.target });
          const facets = input.facets.filter((facet): facet is ArtifactFacet => facet === "structure" || facet === "summary");
          if (facets.length === 0 || facets.length !== input.facets.length || new Set(facets).size !== facets.length) {
            throw new RecoverableError("INVALID_REQUEST", "Artifact facets must be unique structure or summary values");
          }
          const runtime = await workerRuntime("project");
          const result = await inspectArtifact(target, facets, {
            projectRoot: state.projectRoot,
            readOnlyRoots: state.readOnlyRoots,
            rscript: runtime,
            inspectorScript: process.env.PI_R_ARTIFACT_INSPECTOR_SCRIPT ?? "",
            valueSummaryScript: process.env.PI_R_VALUE_SUMMARY_SCRIPT ?? "",
            bwrap: process.env.PI_R_BWRAP,
          }, signal);
          return { content: [{ type: "text", text: boundedJson(result) }], details: result };
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
  }

  function registerEnvironmentTool(): void {
    if (environmentRegistered) return;
    environmentRegistered = true;
    pi.registerTool({
      name: ENVIRONMENT_TOOL,
      label: "Propose governed R dependency change",
      description: "Resolve and validate one package addition or removal against technology policy and pinned Nixpkgs without changing tracked source.",
      promptSnippet: "Stage dependency changes first; only the user can approve the validated environment transaction",
      parameters: DEPENDENCY_PROPOSAL_SCHEMA,
      async execute(_toolCallId, params, _signal, _onUpdate, context) {
        const operation = environmentQueue.then(async () => {
          await assertWorkerProvenance(context);
          if (!state || state.phase !== "implementation") {
            throw new RecoverableError("INVALID_PHASE", "Dependency proposals require Implementation Mode");
          }
          const candidate = await prepareEnvironmentCandidate(
            state.projectRoot,
            state.head,
            params as DependencyProposal,
            (command, args, options) => pi.exec(command, args, options),
          );
          state = { ...state, pendingApproval: "environment-change" };
          pi.appendEntry(STATE_ENTRY, state);
          showHud(context, state);
          return candidate;
        });
        environmentQueue = operation.then(() => undefined, () => undefined);
        try {
          const candidate = await operation;
          const summary = {
            operation: candidate.proposal.operation,
            package: candidate.proposal.package,
            scope: candidate.proposal.scope,
            policy: candidate.policy,
            dependencies: candidate.nextContract.dependencies,
            resolvedPackages: candidate.resolvedPackages,
            generatedFiles: candidate.fileHashes,
            runtime: candidate.runtime,
            trackedSourceChanged: false,
            approval: "Run /r environment to review and approve this candidate",
          };
          return { content: [{ type: "text", text: boundedJson(summary) }], details: candidate };
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
  }

  function registerScoutTool(): void {
    if (scoutRegistered) return;
    scoutRegistered = true;
    pi.registerTool({
      name: SCOUT_TOOL,
      label: "Research ambiguous R dependencies",
      description: "Delegate one sanitized R dependency requirement to an isolated online scout, then annotate its bounded evidence-backed candidates with local policy and pinned-Nixpkgs resolution. The scout cannot select, mutate, approve, install, or activate.",
      promptSnippet: "Use only for ambiguous dependency discovery; pass no workspace content, then propose any selected resolved candidate separately",
      parameters: DEPENDENCY_SCOUT_SCHEMA,
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        const operation = scoutQueue.then(async () => {
          await assertWorkerProvenance(context);
          if (!state || state.phase !== "implementation") {
            throw new RecoverableError("INVALID_PHASE", "Dependency research requires Implementation Mode with a pinned Project Contract");
          }
          const contract = validateContract(JSON.parse(await readFile(resolve(state.projectRoot, "pi-r.yml"), "utf8")));
          const invocation = scoutPiInvocation();
          const extension = process.env.PI_R_SCOUT_EXTENSION ?? resolve(dirname(fileURLToPath(import.meta.url)), "pi-r-dependency-scout.ts");
          return scoutDependencies(
            params as DependencyScoutRequest,
            contract.project.nixpkgs,
            state.projectRoot,
            (command, args, options) => pi.exec(command, args, options),
            { pi: invocation.command, piArguments: invocation.arguments, extension, signal },
          );
        });
        scoutQueue = operation.then(() => undefined, () => undefined);
        try {
          const report = await operation;
          const summary = {
            ...report,
            authority: "research-only",
            nextStep: "Choose only a selectable candidate and call r_dependency_propose; deterministic resolution and user approval remain separate",
            trackedSourceChanged: false,
          };
          return { content: [{ type: "text", text: boundedJson(summary) }], details: report };
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
  }

  function enterPhase(next: WorkbenchState): void {
    previousActiveTools ??= pi.getActiveTools();
    const constrained = { ...next, allowedTools: phaseTools(next.phase, next.editableScopeCount) };
    quarantineReason = undefined;
    state = constrained;
    pi.setActiveTools(constrained.allowedTools);
  }

  function registerProposalTool(): void {
    if (proposalRegistered) return;
    proposalRegistered = true;
    pi.registerTool({
      name: "r_contract_propose",
      label: "Propose R project contract",
      description: "Validate and replace the complete ignored Project Contract draft in Design or Contract Revision Mode. Approved Functions declare signatures, purpose, and user-approved behavioral requirements but never bodies. Locking creates fail-closed stubs. Source File Targets use source.constant and omit function/output; generated file outputs use output bindings. Does not write project source.",
      promptSnippet: "Propose all project decisions once; every Approved Function needs evidence-backed requirements for missing values, duplicates, coding, cohort, and outputs where relevant",
      parameters: CONTRACT_PROPOSAL_SCHEMA,
      async execute(_toolCallId, params, _signal, _onUpdate, context) {
        const operation = proposalQueue.then(async () => {
          if (!state || (state.phase !== "design" && state.phase !== "revision")) {
            throw new Error("Contract proposals require active Design or Contract Revision Mode");
          }
          let contract: ProjectContract;
          try {
            const pinPath = process.env.PI_R_NIXPKGS_PIN_PATH;
            if (!pinPath) throw new Error("PI_R_NIXPKGS_PIN_PATH is required");
            const pin = JSON.parse(await readFile(pinPath, "utf8")) as NixpkgsPin;
            contract = normalizeContractProposal(params, pin);
          } catch (error) {
            throw new Error(`Contract proposal rejected: ${error instanceof Error ? error.message : String(error)}`);
          }
          const excludeResult = await git(["rev-parse", "--git-path", "info/exclude"], state.projectRoot);
          const excludePath = isAbsolute(excludeResult.stdout.trim())
            ? excludeResult.stdout.trim()
            : resolve(state.projectRoot, excludeResult.stdout.trim());
          const exclusion = await readFile(excludePath, "utf8").catch(() => "");
          if (!exclusion.split("\n").includes(".pi/tmp/")) {
            await mkdir(dirname(excludePath), { recursive: true });
            await writeFile(excludePath, `${exclusion}${exclusion.endsWith("\n") || !exclusion ? "" : "\n"}.pi/tmp/\n`, "utf8");
          }
          const draft = resolve(state.projectRoot, ".pi/tmp/pi-r-contract-draft.json");
          await mkdir(dirname(draft), { recursive: true });
          const temporary = `${draft}.tmp`;
          await writeFile(temporary, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
          await rename(temporary, draft);
          state = { ...state, contractState: "draft", behaviorBlockedCount: unspecifiedBehaviorFunctions(contract).length };
          pi.appendEntry(STATE_ENTRY, state);
          showHud(context, state);
          return {
            content: [{ type: "text", text: `Draft accepted.\n\n${contractSummary(contract)}` }],
            details: { draft, summary: contractSummary(contract) },
          };
        });
        proposalQueue = operation.then(() => undefined, () => undefined);
        return operation;
      },
    });
    pi.registerTool({
      name: BEHAVIOR_PROPOSAL_TOOL,
      label: "Propose Approved Function behavior",
      description: "In Contract Revision Mode, update only purpose and behavioral requirements for existing Approved Functions while preserving topology and all other project decisions. Use only user decisions or identified authoritative sources. Final approval remains user-only through /r lock.",
      promptSnippet: "Before proposing, identify unresolved duplicate, missing-value, coding, cohort, join, event, censoring, and output decisions; ask the user instead of inferring them from names or observed values",
      parameters: BEHAVIOR_PROPOSAL_SCHEMA,
      async execute(_toolCallId, params, _signal, _onUpdate, context) {
        const operation = proposalQueue.then(async () => {
          if (!state || state.phase !== "revision") {
            throw new RecoverableError("INVALID_PHASE", "Behavior-only proposals require active Contract Revision Mode");
          }
          const input = params as { functions?: Array<{ name?: unknown; purpose?: unknown; requirements?: unknown; basis?: unknown }> };
          const updates = input.functions ?? [];
          const names = updates.map((entry) => entry.name);
          if (new Set(names).size !== names.length) {
            throw new RecoverableError("INVALID_REQUEST", "Behavior proposal function names must be unique");
          }
          const draftPath = resolve(state.projectRoot, ".pi/tmp/pi-r-contract-draft.json");
          const raw = JSON.parse(await readFile(draftPath, "utf8")) as Record<string, any>;
          const proposal: Record<string, any> = "contractVersion" in raw
            ? (() => {
                const { contractVersion: _contractVersion, templateVersion: _templateVersion, policyVersion: _policyVersion, ...decisions } = raw;
                return { ...decisions, project: { name: raw.project.name } };
              })()
            : structuredClone(raw);
          if (!Array.isArray(proposal.functions)) {
            throw new RecoverableError("INVALID_DRAFT", "Contract draft has no Approved Functions");
          }
          const known = new Set(proposal.functions.map((fn: { name?: unknown }) => fn.name));
          const unknown = names.filter((name) => typeof name !== "string" || !known.has(name));
          if (unknown.length > 0) {
            throw new RecoverableError("SCOPE_VIOLATION", `Behavior proposal names unknown Approved Functions: ${unknown.join(", ")}`);
          }
          for (const update of updates) {
            if (typeof update.purpose !== "string" || update.purpose.length < 1 || update.purpose.length > 500) {
              throw new RecoverableError("INVALID_REQUEST", `Behavior purpose for '${String(update.name)}' must contain 1–500 characters`);
            }
            if (
              !Array.isArray(update.requirements) ||
              update.requirements.length < 1 ||
              update.requirements.length > 10 ||
              update.requirements.some((requirement) => typeof requirement !== "string" || requirement.length < 1 || requirement.length > 300)
            ) {
              throw new RecoverableError("INVALID_REQUEST", `Behavior requirements for '${String(update.name)}' must contain 1–10 bounded statements`);
            }
            if (typeof update.basis !== "string" || update.basis.length < 1 || update.basis.length > 300) {
              throw new RecoverableError("INVALID_REQUEST", `Behavior basis for '${String(update.name)}' must identify a user decision or authoritative source`);
            }
          }
          const byName = new Map(updates.map((entry) => [entry.name, entry]));
          proposal.functions = proposal.functions.map((fn: Record<string, unknown>) => {
            const update = byName.get(fn.name);
            return update
              ? { ...fn, purpose: update.purpose, requirements: update.requirements }
              : fn;
          });
          const unresolved = proposal.functions
            .filter((fn: Record<string, unknown>) =>
              typeof fn.purpose !== "string" || fn.purpose.length === 0 || !Array.isArray(fn.requirements) || fn.requirements.length === 0,
            )
            .map((fn: Record<string, unknown>) => String(fn.name));
          let draftValue: unknown = proposal;
          if (unresolved.length === 0) {
            const pinPath = process.env.PI_R_NIXPKGS_PIN_PATH;
            if (!pinPath) throw new Error("PI_R_NIXPKGS_PIN_PATH is required");
            const pin = JSON.parse(await readFile(pinPath, "utf8")) as NixpkgsPin;
            draftValue = normalizeContractProposal(proposal, pin);
          }
          const temporary = `${draftPath}.tmp`;
          await writeFile(temporary, `${JSON.stringify(draftValue, null, 2)}\n`, "utf8");
          await rename(temporary, draftPath);
          state = { ...state, contractState: "draft", behaviorBlockedCount: unresolved.length };
          pi.appendEntry(STATE_ENTRY, state);
          showHud(context, state);
          const summary = {
            status: unresolved.length === 0 ? "ready-for-user-lock-review" : "behavior-incomplete",
            updatedFunctions: updates.map((entry) => ({ name: entry.name, basis: entry.basis })),
            unresolvedFunctions: unresolved,
            nextAction: unresolved.length === 0
              ? { actor: "user", command: "/r lock", action: "Review and approve the complete behavioral contract" }
              : { actor: "model", action: "Ask the user for unresolved decisions; do not infer them" },
          };
          return { content: [{ type: "text", text: boundedJson(summary) }], details: { ...summary, draft: draftPath } };
        });
        proposalQueue = operation.then(() => undefined, () => undefined);
        try {
          return await operation;
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
  }

  function modelEditRequest(params: unknown): unknown {
    if (!params || typeof params !== "object") return params;
    const input = params as Record<string, unknown>;
    if (typeof input.statements !== "string") return params;
    const statements = input.statements.trim();
    if (!statements) {
      throw new RecoverableError("INVALID_EDIT_SHAPE", "statements must contain R code", undefined, {
        retryable: true,
        agentAction: "Provide only statements from inside the Approved Function body",
      });
    }
    const selectedName = typeof input.function === "string"
      ? input.function.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : "";
    const significantStart = statements.replace(/^(?:(?:[ \t]*#.*)?\r?\n)*/, "").trimStart();
    const repeatsOuterDeclaration = selectedName
      ? new RegExp(`^${selectedName}\\s*<-\\s*function\\s*\\(`).test(significantStart)
      : false;
    if (repeatsOuterDeclaration || significantStart.startsWith("{")) {
      throw new RecoverableError(
        "INVALID_EDIT_SHAPE",
        "statements must omit the function declaration and outer braces",
        { example: "fread(shhs1_status_file)" },
        { retryable: true, agentAction: "Retry once with only the statements inside the function body" },
      );
    }
    return {
      function: input.function,
      expectedSourceHash: input.expectedSourceHash,
      operation: { kind: "replace", body: `{\n${statements}\n}` },
    };
  }

  async function applyScopedEdit(params: unknown, context: CommandContext): Promise<unknown> {
    if (!state || state.phase !== "implementation") {
      throw new RecoverableError("INVALID_PHASE", "Approved Function edits require active Implementation Mode");
    }
    const modeledRequest = modelEditRequest(params);
    const input = params as { function?: unknown; expectedSourceHash?: unknown };
    const inspectionGrant = lastEditInspection;
    lastEditInspection = undefined;
    if (
      !inspectionGrant ||
      input.function !== inspectionGrant.function ||
      input.expectedSourceHash !== inspectionGrant.sourceHash
    ) {
      throw new RecoverableError(
        "INSPECTION_REQUIRED",
        "Edit one function at a time immediately after inspecting that same function with a positive sourceLimit",
        { remainingParallelEditsWillFail: true },
        { retryable: true, agentAction: "Inspect exactly one behavior-specified function, then edit only that function before any other edit" },
      );
    }
    const mismatch = await verifyState(state, context);
    if (mismatch) throw new RecoverableError("PROVENANCE_MISMATCH", mismatch);
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], state.projectRoot);
    if (dirty.stdout.trim()) {
      throw new RecoverableError("STALE_CONTENT", "Tracked source changed outside the scoped edit capability");
    }
    const prepared = await prepareScopedMutation(state.projectRoot, modeledRequest);
    const destination = resolve(state.projectRoot, prepared.path);
    if ((await readFile(destination, "utf8")) !== prepared.original) {
      throw new RecoverableError("STALE_CONTENT", "Approved Function file changed before commit");
    }
    const temporary = `${destination}.pi-r-edit-tmp`;
    try {
      await writeFile(temporary, prepared.candidate, "utf8");
      await rename(temporary, destination);
      await git(["add", "--", prepared.path], state.projectRoot);
      await git(
        [
          "commit",
          "-m",
          `Implement Approved Function ${prepared.function}`,
          "-m",
          `Capability: ${prepared.capabilityVersion}\nContract-Hash: ${prepared.contractHash}\nContract-Version: ${prepared.contractVersion}\nPolicy-Version: ${prepared.policyVersion}`,
          "--",
          prepared.path,
        ],
        state.projectRoot,
      );
    } catch (error) {
      await rm(temporary, { force: true });
      await git(["reset", "--quiet", "HEAD", "--", prepared.path], state.projectRoot, true);
      await writeFile(destination, prepared.original, "utf8");
      throw error;
    }
    const commitHash = (await git(["rev-parse", "HEAD"], state.projectRoot)).stdout.trim();
    const next = { ...state, head: commitHash, allowedTools: phaseTools("implementation") };
    enterPhase(next);
    pi.appendEntry(STATE_ENTRY, next);
    showHud(context, next);
    const diff = prepared.diff.length <= 40_000
      ? prepared.diff
      : `${prepared.diff.slice(0, 40_000)}\n[formatted diff truncated]`;
    const verification = {
      status: "required",
      requirements: prepared.behavior.requirements,
      agentAction: "List freshness, run the narrowest downstream contracted targets, and inspect their bounded artifacts against every locked requirement",
    };
    return {
      content: [{ type: "text", text: boundedJson({
        function: prepared.function,
        path: prepared.path,
        commitHash,
        verification,
      }) }],
      details: { commitHash, diff, function: prepared.function, path: prepared.path, verification },
    };
  }

  function actionableToolError(error: unknown): Error {
    if (error instanceof RecoverableError) {
      const details = error.structured.details ? ` ${JSON.stringify(error.structured.details)}` : "";
      const retry = error.structured.retryable === false ? " Retryable: no." : "";
      const action = error.structured.agentAction ? ` Agent action: ${error.structured.agentAction}.` : "";
      return new Error(`${error.structured.code}: ${error.message}.${retry}${action}${details}`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  function registerEditTool(): void {
    if (editRegistered) return;
    editRegistered = true;
    pi.registerTool({
      name: INSPECT_TOOL,
      label: "Inspect Approved R function",
      description: "Read compact status for up to 20 Approved Functions, or inspect one source page immediately before one edit. Compact inspection omits source and digests. A behavior blocker requires user-only /r revise before implementation planning.",
      promptSnippet: "If compact status is blocked, stop and request /r revise without inspecting data or drafting bodies. Otherwise inspect one source page, edit that function only, then repeat; never issue parallel edits.",
      parameters: INSPECT_SCHEMA,
      async execute(_toolCallId, params, _signal, _onUpdate, context) {
        const operation = editQueue.then(async () => {
          if (!state || state.phase !== "implementation") {
            throw new RecoverableError("INVALID_PHASE", "Approved Function inspection requires Implementation Mode");
          }
          const mismatch = await verifyState(state, context);
          if (mismatch) throw new RecoverableError("PROVENANCE_MISMATCH", mismatch);
          const dirty = await git(["status", "--porcelain", "--untracked-files=no"], state.projectRoot);
          if (dirty.stdout.trim()) {
            throw new RecoverableError("STALE_CONTENT", "Tracked source changed outside scoped capabilities");
          }
          const input = params as { functions?: unknown; sourceOffset?: unknown; sourceLimit?: unknown };
          const names = input.functions as string[];
          const sourceOffset = input.sourceOffset as number;
          const sourceLimit = input.sourceLimit as number;
          if (sourceLimit > 0 && names.length !== 1) {
            throw new RecoverableError("INVALID_REQUEST", "A positive sourceLimit requires exactly one Approved Function");
          }
          const inspected = await inspectApprovedFunctions(state.projectRoot, names);
          const blockedFunctions = inspected.filter((entry) => !entry.behavior.specified).map((entry) => entry.function);
          const singleSourceInspection = names.length === 1 && sourceLimit > 0 && inspected[0].behavior.specified;
          lastEditInspection = singleSourceInspection
            ? { function: inspected[0].function, sourceHash: inspected[0].sourceHash }
            : undefined;
          const functions = inspected.map((entry) => {
            const sourcePage = singleSourceInspection ? entry.source.slice(sourceOffset, sourceOffset + sourceLimit) : undefined;
            const nextSourceOffset = sourcePage !== undefined && sourceOffset + sourcePage.length < entry.source.length
              ? sourceOffset + sourcePage.length
              : null;
            if (!singleSourceInspection) {
              return {
                function: entry.function,
                path: entry.path,
                signature: entry.signature,
                behavior: {
                  specified: entry.behavior.specified,
                  purpose: entry.behavior.purpose,
                  requirementCount: entry.behavior.requirements.length,
                  requirementsOmitted: entry.behavior.requirements.length > 0,
                },
                implementationStatus: entry.source.includes("Approved Function not implemented") ? "stub" : "present",
                sourceOmitted: true,
              };
            }
            return {
              function: entry.function,
              path: entry.path,
              signature: entry.signature,
              source: sourcePage,
              sourceHash: entry.sourceHash,
              sourceBytes: Buffer.byteLength(entry.source),
              sourceOffset,
              nextSourceOffset,
              sourceOmitted: false,
              behavior: entry.behavior,
            };
          });
          return {
            status: blockedFunctions.length > 0 ? "blocked" : "ready",
            contract: {
              hash: inspected[0].contractHash,
              version: inspected[0].contractVersion,
              policyVersion: inspected[0].policyVersion,
            },
            blockedFunctions,
            ...(blockedFunctions.length > 0
              ? {
                  blockingReason: "BEHAVIOR_UNSPECIFIED",
                  nextAction: { actor: "user", command: "/r revise", action: "Approve purpose and requirements before implementation planning" },
                }
              : {}),
            functions,
          };
        });
        editQueue = operation.then(() => undefined, () => undefined);
        try {
          const inspection = await operation;
          return {
            content: [{ type: "text", text: boundedJson(inspection) }],
            details: inspection,
          };
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
    pi.registerTool({
      name: EDIT_TOOL,
      label: "Edit Approved R function body",
      description: "Replace one Approved Function body immediately after inspecting that same function. Implement only locked purpose and requirements. Pass inner statements; pi-r wraps, formats, validates, and commits one function before the next. Never issue parallel edits. Governed package functions are called without :: namespace operators.",
      promptSnippet: "Act without repeating the body or hash in prose: use the inspected digest, implement only locked requirements, pass inner statements, and do not use ::",
      parameters: EDIT_SCHEMA,
      async execute(_toolCallId, params, _signal, _onUpdate, context) {
        const operation = editQueue.then(() => applyScopedEdit(params, context));
        editQueue = operation.then(() => undefined, () => undefined);
        try {
          return await operation;
        } catch (error) {
          throw actionableToolError(error);
        }
      },
    });
  }

  function quarantine(context: CommandContext, message: string): void {
    previousActiveTools ??= pi.getActiveTools();
    quarantineReason = message.slice(0, 2000);
    state = undefined;
    updateLiveWorker([], false, "inactive");
    pi.setActiveTools([]);
    context.ui.setWidget?.("pi-r-hud", ["pi-r RESUME BLOCKED", quarantineReason]);
    context.ui.setStatus?.("pi-r", "R:resume blocked");
    context.ui.notify(quarantineReason, "error");
  }

  async function verifyState(candidate: WorkbenchState, context: CommandContext): Promise<string | undefined> {
    const cwd = await realpath(context.cwd).catch(() => resolve(context.cwd));
    if (cwd !== candidate.workingDirectory) return "active working directory changed";
    const root = await git(["rev-parse", "--show-toplevel"], cwd, true);
    if (root.code !== 0 || (await realpath(root.stdout.trim()).catch(() => root.stdout.trim())) !== candidate.projectRoot) {
      return "Git project changed";
    }
    const branch = await git(["branch", "--show-current"], cwd, true);
    if (branch.code !== 0 || branch.stdout.trim() !== candidate.branch) return "Git branch changed";
    const head = await git(["rev-parse", "HEAD"], cwd, true);
    if (head.code !== 0 || head.stdout.trim() !== candidate.head) return "Git HEAD changed";
    for (const rootPath of candidate.readOnlyRoots) {
      if ((await realpath(rootPath).catch(() => undefined)) !== rootPath) return "attached read-only root changed";
    }
    return undefined;
  }

  async function approvedRoot(path: string): Promise<string> {
    return realpath(path);
  }

  async function preflightWorker(
    projectRoot: string,
    readOnlyRoots: string[],
    environment: WorkerEnvironment,
    rscript: string,
  ): Promise<void> {
    const logDirectory = await mkdtemp(join(tmpdir(), "pi-r-worker-preflight-"));
    const probe = new SandboxedRWorker({
      projectRoot,
      readOnlyRoots,
      workerScript: process.env.PI_R_WORKER_SCRIPT ?? "",
      bwrap: process.env.PI_R_BWRAP,
      sandboxPath: process.env.PI_R_SANDBOX_PATH,
      requestTimeoutMs: 10_000,
      logDirectory,
    });
    try {
      await probe.healthCheck(environment, rscript);
      probe.stop(false);
      await rm(logDirectory, { recursive: true, force: true });
    } catch (error) {
      probe.stop(true);
      throw error;
    }
  }

  async function start(rootArguments: string[], context: CommandContext): Promise<void> {
    if (state) throw new Error("pi-r Workbench Session is already active; use /r status or /r stop");
    const startedAt = Date.now();
    showStartProgress(context, "checking repository");
    const workingDirectory = await realpath(context.cwd);
    const rootResult = await git(["rev-parse", "--show-toplevel"], workingDirectory);
    const projectRoot = await realpath(rootResult.stdout.trim());
    await git(["rev-parse", "--verify", "HEAD"], workingDirectory);

    showStartProgress(context, "validating read-only roots");
    const readOnlyRoots: string[] = [];
    for (const argument of rootArguments) {
      const requested = isAbsolute(argument) ? argument : resolve(workingDirectory, argument);
      readOnlyRoots.push(await approvedRoot(requested));
    }
    const uniqueRoots = [...new Set(readOnlyRoots)].sort();
    const currentBranch = await git(["branch", "--show-current"], workingDirectory);
    const branchExists = await git(
      ["show-ref", "--verify", "--quiet", `refs/heads/${WORKBENCH_BRANCH}`],
      workingDirectory,
      true,
    );
    let preflightedRuntime: string | undefined;
    const preflightLocked = async (contract: ProjectContract, scaffoldRoot: string): Promise<void> => {
      showStartProgress(context, "checking locked scaffold");
      if (scaffoldRoot !== projectRoot) {
        for (const target of contract.targets.filter(isSourceFileTarget)) {
          const declared = contract.constants[target.source.constant];
          if (typeof declared !== "string" || isAbsolute(declared)) continue;
          const existsInTarget = await access(resolve(scaffoldRoot, declared)).then(() => true, () => false);
          if (existsInTarget) continue;
          const trackedInCurrent = await git(["ls-files", "--error-unmatch", "--", declared], projectRoot, true);
          if (trackedInCurrent.code === 0) {
            throw new Error(`Source File Target ${target.name} is tracked on the current branch but missing from ${WORKBENCH_BRANCH}`);
          }
        }
      }
      await validateSourceFileAuthority(
        contract,
        scaffoldRoot,
        uniqueRoots,
        scaffoldRoot === projectRoot ? undefined : projectRoot,
      );
      await checkScaffold(contract, scaffoldRoot);
      showStartProgress(context, "resolving project R runtime");
      preflightedRuntime = await resolveProjectRuntime(scaffoldRoot);
      showStartProgress(context, "checking project R worker");
      await preflightWorker(scaffoldRoot, uniqueRoots, "project", preflightedRuntime);
    };
    const currentContractPath = resolve(projectRoot, "pi-r.yml");
    const canUseCurrentTree = currentBranch.stdout.trim() === WORKBENCH_BRANCH || branchExists.code !== 0;
    if (canUseCurrentTree && await access(currentContractPath).then(() => true, () => false)) {
      await preflightLocked(validateContract(JSON.parse(await readFile(currentContractPath, "utf8"))), projectRoot);
    } else if (branchExists.code === 0 && currentBranch.stdout.trim() !== WORKBENCH_BRANCH) {
      const contractAtBranch = await git(["show", `${WORKBENCH_BRANCH}:pi-r.yml`], projectRoot, true);
      if (contractAtBranch.code === 0) {
        const temporary = await mkdtemp(join(tmpdir(), "pi-r-start-checkout-"));
        const checkout = resolve(temporary, "workbench");
        try {
          showStartProgress(context, "preflighting workbench branch");
          const cloned = await pi.exec(
            "git",
            ["clone", "--quiet", "--shared", "--branch", WORKBENCH_BRANCH, "--single-branch", projectRoot, checkout],
            { cwd: projectRoot, timeout: 30_000 },
          );
          if (cloned.code !== 0) throw new Error(`Cannot preflight workbench branch: ${resultMessage(cloned)}`);
          await preflightLocked(validateContract(JSON.parse(contractAtBranch.stdout)), checkout);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      } else {
        const designRuntime = process.env.PI_R_RSCRIPT;
        if (!designRuntime) throw new RecoverableError("WORKER_START_FAILED", "Bundled design R runtime is unavailable");
        showStartProgress(context, "checking sandboxed R");
        await preflightWorker(projectRoot, uniqueRoots, "design", designRuntime);
      }
    } else {
      const designRuntime = process.env.PI_R_RSCRIPT;
      if (!designRuntime) throw new RecoverableError("WORKER_START_FAILED", "Bundled design R runtime is unavailable");
      showStartProgress(context, "checking sandboxed R");
      await preflightWorker(projectRoot, uniqueRoots, "design", designRuntime);
    }

    showStartProgress(context, "preparing workbench branch");
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
    if (dirty.stdout.trim()) {
      await git(
        ["stash", "push", "-m", "pi-r: tracked changes before workbench start"],
        workingDirectory,
      );
    }

    if (currentBranch.stdout.trim() !== WORKBENCH_BRANCH) {
      if (branchExists.code === 0) await git(["switch", WORKBENCH_BRANCH], workingDirectory);
      else await git(["switch", "-c", WORKBENCH_BRANCH], workingDirectory);
    }

    const head = (await git(["rev-parse", "HEAD"], workingDirectory)).stdout.trim();
    showStartProgress(context, "checking Project Contract");
    const contractPath = resolve(projectRoot, "pi-r.yml");
    const hasLockedContract = await access(contractPath).then(() => true, () => false);
    const lockedContract = hasLockedContract
      ? validateContract(JSON.parse(await readFile(contractPath, "utf8")))
      : undefined;
    if (lockedContract) await validateSourceFileAuthority(lockedContract, projectRoot, uniqueRoots);
    worker?.stop(true);
    worker = undefined;
    projectRscript = undefined;
    updateLiveWorker([], false, "workbench-started");
    previousCompletionTruncated = false;
    previousActiveTools ??= pi.getActiveTools();
    registerWorkerTools();
    registerDataTool();
    let phase: Phase = "design";
    let contractState: WorkbenchState["contractState"] = "missing";
    let editableScopeCount = 0;
    let behaviorBlockedCount = 0;
    if (lockedContract) {
      let runtime = preflightedRuntime;
      if (!runtime) {
        showStartProgress(context, "checking locked scaffold");
        await checkScaffold(lockedContract, projectRoot);
        showStartProgress(context, "resolving project R runtime");
        runtime = await resolveProjectRuntime(projectRoot);
        showStartProgress(context, "checking project R worker");
        await preflightWorker(projectRoot, uniqueRoots, "project", runtime);
      }
      projectRscript = runtime;
      phase = "implementation";
      contractState = "locked";
      behaviorBlockedCount = unspecifiedBehaviorFunctions(lockedContract).length;
      editableScopeCount = lockedContract.functions.length - behaviorBlockedCount;
      registerEditTool();
      registerTargetTools();
      registerArtifactTool();
      registerEnvironmentTool();
      registerScoutTool();
    } else {
      registerProposalTool();
    }
    const next: WorkbenchState = {
      version: 3,
      runtimeVersion: PI_R_RUNTIME_VERSION,
      phase,
      projectRoot,
      workingDirectory,
      branch: WORKBENCH_BRANCH,
      head,
      contractState,
      policyState: "pi-r-policy-v1",
      editableScopeCount,
      behaviorBlockedCount,
      pendingApproval: "none",
      workerState: "stopped",
      readOnlyRoots: uniqueRoots,
      allowedTools: phaseTools(phase),
    };
    enterPhase(next);
    pi.appendEntry(STATE_ENTRY, next);
    showHud(context, next);
    context.ui.notify(`pi-r workbench started in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${hud(next)}`, "info");
  }

  async function publicationCandidate(contract: ProjectContract): Promise<DeliverablePublication> {
    if (!state) throw new RecoverableError("INVALID_PHASE", "Deliverable publication requires an active Workbench Session");
    const runtime = await workerRuntime("project");
    const targets = contract.deliverables.map((deliverable) => deliverable.target);
    const freshness = await listTargets(targets, {
      projectRoot: state.projectRoot,
      readOnlyRoots: state.readOnlyRoots,
      rscript: runtime,
      runnerScript: process.env.PI_R_TARGET_RUNNER_SCRIPT ?? "",
      bwrap: process.env.PI_R_BWRAP,
    });
    return prepareDeliverablePublication(
      state.projectRoot,
      contract,
      freshness.targets.map((target) => ({ target: target.name, freshness: target.freshness })),
      (command, args, options) => pi.exec(command, args, options),
    );
  }

  async function publishDeliverables(context: CommandContext): Promise<void> {
    if (!state || state.phase !== "implementation") {
      throw new RecoverableError("INVALID_PHASE", "Deliverable publication requires Implementation Mode");
    }
    const mismatch = await verifyState(state, context);
    if (mismatch) throw new RecoverableError("PROVENANCE_MISMATCH", mismatch);
    const contract = validateContract(JSON.parse(await readFile(resolve(state.projectRoot, "pi-r.yml"), "utf8")));
    await checkScaffold(contract, state.projectRoot);
    const candidate = await publicationCandidate(contract);
    state = { ...state, pendingApproval: "deliverable-publish" };
    showHud(context, state);
    const summary = candidate.changes
      .map((change) => `${change.status} ${change.path} (${change.bytes} bytes, sha256:${change.sha256})`)
      .join("\n");
    const confirmed = await context.ui.confirm?.(
      "Publish declared deliverables?",
      `${summary}\n\n${candidate.preview}\n\nOnly these contract-declared paths will be staged. Approval creates one deliverable provenance commit.`,
    ) ?? false;
    if (!confirmed) {
      state = { ...state, pendingApproval: "none" };
      showHud(context, state);
      context.ui.notify("Deliverable publication cancelled; outputs and Git were left unchanged", "info");
      return;
    }

    let staged = false;
    try {
      const refreshed = await publicationCandidate(contract);
      if (refreshed.head !== candidate.head || refreshed.digest !== candidate.digest) {
        throw new RecoverableError("STALE_DELIVERABLE_PREVIEW", "Declared deliverables changed after the publication preview");
      }
      const paths = refreshed.changes.map((change) => change.path).sort();
      await git(["add", "--", ...paths], state.projectRoot);
      staged = true;
      const stagedPaths = (await git(["diff", "--cached", "--name-only", "-z"], state.projectRoot)).stdout
        .split("\0").filter(Boolean).sort();
      if (JSON.stringify(stagedPaths) !== JSON.stringify(paths)) {
        throw new RecoverableError("UNDECLARED_STAGED_OUTPUT", "Git index contains paths outside the approved deliverable set", { paths: stagedPaths });
      }
      for (const change of refreshed.changes) {
        const stagedBlob = (await git(["rev-parse", `:${change.path}`], state.projectRoot)).stdout.trim();
        if (stagedBlob !== change.gitBlob) {
          throw new RecoverableError("STALE_DELIVERABLE_PREVIEW", `Deliverable changed while it was being staged: ${change.path}`);
        }
      }
      const commitMessage = [
        `Publish declared deliverables`,
        "",
        "Capability: r_deliverable_publish",
        `Deliverables: ${paths.join(", ")}`,
        `Publication-Digest: sha256:${refreshed.digest}`,
      ].join("\n");
      await git(["commit", "-m", commitMessage], state.projectRoot);
      const head = (await git(["rev-parse", "HEAD"], state.projectRoot)).stdout.trim();
      state = { ...state, head, pendingApproval: "none" };
      liveTransition = "deliverables-published";
      pi.appendEntry(STATE_ENTRY, state);
      showHud(context, state);
      context.ui.notify(`Published ${paths.length} declared deliverable(s) in ${shortHead(head)}`, "info");
    } catch (error) {
      if (staged && state) await git(["reset", "--quiet", "HEAD", "--", ...candidate.changes.map((change) => change.path)], state.projectRoot, true);
      if (state?.pendingApproval === "deliverable-publish") {
        state = { ...state, pendingApproval: "none" };
        showHud(context, state);
      }
      throw error;
    }
  }

  async function activateEnvironmentCandidate(candidate: EnvironmentCandidate, context: CommandContext): Promise<void> {
    if (!state || state.phase !== "implementation") throw new RecoverableError("INVALID_PHASE", "Environment activation requires Implementation Mode");
    const currentHead = (await git(["rev-parse", "HEAD"], state.projectRoot)).stdout.trim();
    if (candidate.expectedHead !== state.head || candidate.expectedHead !== currentHead) {
      throw new RecoverableError("STALE_ENVIRONMENT_CANDIDATE", "Project HEAD changed after the environment candidate was validated");
    }
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], state.projectRoot);
    if (dirty.stdout.trim()) throw new RecoverableError("STALE_CONTENT", "Tracked source changed after the environment candidate was validated");
    const snapshots = new Map<string, string | undefined>();
    for (const path of ENVIRONMENT_PATHS) snapshots.set(path, await readFile(resolve(state.projectRoot, path), "utf8").catch(() => undefined));
    const sharedPolicy = candidate.proposal.scope === "shared" && candidate.policy.status === "unregistered"
      ? prepareSharedPolicyUpdate(candidate.proposal.package, candidate.proposal.domain, candidate.proposal.rationale)
      : undefined;
    try {
      if (sharedPolicy) {
        await mkdir(dirname(sharedPolicy.path), { recursive: true });
        const temporary = `${sharedPolicy.path}.pi-r-policy-tmp`;
        await writeFile(temporary, sharedPolicy.content, "utf8");
        await rename(temporary, sharedPolicy.path);
      }
      for (const path of ENVIRONMENT_PATHS) {
        const destination = resolve(state.projectRoot, path);
        await mkdir(dirname(destination), { recursive: true });
        const temporary = `${destination}.pi-r-environment-tmp`;
        await writeFile(temporary, candidate.files[path], "utf8");
        await rename(temporary, destination);
      }
      await git(["add", "--", ...ENVIRONMENT_PATHS], state.projectRoot);
      await git([
        "commit",
        "-m",
        `${candidate.proposal.operation === "add" ? "Add" : "Remove"} governed R dependency ${candidate.proposal.package}`,
        "-m",
        `Capability: pi-r-environment-v1\nPolicy-Version: ${candidate.nextContract.policyVersion}\nTechnology-Policy: ${candidate.policyRegistryVersion}\nApproval-Scope: ${candidate.proposal.scope}`,
        "--",
        ...ENVIRONMENT_PATHS,
      ], state.projectRoot);
    } catch (error) {
      await git(["reset", "--quiet", "HEAD", "--", ...ENVIRONMENT_PATHS], state.projectRoot, true);
      await Promise.all(ENVIRONMENT_PATHS.map((path) => rm(`${resolve(state!.projectRoot, path)}.pi-r-environment-tmp`, { force: true })));
      if (sharedPolicy) {
        await rm(`${sharedPolicy.path}.pi-r-policy-tmp`, { force: true });
        if (sharedPolicy.previous === undefined) await rm(sharedPolicy.path, { force: true });
        else await writeFile(sharedPolicy.path, sharedPolicy.previous, "utf8");
      }
      for (const [path, previous] of snapshots) {
        const destination = resolve(state.projectRoot, path);
        if (previous === undefined) await rm(destination, { force: true });
        else await writeFile(destination, previous, "utf8");
      }
      throw error;
    }

    const reset = worker
      ? await worker.reset("Governed R environment activated")
      : { lostObjects: 0, reason: "Governed R environment activated" };
    worker = undefined;
    projectRscript = candidate.runtime;
    const head = (await git(["rev-parse", "HEAD"], state.projectRoot)).stdout.trim();
    const next: WorkbenchState = {
      ...state,
      head,
      pendingApproval: "none",
      workerState: "stopped",
      allowedTools: phaseTools("implementation"),
    };
    enterPhase(next);
    updateLiveWorker([], reset.lostObjects > 0 || liveTransientStateLost, "environment-activated");
    pi.appendEntry(STATE_ENTRY, next);
    showHud(context, next);
    await discardEnvironmentCandidate(next.projectRoot);
    context.ui.notify(
      `Environment activated in ${head.slice(0, 12)}; worker restarted, transient objects lost=${reset.lostObjects}, targets cache preserved`,
      "info",
    );
  }

  async function writeScaffoldCommit(
    contract: ProjectContract,
    files: ReadonlyMap<string, string>,
    runtime: string,
    removedPaths: readonly string[] = [],
  ): Promise<WorkbenchState> {
    if (!state) throw new Error("Workbench state disappeared");
    const root = state.projectRoot;
    const revision = state.phase === "revision";
    const paths = [...new Set([...files.keys(), ...removedPaths])].sort();
    const snapshots = new Map<string, string | undefined>();
    for (const path of paths) snapshots.set(path, await readFile(resolve(root, path), "utf8").catch(() => undefined));
    try {
      for (const [path, content] of files) {
        const destination = resolve(root, path);
        await mkdir(dirname(destination), { recursive: true });
        const temporary = `${destination}.pi-r-lock-tmp`;
        await writeFile(temporary, content, "utf8");
        await rename(temporary, destination);
      }
      for (const path of removedPaths) await rm(resolve(root, path), { force: true });
      await git(["add", "-A", "--", ...paths], root);
      const manifest = JSON.parse(files.get(".pi-r/manifest.json") ?? "{}") as { contractHash?: string };
      await git(
        [
          "commit",
          "-m",
          revision ? "Revise pi-r project contract" : "Lock pi-r project contract",
          "-m",
          `Contract-Hash: ${manifest.contractHash ?? "unknown"}\nTemplate-Version: ${contract.templateVersion}\nPolicy-Version: ${contract.policyVersion}`,
          "--",
          ...paths,
        ],
        root,
      );
    } catch (error) {
      await git(["reset", "--quiet", "HEAD", "--", ...paths], root, true);
      for (const [path, previous] of snapshots) {
        const destination = resolve(root, path);
        if (previous === undefined) await rm(destination, { force: true });
        else {
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, previous, "utf8");
        }
      }
      throw error;
    }
    const reset = worker
      ? await worker.reset("Project Contract locked; restarting in generated project environment")
      : { lostObjects: 0 };
    worker = undefined;
    projectRscript = runtime;
    updateLiveWorker([], reset.lostObjects > 0 || liveTransientStateLost, "contract-locked-worker-reset");
    const head = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
    return {
      ...state,
      phase: "implementation",
      head,
      contractState: "locked",
      editableScopeCount: contract.functions.length,
      behaviorBlockedCount: 0,
      pendingApproval: "none",
      allowedTools: phaseTools("implementation"),
    };
  }

  async function revise(context: CommandContext): Promise<void> {
    if (!state || state.phase !== "implementation") throw new Error("Contract revision requires active Implementation Mode");
    const mismatch = await verifyState(state, context);
    if (mismatch) throw new Error(mismatch);
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], state.projectRoot);
    if (dirty.stdout.trim()) throw new Error("tracked source changed before contract revision");
    await access(resolve(state.projectRoot, ".pi/tmp/pi-r-environment-candidate.json")).then(
      () => { throw new Error("Resolve or discard the pending Environment Candidate before contract revision"); },
      () => undefined,
    );
    if (state.pendingApproval !== "none") throw new Error(`Resolve pending approval '${state.pendingApproval}' before contract revision`);
    const contract = validateContract(JSON.parse(await readFile(resolve(state.projectRoot, "pi-r.yml"), "utf8")));
    const { contractVersion: _contractVersion, templateVersion: _templateVersion, policyVersion: _policyVersion, ...projectDecisions } = contract;
    const proposal = { ...projectDecisions, project: { name: contract.project.name } };
    const transientObjects = liveObjects.length;
    if (!context.ui.confirm) throw new Error("Contract revision requires an interactive confirmation UI");
    const approved = await context.ui.confirm(
      "Enter Contract Revision Mode?",
      `The committed contract remains unchanged. The R worker will stop and discard ${transientObjects} transient object(s).`,
    );
    if (!approved) {
      context.ui.notify("Contract revision cancelled", "info");
      return;
    }
    const draft = resolve(state.projectRoot, ".pi/tmp/pi-r-contract-draft.json");
    await mkdir(dirname(draft), { recursive: true });
    await writeFile(draft, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    worker?.stop(true);
    worker = undefined;
    projectRscript = undefined;
    updateLiveWorker([], transientObjects > 0 || liveTransientStateLost, "contract-revision-started");
    registerProposalTool();
    const next: WorkbenchState = {
      ...state,
      phase: "revision",
      contractState: "draft",
      editableScopeCount: 0,
      behaviorBlockedCount: unspecifiedBehaviorFunctions(contract).length,
      workerState: "stopped",
      allowedTools: phaseTools("revision"),
    };
    enterPhase(next);
    pi.appendEntry(STATE_ENTRY, next);
    showHud(context, next);
    context.ui.notify("Contract Revision Mode active; revise the seeded draft with r_contract_propose, then use /r lock or /r cancel-revision", "info");
  }

  async function cancelRevision(context: CommandContext): Promise<void> {
    if (!state || state.phase !== "revision") throw new Error("No Contract Revision is active");
    const mismatch = await verifyState(state, context);
    if (mismatch) throw new Error(mismatch);
    const contract = validateContract(JSON.parse(await readFile(resolve(state.projectRoot, "pi-r.yml"), "utf8")));
    const validated = await validateContractEnvironment(
      state.projectRoot,
      contract,
      (command, args, options) => pi.exec(command, args, options),
    );
    await preflightWorker(state.projectRoot, state.readOnlyRoots, "project", validated.runtime);
    await rm(resolve(state.projectRoot, ".pi/tmp/pi-r-contract-draft.json"), { force: true });
    projectRscript = validated.runtime;
    const next: WorkbenchState = {
      ...state,
      phase: "implementation",
      contractState: "locked",
      editableScopeCount: contract.functions.length - unspecifiedBehaviorFunctions(contract).length,
      behaviorBlockedCount: unspecifiedBehaviorFunctions(contract).length,
      workerState: "stopped",
      allowedTools: phaseTools("implementation"),
    };
    enterPhase(next);
    updateLiveWorker([], liveTransientStateLost, "contract-revision-cancelled");
    pi.appendEntry(STATE_ENTRY, next);
    showHud(context, next);
    context.ui.notify("Contract revision cancelled; unchanged locked contract restored", "info");
  }

  async function lock(context: CommandContext): Promise<void> {
    const startedAt = Date.now();
    showLockProgress(context, "checking session and Git state");
    if (!state || (state.phase !== "design" && state.phase !== "revision")) {
      throw new Error("Contract lock requires active Design or Contract Revision Mode");
    }
    const mismatch = await verifyState(state, context);
    if (mismatch) throw new Error(mismatch);
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], state.projectRoot);
    if (dirty.stdout.trim()) throw new Error("tracked source changed after workbench start");
    const draftPath = resolve(state.projectRoot, ".pi/tmp/pi-r-contract-draft.json");
    const draftText = await readFile(draftPath, "utf8").catch(() => {
      throw new Error("No valid contract draft exists; use r_contract_propose first");
    });
    showLockProgress(context, "validating Project Contract");
    const draftInput = JSON.parse(draftText) as Record<string, unknown>;
    let contract: ProjectContract;
    if ("contractVersion" in draftInput) {
      contract = validateLockableContract(draftInput);
    } else {
      const pinPath = process.env.PI_R_NIXPKGS_PIN_PATH;
      if (!pinPath) throw new Error("PI_R_NIXPKGS_PIN_PATH is required");
      const pin = JSON.parse(await readFile(pinPath, "utf8")) as NixpkgsPin;
      contract = validateLockableContract(normalizeContractProposal(draftInput, pin));
    }
    for (const dependency of contract.dependencies) {
      const decision = declaredPackagePolicy(dependency);
      if (decision.status === "prohibited") {
        throw new RecoverableError("PROHIBITED_PACKAGE", decision.rationale, {
          package: dependency,
          alternatives: decision.alternatives,
        });
      }
      if (decision.status === "unregistered" && !contract.dependencyApprovals[dependency]) {
        throw new RecoverableError("UNREGISTERED_PACKAGE", `Initial dependency requires an explicit governed approval: ${dependency}`);
      }
    }
    showLockProgress(context, "checking source-file authority");
    await validateSourceFileAuthority(contract, state.projectRoot, state.readOnlyRoots);
    showLockProgress(context, "rendering candidate scaffold");
    const files = new Map(renderScaffold(contract));
    const removedPaths: string[] = [];
    if (state.phase === "revision") {
      const previous = validateContract(JSON.parse(await readFile(resolve(state.projectRoot, "pi-r.yml"), "utf8")));
      for (const fn of contract.functions) {
        const prior = previous.functions.find((candidate) => candidate.name === fn.name);
        if (
          prior &&
          JSON.stringify(prior.parameters) === JSON.stringify(fn.parameters) &&
          prior.purpose === fn.purpose &&
          JSON.stringify(prior.requirements) === JSON.stringify(fn.requirements)
        ) {
          const path = `R/${fn.name}.R`;
          files.set(path, await readFile(resolve(state.projectRoot, path), "utf8"));
        }
      }
      for (const fn of previous.functions) {
        if (!contract.functions.some((candidate) => candidate.name === fn.name)) removedPaths.push(`R/${fn.name}.R`);
      }
    }
    const validatedEnvironment = await validateContractEnvironment(
      state.projectRoot,
      contract,
      (command, args, options) => pi.exec(command, args, options),
      (phase) => showLockProgress(context, phase),
    );
    showLockProgress(context, "checking sandboxed project worker");
    await preflightWorker(state.projectRoot, state.readOnlyRoots, "project", validatedEnvironment.runtime);
    showLockProgress(context, "preparing approval diff");
    const diff = await sourceDiff(state.projectRoot, files, removedPaths);
    state = { ...state, pendingApproval: "contract-lock" };
    showHud(context, state);
    const review = `${contractSummary(contract)}\n\nGenerated-source diff\n${diff || "(no generated changes)"}`;
    if (!context.ui.confirm) throw new Error("Contract lock requires an interactive confirmation UI");
    const approved = await context.ui.confirm("Lock Project Contract and generated scaffold?", review);
    if (!approved) {
      state = { ...state, pendingApproval: "none" };
      showHud(context, state);
      context.ui.notify(`Project Contract lock cancelled after ${((Date.now() - startedAt) / 1000).toFixed(1)}s; validated draft preserved`, "info");
      return;
    }
    const implementation = await writeScaffoldCommit(contract, files, validatedEnvironment.runtime, removedPaths);
    registerEditTool();
    registerTargetTools();
    registerArtifactTool();
    registerEnvironmentTool();
    registerScoutTool();
    enterPhase(implementation);
    updateLiveWorker([], liveTransientStateLost, "contract-locked");
    pi.appendEntry(STATE_ENTRY, implementation);
    showHud(context, implementation);
    context.ui.notify(`Project Contract locked in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${hud(implementation)}`, "info");
  }

  pi.on("session_start", async (_event, context) => {
    if (configuredLauncherTools?.length) pi.setActiveTools([...new Set(configuredLauncherTools)]);
    const restored = restoreState(context.sessionManager.getBranch());
    if (!restored) return;
    if (restored === "stale") {
      quarantine(context, `pi-r cannot resume: saved runtime state is incompatible with pi-r ${PI_R_RUNTIME_VERSION}; start a fresh Pi session`);
      return;
    }
    previousActiveTools ??= pi.getActiveTools();
    try {
      const mismatch = await verifyState(restored, context);
      if (mismatch) {
        quarantine(context, `pi-r cannot resume: ${mismatch}`);
        return;
      }
      registerWorkerTools();
      registerDataTool();
      if (restored.phase === "design" || restored.phase === "revision") registerProposalTool();
      if (restored.phase === "implementation") {
        registerEditTool();
        registerTargetTools();
        registerArtifactTool();
        registerEnvironmentTool();
        registerScoutTool();
      }
      updateLiveWorker([], false, "session-resumed");
      enterPhase({ ...restored, workerState: "stopped" });
      showHud(context, restored);
    } catch (error) {
      quarantine(context, `pi-r cannot resume: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  pi.on("message_end", async (event) => {
    if (!state || event.message?.role !== "assistant") return;
    if (event.message.stopReason === "length") previousCompletionTruncated = true;
    else if (event.message.stopReason === "stop") previousCompletionTruncated = false;
  });

  pi.on("session_shutdown", async (_event, context) => {
    worker?.stop();
    worker = undefined;
    updateLiveWorker([], false, "inactive");
    previousCompletionTruncated = false;
    if (previousActiveTools) pi.setActiveTools(previousActiveTools);
    context.ui.setWidget?.("pi-r-hud", undefined);
    context.ui.setStatus?.("pi-r", undefined);
    state = undefined;
    quarantineReason = undefined;
  });

  pi.on("tool_call", async (event, context) => {
    if (!state) return;
    if (event.toolName !== INSPECT_TOOL && event.toolName !== EDIT_TOOL) lastEditInspection = undefined;
    if (!state.allowedTools.includes(event.toolName)) {
      return { block: true, reason: `pi-r ${state.phase} mode blocks this tool` };
    }
    if (event.toolName === "r_contract_propose" && (state.phase === "design" || state.phase === "revision")) return undefined;
    if (event.toolName === BEHAVIOR_PROPOSAL_TOOL && state.phase === "revision") return undefined;
    if ((WORKER_TOOLS as readonly string[]).includes(event.toolName)) return undefined;
    if (event.toolName === DATA_TOOL) return undefined;
    if ((TARGET_TOOLS as readonly string[]).includes(event.toolName) && state.phase === "implementation") return undefined;
    if (event.toolName === ARTIFACT_TOOL && state.phase === "implementation") return undefined;
    if (event.toolName === ENVIRONMENT_TOOL && state.phase === "implementation") return undefined;
    if ((event.toolName === INSPECT_TOOL || event.toolName === EDIT_TOOL) && state.phase === "implementation") return undefined;
    if (!(READ_TOOLS as readonly string[]).includes(event.toolName)) {
      return { block: true, reason: `pi-r ${state.phase} mode permits only its compact tool set` };
    }
    const rawPath = typeof event.input?.path === "string" ? event.input.path.replace(/^@/, "") : context.cwd;
    const requested = isAbsolute(rawPath) ? rawPath : resolve(context.cwd, rawPath);
    const canonical = await realpath(requested).catch(() => undefined);
    const roots = [state.projectRoot, ...state.readOnlyRoots, ...await guidanceRoots];
    const permitted =
      canonical !== undefined &&
      roots.some((root) => canonical === root || (!relative(root, canonical).startsWith(`..${sep}`) && relative(root, canonical) !== ".." && !isAbsolute(relative(root, canonical))));
    if (!permitted) {
      const packagedGuidance = requested.startsWith("/nix/store/") && requested.includes("pi-r-resources") && !requested.startsWith(resourceRoot);
      return {
        block: true,
        reason: packagedGuidance
          ? `That packaged reference belongs to a different pi-r runtime. Do not search the project for it. Current trusted guidance roots: ${(await guidanceRoots).join(", ")}`
          : "pi-r read path is outside approved read-only roots",
      };
    }
    if (event.toolName === "read" && /\.(?:csv|tsv|tab)(?:\.(?:gz|bz2|xz))?$/i.test(canonical)) {
      return { block: true, reason: "pi-r blocks direct raw-data reads; use r_data_inspect for bounded structural evidence" };
    }
    if (state.phase === "implementation" && event.toolName === "grep") {
      const activeProjectRoot = state.projectRoot;
      const contract = validateContract(JSON.parse(await readFile(resolve(activeProjectRoot, "pi-r.yml"), "utf8")));
      const sourcePaths = await Promise.all(contract.targets.filter(isSourceFileTarget).map(async (target) => {
        const declared = contract.constants[target.source.constant];
        if (typeof declared !== "string" || !/\.(?:csv|tsv|tab)(?:\.(?:gz|bz2|xz))?$/i.test(declared)) return undefined;
        return realpath(isAbsolute(declared) ? declared : resolve(activeProjectRoot, declared)).catch(() => undefined);
      }));
      const traversesRawSource = sourcePaths.some((sourcePath) => {
        if (!sourcePath) return false;
        const fromRequested = relative(canonical, sourcePath);
        return fromRequested === "" || (!fromRequested.startsWith(`..${sep}`) && fromRequested !== ".." && !isAbsolute(fromRequested));
      });
      if (traversesRawSource) {
        return { block: true, reason: "pi-r blocks searches that traverse declared raw inputs; narrow the path to source/docs or use r_data_inspect" };
      }
    }
    return undefined;
  });

  pi.on("context", async (event) => {
    if (!state) return undefined;
    const messages = (Array.isArray(event.messages) ? event.messages : []).filter(
      (message: unknown) => {
        if (!message || typeof message !== "object") return true;
        const candidate = message as { role?: unknown; customType?: unknown };
        return candidate.role !== "custom" || candidate.customType !== LIVE_STATE_MESSAGE;
      },
    );
    const currentState = {
      role: "custom",
      customType: LIVE_STATE_MESSAGE,
      content: liveStateContent(),
      display: false,
      timestamp: Date.now(),
    };
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index] as { role?: unknown };
      if (candidate?.role === "user") {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) return { messages: [currentState, ...messages] };
    return { messages: [...messages.slice(0, userIndex), currentState, ...messages.slice(userIndex)] };
  });

  pi.on("before_agent_start", async (event) => {
    if (!state) {
      if (!quarantineReason) return undefined;
      return {
        systemPrompt: `${event.systemPrompt}\n\npi-r is resume-blocked: ${quarantineReason}. No tools are available. Do not emit remembered tool calls or tool-call markup. Ask the operator to run /r start in a fresh session.`,
      };
    }
    const roots = [state.projectRoot, ...state.readOnlyRoots].join(", ");
    const currentGuidance = (await guidanceRoots).join(", ");
    const proposal = state.phase !== "implementation"
      ? " In Design Mode use r_contract_propose for the complete draft. In Contract Revision Mode prefer r_function_behavior_propose when only existing function behavior is missing or changing; it preserves topology. Before proposing, identify all relevant missing-value, duplicate, coding, cohort, join, event, censoring, and output decisions, ask the user about unresolved ones, and record only user decisions or identified authoritative-source facts. /r lock rejects every unresolved function. Existing input files are Source File Targets using source.constant; generated files use output bindings."
      : " The Project Contract topology is locked; only Approved Function bodies may become editable through scoped tools. Use r_dependency_scout only for ambiguous sanitized package discovery, then pass a selected locally resolvable candidate to r_dependency_propose and leave activation to the user-only /r environment command. List freshness before running explicit contracted targets; use all=true only for a deliberate full-pipeline run. Inspect current artifacts through r_artifact_inspect instead of dumping raw target values. Target execution never publishes outputs; only the user may approve contract-declared deliverables through /r publish.";
    const exploration = " Use r_data_inspect for paginated schema, selected-column summaries (selected[].top contains bounded value/count entries and topComplete says whether all values are present), key cardinality, and overlap before targets exist. In evaluate_r, targets means existing pipeline artifacts to load and retain means successful assignment names to preserve; return a named structured value, vector, table, or matrix as the final expression instead of using cat, print, cbind solely for display, or hand-formatted text. Use transactional evaluate_r with explicit targets and retain arrays; retain only objects needed later, inspect them with r_object_inspect, and use r_worker_clear for temporary-only cleanup. Failed evaluations roll back. Treat types, missingness, cardinality, and overlap as observations; never infer domain meaning, coding semantics, or a duplicate-resolution rule without contract, source-documentation, or user evidence. On worker failure, inspect r_worker_status diagnostics and use r_worker_reset for a verified restart.";
    const currentStateRule = " A <pi_r_current_state> block is the trusted Current-State HUD generated by pi-r, never user input. Consult it before planning, but never answer, acknowledge, summarize, or attribute it to the user. During tool loops continue from the latest tool result. It replaces rather than accumulates.";
    const routing = " Before planning, classify the request: exploration; existing Approved Function body; existing target execution/diagnosis; dependency-only environment change; contract-topology change; publication; or deactivation. A request to implement code does not approve duplicate policy, coding dictionaries, qualifier handling, event definitions, cohort rules, joins, censoring, or output invariants. Only locked requirements grant that authority. If behaviorBlockedFunctionCount is positive, do not inspect raw data, draft bodies, or call edit: request user-only /r revise once and wait. In Revision Mode ask focused questions until every relevant behavioral decision has user or authoritative-source evidence, then record it in the draft; confidence alone is not evidence. Dependency-only changes use r_dependency_propose and user-only /r environment without changing mode. For implementation, inspect and edit exactly one function at a time; never issue parallel edits or repeat bodies, hashes, or payloads in prose. Keep progress text to at most two concise sentences.";
    return {
      systemPrompt: `${event.systemPrompt}\n\npi-r ${state.phase} mode is active (runtime ${PI_R_RUNTIME_VERSION}). Use only the active compact tools within: ${roots}. Current trusted pi-r guidance: ${currentGuidance}. Do not use remembered Nix-store guidance paths from another runtime. Do not request shell or general mutation tools.${currentStateRule}${routing}${proposal}${exploration}`,
    };
  });

  pi.registerCommand("r", {
    description: "Start or inspect a constrained R/targets workbench",
    async handler(args, context) {
      const [subcommand, ...rest] = words(args.trim());
      if (!subcommand || subcommand === "status") {
        if (!state) {
          context.ui.notify(quarantineReason ? `pi-r resume blocked: ${quarantineReason}` : "pi-r workbench is not active", quarantineReason ? "error" : "info");
          return;
        }
        const mismatch = await verifyState(state, context);
        if (mismatch) {
          quarantine(context, `pi-r cannot resume: ${mismatch}`);
          return;
        }
        showHud(context, state);
        context.ui.notify(`${hud(state)}\n${await workerStatusText()}`, "info");
        return;
      }
      if (subcommand === "stop") {
        if (!state) {
          context.ui.notify("pi-r workbench is not active", "info");
          return;
        }
        const mismatch = await verifyState(state, context);
        if (mismatch) {
          quarantine(context, `pi-r cannot deactivate safely: ${mismatch}`);
          return;
        }
        worker?.stop(true);
        worker = undefined;
        projectRscript = undefined;
        state = undefined;
        updateLiveWorker([], false, "inactive");
        previousCompletionTruncated = false;
        pi.appendEntry(STATE_ENTRY, { inactive: true });
        if (previousActiveTools) pi.setActiveTools(previousActiveTools);
        previousActiveTools = undefined;
        context.ui.setWidget?.("pi-r-hud", undefined);
        context.ui.setStatus?.("pi-r", undefined);
        context.ui.notify("pi-r workbench deactivated; launcher tools restored", "info");
        return;
      }
      if (subcommand === "publish") {
        const operation = publishQueue.then(() => publishDeliverables(context));
        publishQueue = operation.then(() => undefined, () => undefined);
        try {
          await operation;
        } catch (error) {
          if (state?.pendingApproval === "deliverable-publish") {
            state = { ...state, pendingApproval: "none" };
            showHud(context, state);
          }
          context.ui.notify(`pi-r publish failed: ${actionableToolError(error).message}`, "error");
        }
        return;
      }
      if (subcommand === "environment") {
        try {
          if (!state || state.phase !== "implementation") throw new Error("Environment approval requires active Implementation Mode");
          const storedCandidate = await readEnvironmentCandidate(state.projectRoot);
          const candidate = await prepareEnvironmentCandidate(
            state.projectRoot,
            storedCandidate.expectedHead,
            storedCandidate.proposal,
            (command, args, options) => pi.exec(command, args, options),
          );
          await preflightWorker(state.projectRoot, state.readOnlyRoots, "project", candidate.runtime);
          state = { ...state, pendingApproval: "environment-change" };
          showHud(context, state);
          const diff = await sourceDiff(state.projectRoot, new Map(Object.entries(candidate.files)));
          const review = [
            `${candidate.proposal.operation} ${candidate.proposal.package} (${candidate.proposal.scope})`,
            `Domain: ${candidate.proposal.domain}`,
            `Rationale: ${candidate.proposal.rationale}`,
            `Policy: ${candidate.policy.status} — ${candidate.policy.rationale}`,
            `Resolved: ${candidate.resolvedPackages.map((entry) => `${entry.name}@${entry.version ?? "unknown"}`).join(", ")}`,
            `Runtime: ${candidate.runtime}`,
            "",
            "Generated-source diff",
            diff || "(no generated changes)",
            "",
            "Approval will create one provenance commit, restart the R worker, discard Transient State, and preserve the targets cache.",
          ].join("\n");
          if (!context.ui.confirm) throw new Error("Environment activation requires an interactive confirmation UI");
          const approved = await context.ui.confirm("Activate governed R environment?", review);
          if (!approved) {
            state = { ...state, pendingApproval: "none" };
            showHud(context, state);
            context.ui.notify("Environment activation cancelled; validated candidate preserved", "info");
            return;
          }
          await activateEnvironmentCandidate(candidate, context);
        } catch (error) {
          if (state?.pendingApproval === "environment-change") {
            state = { ...state, pendingApproval: "none" };
            showHud(context, state);
          }
          context.ui.notify(`pi-r environment failed: ${actionableToolError(error).message}`, "error");
        }
        return;
      }
      if (subcommand === "revise") {
        try {
          await revise(context);
        } catch (error) {
          context.ui.notify(`pi-r revise failed: ${actionableToolError(error).message}`, "error");
        }
        return;
      }
      if (subcommand === "cancel-revision") {
        try {
          await cancelRevision(context);
        } catch (error) {
          context.ui.notify(`pi-r cancel-revision failed: ${actionableToolError(error).message}`, "error");
        }
        return;
      }
      if (subcommand === "lock") {
        try {
          await lock(context);
        } catch (error) {
          if (state?.pendingApproval === "contract-lock") state = { ...state, pendingApproval: "none" };
          if (state) showHud(context, state);
          else {
            context.ui.setWidget?.("pi-r-hud", undefined);
            context.ui.setStatus?.("pi-r", undefined);
          }
          context.ui.notify(`pi-r lock failed: ${actionableToolError(error).message}`, "error");
        }
        return;
      }
      if (subcommand !== "start") {
        context.ui.notify("Usage: /r start [read-only-root ...] | /r status | /r stop | /r revise | /r cancel-revision | /r lock | /r environment | /r publish", "warning");
        return;
      }
      try {
        await start(rest, context);
      } catch (error) {
        if (state) showHud(context, state);
        else {
          context.ui.setWidget?.("pi-r-hud", undefined);
          context.ui.setStatus?.("pi-r", undefined);
        }
        context.ui.notify(`pi-r start failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
