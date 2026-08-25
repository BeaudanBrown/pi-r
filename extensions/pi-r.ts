import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import contractSchema from "../resources/project-contract.schema.json" with { type: "json" };
import { validateContract } from "../src/contract/contract.js";
import { renderScaffold } from "../src/contract/scaffold.js";
import type { ProjectContract } from "../src/contract/types.js";
import { RecoverableError } from "../src/r-edit/errors.js";
import { inspectApprovedFunction, prepareScopedMutation } from "../src/workbench/scoped-mutation.js";
import { SandboxedRWorker, type WorkerEnvironment, type WorkerObject, type WorkerState } from "../src/workbench/r-worker.js";
import { listTargets, runTargets } from "../src/workbench/target-runner.js";
import { inspectArtifact, type ArtifactFacet } from "../src/workbench/artifact-inspector.js";
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

const STATE_ENTRY = "pi-r-workbench-state";
const WORKBENCH_BRANCH = "pi-r/workbench";
const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
const WORKER_TOOLS = ["evaluate_r", "r_worker_status", "r_worker_reset"] as const;
const TARGET_TOOLS = ["r_targets_list", "r_targets_run", "r_target_workspace"] as const;
const ARTIFACT_TOOL = "r_artifact_inspect";
const ENVIRONMENT_TOOL = "r_dependency_propose";
const LIVE_STATE_MESSAGE = "pi-r-live-state";
const MAX_LIVE_STATE_BYTES = 4096;
const MAX_LIVE_OBJECTS = 50;
const EVALUATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["code", "targets"],
  properties: {
    code: { type: "string", minLength: 1, maxLength: 50_000 },
    targets: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", pattern: "^(?:[A-Za-z]|\\.(?!\\d))[A-Za-z0-9._]*$" } },
  },
} as const;
const EMPTY_SCHEMA = { type: "object", additionalProperties: false, properties: {} } as const;
const ARTIFACT_INSPECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["target", "facets"],
  properties: {
    target: { type: "string", pattern: "^(?:[A-Za-z]|\\.(?!\\d))[A-Za-z0-9._]*$" },
    facets: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["structure", "summary"] } },
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
  properties: { target: { type: "string", pattern: "^(?:[A-Za-z]|\\.(?!\\d))[A-Za-z0-9._]*$" } },
} as const;
const RUN_TARGETS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["names", "all"],
  properties: {
    names: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", pattern: "^(?:[A-Za-z]|\\.(?!\\d))[A-Za-z0-9._]*$" } },
    all: { type: "boolean" },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 1800 },
  },
} as const;
const INSPECT_TOOL = "r_function_inspect";
const EDIT_TOOL = "r_function_edit";
const INSPECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["function"],
  properties: { function: { type: "string", minLength: 1 } },
} as const;
const EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["function", "expectedSourceHash", "operation"],
  properties: {
    function: { type: "string", minLength: 1 },
    expectedSourceHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    operation: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "body"],
          properties: { kind: { const: "replace" }, body: { type: "string" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "oldText", "newText"],
          properties: {
            kind: { const: "patch" },
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
          },
        },
      ],
    },
  },
} as const;

type NoticeLevel = "info" | "warning" | "error";
type Phase = "design" | "implementation";

interface WorkbenchState {
  version: 1;
  phase: Phase;
  projectRoot: string;
  workingDirectory: string;
  branch: string;
  head: string;
  contractState: "missing" | "present";
  policyState: "pi-r-policy-v1";
  editableScopeCount: number;
  pendingApproval: "none" | "contract-lock" | "environment-change";
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
  exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResult>;
  getAllTools(): Array<{ name: string; sourceInfo?: { source?: string } }>;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
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
    state.version === 1 &&
    (state.phase === "design" || state.phase === "implementation") &&
    typeof state.projectRoot === "string" &&
    typeof state.workingDirectory === "string" &&
    state.branch === WORKBENCH_BRANCH &&
    typeof state.head === "string" &&
    /^[0-9a-f]{40,64}$/.test(state.head) &&
    (state.contractState === "missing" || state.contractState === "present") &&
    state.policyState === "pi-r-policy-v1" &&
    typeof state.editableScopeCount === "number" &&
    (state.pendingApproval === "none" || state.pendingApproval === "contract-lock" || state.pendingApproval === "environment-change") &&
    (state.workerState === "stopped" || state.workerState === "running" || state.workerState === "crashed") &&
    Array.isArray(state.readOnlyRoots) &&
    state.readOnlyRoots.every((root) => typeof root === "string" && isAbsolute(root)) &&
    Array.isArray(state.allowedTools)
  );
}

