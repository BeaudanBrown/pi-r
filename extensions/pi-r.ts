import { access, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const STATE_ENTRY = "pi-r-workbench-state";
const WORKBENCH_BRANCH = "pi-r/workbench";
const READ_TOOLS = ["read", "grep", "find", "ls"] as const;

type NoticeLevel = "info" | "warning" | "error";
type Phase = "design";

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
  pendingApproval: "none";
  workerState: "stopped";
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
  registerTool?(definition: unknown): void;
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
    state.phase === "design" &&
    typeof state.projectRoot === "string" &&
    typeof state.workingDirectory === "string" &&
    state.branch === WORKBENCH_BRANCH &&
    typeof state.head === "string" &&
    /^[0-9a-f]{40,64}$/.test(state.head) &&
    (state.contractState === "missing" || state.contractState === "present") &&
    state.policyState === "pi-r-policy-v1" &&
    state.editableScopeCount === 0 &&
    state.pendingApproval === "none" &&
    state.workerState === "stopped" &&
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

/** The only model-context surface is activated after an explicit /r start. */
export default function piRExtension(pi: ExtensionAPI): void {
  let state: WorkbenchState | undefined;
  let previousActiveTools: string[] | undefined;

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

  function enterDesignMode(next: WorkbenchState): void {
    previousActiveTools ??= pi.getActiveTools();
    const constrained = { ...next, allowedTools: safeReadTools() };
    state = constrained;
    pi.setActiveTools(constrained.allowedTools);
  }

  function quarantine(context: CommandContext, message: string): void {
    previousActiveTools ??= pi.getActiveTools();
    state = undefined;
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
      allowedTools: safeReadTools(),
    };
    enterDesignMode(next);
    pi.appendEntry(STATE_ENTRY, next);
    showHud(context, next);
    context.ui.notify(`pi-r workbench started: ${hud(next)}`, "info");
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
      enterDesignMode(restored);
      showHud(context, restored);
    } catch (error) {
      quarantine(context, `pi-r cannot resume: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  pi.on("session_shutdown", async (_event, context) => {
    if (previousActiveTools) pi.setActiveTools(previousActiveTools);
    context.ui.setWidget?.("pi-r-hud", undefined);
    context.ui.setStatus?.("pi-r", undefined);
    state = undefined;
  });

  pi.on("tool_call", async (event, context) => {
    if (!state) return;
    if (!state.allowedTools.includes(event.toolName) || !(READ_TOOLS as readonly string[]).includes(event.toolName)) {
      return { block: true, reason: "pi-r design mode permits only gated read/search tools" };
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

  pi.on("before_agent_start", async (event) => {
    if (!state) return undefined;
    const roots = [state.projectRoot, ...state.readOnlyRoots].join(", ");
    return {
      systemPrompt: `${event.systemPrompt}\n\npi-r design mode is active. You are read-only. Use only read/search tools within: ${roots}. Do not request shell or mutation tools.`,
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
        context.ui.notify(hud(state), "info");
        return;
      }
      if (subcommand !== "start") {
        context.ui.notify("Usage: /r start [read-only-root ...] | /r status", "warning");
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