function restoreState(entries: unknown[]): WorkbenchState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type === "custom" && entry.customType === STATE_ENTRY && isWorkbenchState(entry.data)) {
      return entry.data;
    }
  }
  return undefined;
}

function shortHead(head: string): string {
  return head.slice(0, 12);
}

function hud(state: WorkbenchState): string {
  return [
    `phase=${state.phase}`,
    `branch=${state.branch}@${shortHead(state.head)}`,
    `contract=${state.contractState}`,
    `policy=${state.policyState}`,
    `scopes=${state.editableScopeCount}`,
    `approval=${state.pendingApproval}`,
    `worker=${state.workerState}`,
  ].join(" ");
}

function showHud(context: CommandContext, state: WorkbenchState): void {
  const line = hud(state);
  context.ui.setWidget?.("pi-r-hud", [line]);
  context.ui.setStatus?.("pi-r", `R:${state.phase} ${state.branch}@${shortHead(state.head)}`);
}

function resultMessage(result: ExecResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

function contractSummary(contract: ProjectContract): string {
  const functions = contract.functions.map((fn) => `- ${fn.name}(${fn.parameters.join(", ")})`).join("\n");
  const constants = Object.entries(contract.constants)
    .map(([name, value]) => `- ${name} = ${JSON.stringify(value)}`)
    .join("\n") || "- none";
  const dependencies = contract.dependencies.map((name) => `- ${name}`).join("\n") || "- none";
  const graph = contract.targets
    .map((target) => {
      const inputs = Object.values(target.arguments).map((argument) =>
        "target" in argument ? argument.target : `constant:${argument.constant}`,
      );
      const pattern = target.pattern ? ` ${target.pattern.kind}(${target.pattern.over.join(", ")})` : "";
      return `- ${target.name} <- [${inputs.join(", ")}] => ${target.function} (${target.artifact})${pattern}`;
    })
    .join("\n");
  return `Functions and signatures\n${functions}\n\nConstants\n${constants}\n\nDependencies\n${dependencies}\n\nTarget graph\n${graph}`;
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

async function sourceDiff(root: string, files: ReadonlyMap<string, string>): Promise<string> {
  const sections: string[] = [];
  for (const [path, generated] of files) {
    const current = await readFile(resolve(root, path), "utf8").catch(() => undefined);
    if (current === generated) continue;
    const removed = current === undefined ? [] : current.split("\n").map((line) => `-${line}`);
    const added = generated.split("\n").map((line) => `+${line}`);
    sections.push(`diff --pi-r ${path}\n--- current/${path}\n+++ generated/${path}\n${[...removed, ...added].join("\n")}`);
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
  let environmentRegistered = false;
  let worker: SandboxedRWorker | undefined;
  let projectRscript: string | undefined;
  let proposalQueue: Promise<void> = Promise.resolve();
  let editQueue: Promise<void> = Promise.resolve();
  let workerQueue: Promise<void> = Promise.resolve();
  let environmentQueue: Promise<void> = Promise.resolve();
  let liveObjects: WorkerObject[] = [];
  let liveTransientStateLost = false;
  let liveTransition = "inactive";

  function updateLiveWorker(objects: WorkerObject[], transientStateLost: boolean, transition?: string): void {
    const originOrder: Record<WorkerObject["origin"], number> = { temporary: 0, target: 1, global: 2 };
    liveObjects = [...objects].sort(
      (left, right) => originOrder[left.origin] - originOrder[right.origin] || left.name.localeCompare(right.name),
    );
    liveTransientStateLost = transientStateLost;
    if (transition) liveTransition = transition;
  }

  function environmentIdentity(): string {
    if (!state || state.phase === "design") return "design:bundled";
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
    }));
    const snapshot = {
      version: 1,
      phase: state.phase,
      branch: state.branch,
      head: shortHead(state.head),
      contract: state.contractState,
      policy: state.policyState,
      editableScopes: state.editableScopeCount,
      approval: state.pendingApproval,
      environment: { identity: environmentIdentity() },
      worker: {
        state: state.workerState,
        transientStateLost: liveTransientStateLost,
        targetsCache: "preserved",
      },
      transition: liveTransition,
      objectCount: allObjects.length,
      objectsTruncated: allObjects.length > MAX_LIVE_OBJECTS,
      objects: allObjects.slice(0, MAX_LIVE_OBJECTS),
    };
    let content = JSON.stringify(snapshot);
    while (Buffer.byteLength(content) > MAX_LIVE_STATE_BYTES && snapshot.objects.length) {
      snapshot.objects.pop();
      snapshot.objectsTruncated = true;
      content = JSON.stringify(snapshot);
    }
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

  function phaseTools(phase: Phase): string[] {
    const workerTools = workerRegistered ? [...WORKER_TOOLS] : [];
    if (phase === "design" && proposalRegistered) return [...safeReadTools(), "r_contract_propose", ...workerTools];
    const targetTools = targetRegistered ? [...TARGET_TOOLS] : [];
    const artifactTools = artifactRegistered ? [ARTIFACT_TOOL] : [];
    const environmentTools = environmentRegistered ? [ENVIRONMENT_TOOL] : [];
    if (phase === "implementation" && editRegistered) return [...safeReadTools(), INSPECT_TOOL, EDIT_TOOL, ...workerTools, ...targetTools, ...artifactTools, ...environmentTools];
    return safeReadTools();
  }

  function workerInstance(): SandboxedRWorker {
    if (!state) throw new RecoverableError("INVALID_PHASE", "R exploration requires an active Workbench Session");
    worker ??= new SandboxedRWorker({
      projectRoot: state.projectRoot,
      readOnlyRoots: state.readOnlyRoots,
      workerScript: process.env.PI_R_WORKER_SCRIPT ?? "",
      bwrap: process.env.PI_R_BWRAP,
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

  async function workerRuntime(environment: WorkerEnvironment): Promise<string> {
    if (!state) throw new RecoverableError("INVALID_PHASE", "R exploration requires an active Workbench Session");
    if (environment === "design") {
      const rscript = process.env.PI_R_WORKER_RSCRIPT ?? process.env.PI_R_RSCRIPT;
      if (!rscript) throw new RecoverableError("WORKER_START_FAILED", "Bundled design R runtime is unavailable");
      return rscript;
    }
    if (projectRscript) return projectRscript;
    const explicitProjectRuntime = process.env.PI_R_PROJECT_RSCRIPT;
    if (explicitProjectRuntime) {
      if (!isAbsolute(explicitProjectRuntime)) {
        throw new RecoverableError("WORKER_START_FAILED", "Generated project R runtime override must be absolute");
      }
      projectRscript = explicitProjectRuntime;
      return projectRscript;
    }
    const result = await pi.exec(
      "nix",
      ["--extra-experimental-features", "nix-command flakes", "develop", `path:${state.projectRoot}`, "--command", "which", "Rscript"],
      { cwd: state.projectRoot, timeout: 120_000 },
    );
    if (result.code !== 0 || !isAbsolute(result.stdout.trim())) {
      throw new RecoverableError("WORKER_START_FAILED", `Generated project R environment is unavailable: ${resultMessage(result)}`);
    }
    projectRscript = result.stdout.trim();
    return projectRscript;
  }

  function boundedJson(value: unknown): string {
    const text = JSON.stringify(value, null, 2);
    return text.length <= 8192 ? text : `${text.slice(0, 8192)}\n[structured result truncated]`;
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
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], state.projectRoot);
    if (dirty.stdout.trim()) throw new RecoverableError("STALE_CONTENT", "Tracked source changed outside scoped capabilities");
  }

  function registerWorkerTools(): void {
    if (workerRegistered) return;
    workerRegistered = true;
    pi.registerTool({
      name: "evaluate_r",
      label: "Evaluate temporary R code",
      description: "Evaluate bounded temporary R code in the persistent read-only Bubblewrap worker, loading only named targets.",
      promptSnippet: "Explore with temporary assignments; request every target explicitly by its canonical name",
      parameters: EVALUATE_SCHEMA,
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        const operation = workerQueue.then(async () => {
          await assertWorkerProvenance(context);
          const environment: WorkerEnvironment = state?.phase === "implementation" ? "project" : "design";
          const runtime = await workerRuntime(environment);
          const input = params as { code?: unknown; targets?: unknown };
          const result = await workerInstance().evaluate(
            { code: input.code as string, targets: input.targets as string[] },
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
          const { objects: _liveInventory, ...modelResult } = result;
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
      name: "r_worker_reset",
      label: "Reset temporary R state",
      description: "Stop the session worker and clearly report how many transient objects were lost.",
      parameters: EMPTY_SCHEMA,
      async execute(_toolCallId, _params, _signal, _onUpdate, context) {
        await assertWorkerProvenance(context);
        const reset = worker ? await worker.reset() : { lostObjects: 0, reason: "reset requested" };
        worker = undefined;
        updateLiveWorker([], reset.lostObjects > 0 || liveTransientStateLost, "worker-reset");
        if (state) {
          state = { ...state, workerState: "stopped" };
          showHud(context, state);
        }
        return {
          content: [{ type: "text", text: boundedJson({ ...reset, transientStateLost: reset.lostObjects > 0, targetsCache: "preserved" }) }],
          details: reset,
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
                function: declaration.function,
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
          const contractNames = contract.targets.map((target) => target.name);
          const names = input.all === true ? contractNames : requested;
          const unknown = names.filter((name) => !contractNames.includes(name));
          if (unknown.length) throw new RecoverableError("UNKNOWN_TARGET", `Targets are not declared in the locked contract: ${unknown.join(", ")}`, { targets: unknown });
          const writableFiles: string[] = [];
          for (const target of contract.targets.filter((candidate) => names.includes(candidate.name) && candidate.artifact === "file")) {
            for (const [parameter, reference] of Object.entries(target.arguments)) {
              if (!("constant" in reference) || !/(?:^|_)(?:output|file)?path$/i.test(parameter)) continue;
              const value = contract.constants[reference.constant];
              if (typeof value !== "string" || isAbsolute(value)) {
                throw new RecoverableError("INVALID_OUTPUT_PATH", `File target ${target.name} requires a relative declared output path`);
              }
              const requestedOutput = resolve(state.projectRoot, value);
              const output = await realpath(requestedOutput).catch(() => canonicalDestination(requestedOutput));
              const rel = relative(state.projectRoot, output);
              if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || [".git", ".pi", "_targets"].includes(rel.split(sep)[0])) {
                throw new RecoverableError("INVALID_OUTPUT_PATH", `File target ${target.name} output escapes permitted runtime paths`);
              }
              const tracked = await git(["ls-files", "--error-unmatch", "--", rel], state.projectRoot, true);
              if (tracked.code === 0) throw new RecoverableError("INVALID_OUTPUT_PATH", `File target ${target.name} cannot write tracked source: ${rel}`);
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
          return { content: [{ type: "text", text: boundedJson(result) }], details: result };
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

  function enterPhase(next: WorkbenchState): void {
    previousActiveTools ??= pi.getActiveTools();
    const constrained = { ...next, allowedTools: phaseTools(next.phase) };
    state = constrained;
    pi.setActiveTools(constrained.allowedTools);
  }

  function registerProposalTool(): void {
    if (proposalRegistered) return;
    proposalRegistered = true;
    pi.registerTool({
      name: "r_contract_propose",
      label: "Propose R project contract",
      description: "Validate and replace the single ignored pi-r Project Contract draft. Does not write project source.",
      promptSnippet: "Create or revise the schema-validated draft Project Contract during Design Mode",
      parameters: contractSchema,
      async execute(_toolCallId, params) {
        const operation = proposalQueue.then(async () => {
          if (!state || state.phase !== "design") throw new Error("Contract proposals require active Design Mode");
          let contract: ProjectContract;
          try {
            contract = validateContract(params);
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
          return {
            content: [{ type: "text", text: `Draft accepted.\n\n${contractSummary(contract)}` }],
            details: { draft, summary: contractSummary(contract) },
          };
        });
        proposalQueue = operation.then(() => undefined, () => undefined);
        return operation;
      },
    });
  }

  async function applyScopedEdit(params: unknown, context: CommandContext): Promise<unknown> {
    if (!state || state.phase !== "implementation") {
      throw new RecoverableError("INVALID_PHASE", "Approved Function edits require active Implementation Mode");
    }
    const mismatch = await verifyState(state, context);
    if (mismatch) throw new RecoverableError("PROVENANCE_MISMATCH", mismatch);
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], state.projectRoot);
    if (dirty.stdout.trim()) {
      throw new RecoverableError("STALE_CONTENT", "Tracked source changed outside the scoped edit capability");
    }
    const prepared = await prepareScopedMutation(state.projectRoot, params);
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
    return {
      content: [{ type: "text", text: `Formatted diff\n${diff}\n\nCommit: ${commitHash}` }],
      details: { commitHash, diff, function: prepared.function, path: prepared.path },
    };
  }

  function actionableToolError(error: unknown): Error {
    if (error instanceof RecoverableError) {
      const details = error.structured.details ? ` ${JSON.stringify(error.structured.details)}` : "";
      return new Error(`${error.structured.code}: ${error.message}${details}`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  function registerEditTool(): void {
    if (editRegistered) return;
    editRegistered = true;
    pi.registerTool({
      name: INSPECT_TOOL,
      label: "Inspect Approved R function",
      description: "Read one Approved Function with its signature and current source digest for a stale-safe scoped edit.",
      promptSnippet: "Inspect an Approved Function immediately before calling r_function_edit with the returned sourceHash",
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
          const input = params as { function?: unknown };
          return inspectApprovedFunction(state.projectRoot, input?.function);
        });
        editQueue = operation.then(() => undefined, () => undefined);
        try {
          const inspection = await operation;
          return {
            content: [{ type: "text", text: `${inspection.signature}\nSource-Hash: ${inspection.sourceHash}\n\n${inspection.source}` }],
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
      description: "Replace or exact-patch one contract-approved function body, validate it, and create one provenance commit.",
      promptSnippet: "Edit only Approved Function bodies using a current sha256 source digest; no path or general write authority is accepted",
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
    state = undefined;
    updateLiveWorker([], false, "inactive");
    pi.setActiveTools([]);
    context.ui.setWidget?.("pi-r-hud", undefined);
    context.ui.setStatus?.("pi-r", "R:resume blocked");
    context.ui.notify(message, "error");
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

  async function start(rootArguments: string[], context: CommandContext): Promise<void> {
    const workingDirectory = await realpath(context.cwd);
    const rootResult = await git(["rev-parse", "--show-toplevel"], workingDirectory);
    const projectRoot = await realpath(rootResult.stdout.trim());
    await git(["rev-parse", "--verify", "HEAD"], workingDirectory);

    const readOnlyRoots: string[] = [];
    for (const argument of rootArguments) {
      const requested = isAbsolute(argument) ? argument : resolve(workingDirectory, argument);
      readOnlyRoots.push(await approvedRoot(requested));
    }
    const uniqueRoots = [...new Set(readOnlyRoots)].sort();

    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
    if (dirty.stdout.trim()) {
      await git(
        ["stash", "push", "-m", "pi-r: tracked changes before workbench start"],
        workingDirectory,
      );
    }

    const branchExists = await git(
      ["show-ref", "--verify", "--quiet", `refs/heads/${WORKBENCH_BRANCH}`],
      workingDirectory,
      true,
    );
    const currentBranch = await git(["branch", "--show-current"], workingDirectory);
    if (currentBranch.stdout.trim() !== WORKBENCH_BRANCH) {
      if (branchExists.code === 0) await git(["switch", WORKBENCH_BRANCH], workingDirectory);
      else await git(["switch", "-c", WORKBENCH_BRANCH], workingDirectory);
    }

    const head = (await git(["rev-parse", "HEAD"], workingDirectory)).stdout.trim();
    const contractState = await access(resolve(projectRoot, "pi-r.yml")).then(
      () => "present" as const,
      () => "missing" as const,
    );
    worker?.stop(true);
    worker = undefined;
    projectRscript = undefined;
    updateLiveWorker([], false, "workbench-started");
    registerProposalTool();
    registerWorkerTools();
    const next: WorkbenchState = {
      version: 1,
      phase: "design",
      projectRoot,
      workingDirectory,
      branch: WORKBENCH_BRANCH,
      head,
      contractState,
      policyState: "pi-r-policy-v1",
      editableScopeCount: 0,
      pendingApproval: "none",
      workerState: "stopped",
      readOnlyRoots: uniqueRoots,
      allowedTools: phaseTools("design"),
    };
    enterPhase(next);
    pi.appendEntry(STATE_ENTRY, next);
    showHud(context, next);
    context.ui.notify(`pi-r workbench started: ${hud(next)}`, "info");
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
  ): Promise<WorkbenchState> {
    if (!state) throw new Error("Workbench state disappeared");
    const root = state.projectRoot;
    const paths = [...files.keys()];
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
      await git(["add", "--", ...paths], root);
      const manifest = JSON.parse(files.get(".pi-r/manifest.json") ?? "{}") as { contractHash?: string };
      await git(
        [
          "commit",
          "-m",
          "Lock pi-r project contract",
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
      contractState: "present",
      editableScopeCount: contract.functions.length,
      pendingApproval: "none",
      allowedTools: phaseTools("implementation"),
    };
  }

  async function lock(context: CommandContext): Promise<void> {
    if (!state || state.phase !== "design") throw new Error("Contract lock requires active Design Mode");
    const mismatch = await verifyState(state, context);
    if (mismatch) throw new Error(mismatch);
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], state.projectRoot);
    if (dirty.stdout.trim()) throw new Error("tracked source changed after workbench start");
    const draftPath = resolve(state.projectRoot, ".pi/tmp/pi-r-contract-draft.json");
    const draftText = await readFile(draftPath, "utf8").catch(() => {
      throw new Error("No valid contract draft exists; use r_contract_propose first");
    });
    const contract = validateContract(JSON.parse(draftText));
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
    const files = renderScaffold(contract);
    const validatedEnvironment = await validateContractEnvironment(
      state.projectRoot,
      contract,
      (command, args, options) => pi.exec(command, args, options),
    );
    const diff = await sourceDiff(state.projectRoot, files);
    state = { ...state, pendingApproval: "contract-lock" };
    showHud(context, state);
    const review = `${contractSummary(contract)}\n\nGenerated-source diff\n${diff || "(no generated changes)"}`;
    if (!context.ui.confirm) throw new Error("Contract lock requires an interactive confirmation UI");
    const approved = await context.ui.confirm("Lock Project Contract and generated scaffold?", review);
    if (!approved) {
      state = { ...state, pendingApproval: "none" };
      showHud(context, state);
      context.ui.notify("Project Contract lock cancelled; validated draft preserved", "info");
      return;
    }
    const implementation = await writeScaffoldCommit(contract, files, validatedEnvironment.runtime);
    registerEditTool();
    registerTargetTools();
    registerArtifactTool();
    registerEnvironmentTool();
    enterPhase(implementation);
    updateLiveWorker([], liveTransientStateLost, "contract-locked");
    pi.appendEntry(STATE_ENTRY, implementation);
    showHud(context, implementation);
    context.ui.notify(`Project Contract locked: ${hud(implementation)}`, "info");
  }

  pi.on("session_start", async (_event, context) => {
    const restored = restoreState(context.sessionManager.getBranch());
    if (!restored) return;
    try {
      const mismatch = await verifyState(restored, context);
      if (mismatch) {
        quarantine(context, `pi-r cannot resume: ${mismatch}`);
        return;
      }
      registerWorkerTools();
      if (restored.phase === "design") registerProposalTool();
      if (restored.phase === "implementation") {
        registerEditTool();
        registerTargetTools();
        registerArtifactTool();
        registerEnvironmentTool();
      }
      updateLiveWorker([], false, "session-resumed");
      enterPhase({ ...restored, workerState: "stopped" });
      showHud(context, restored);
    } catch (error) {
      quarantine(context, `pi-r cannot resume: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  pi.on("session_shutdown", async (_event, context) => {
    worker?.stop();
    worker = undefined;
    updateLiveWorker([], false, "inactive");
    if (previousActiveTools) pi.setActiveTools(previousActiveTools);
    context.ui.setWidget?.("pi-r-hud", undefined);
    context.ui.setStatus?.("pi-r", undefined);
    state = undefined;
  });

  pi.on("tool_call", async (event, context) => {
    if (!state) return;
    if (!state.allowedTools.includes(event.toolName)) {
      return { block: true, reason: `pi-r ${state.phase} mode blocks this tool` };
    }
    if (event.toolName === "r_contract_propose" && state.phase === "design") return undefined;
    if ((WORKER_TOOLS as readonly string[]).includes(event.toolName)) return undefined;
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
    const roots = [state.projectRoot, ...state.readOnlyRoots];
    const permitted =
      canonical !== undefined &&
      roots.some((root) => canonical === root || (!relative(root, canonical).startsWith(`..${sep}`) && relative(root, canonical) !== ".." && !isAbsolute(relative(root, canonical))));
    if (!permitted) return { block: true, reason: "pi-r read path is outside approved read-only roots" };
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
    return {
      messages: [
        ...messages,
        {
          role: "custom",
          customType: LIVE_STATE_MESSAGE,
          content: liveStateContent(),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("before_agent_start", async (event) => {
    if (!state) return undefined;
    const roots = [state.projectRoot, ...state.readOnlyRoots].join(", ");
    const proposal = state.phase === "design"
      ? " Use r_contract_propose to create or revise the single Project Contract draft."
      : " The Project Contract is locked; only Approved Function bodies may become editable through scoped tools. Propose package changes through r_dependency_propose and leave activation to the user-only /r environment command. List freshness before running explicit contracted targets; use all=true only for a deliberate full-pipeline run. Inspect current artifacts through r_artifact_inspect instead of dumping raw target values.";
    const exploration = " Use evaluate_r for bounded temporary exploration; target objects must be requested explicitly by canonical name.";
    return {
      systemPrompt: `${event.systemPrompt}\n\npi-r ${state.phase} mode is active. Use only the active compact tools within: ${roots}. Do not request shell or general mutation tools.${proposal}${exploration}`,
    };
  });

  pi.registerCommand("r", {
    description: "Start or inspect a constrained R/targets workbench",
    async handler(args, context) {
      const [subcommand, ...rest] = words(args.trim());
      if (!subcommand || subcommand === "status") {
        if (!state) {
          context.ui.notify("pi-r workbench is not active", "info");
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
      if (subcommand === "lock") {
        try {
          await lock(context);
        } catch (error) {
          if (state?.pendingApproval === "contract-lock") {
            state = { ...state, pendingApproval: "none" };
            showHud(context, state);
          }
          context.ui.notify(`pi-r lock failed: ${actionableToolError(error).message}`, "error");
        }
        return;
      }
      if (subcommand !== "start") {
        context.ui.notify("Usage: /r start [read-only-root ...] | /r status | /r lock | /r environment", "warning");
        return;
      }
      try {
        await start(rest, context);
      } catch (error) {
        context.ui.notify(`pi-r start failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
