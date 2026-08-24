import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { RecoverableError } from "../r-edit/errors.js";

export type TargetFreshness = "missing" | "outdated" | "current" | "failed";

export interface TargetStatus {
  name: string;
  freshness: TargetFreshness;
  bytes: number | null;
  time: string | null;
  warning: string | null;
  error: string | null;
}

export interface TargetListResult {
  targets: TargetStatus[];
  logPath: string;
}

export interface TargetRunResult extends TargetListResult {
  status: "succeeded" | "failed";
  requested: string[];
  error: null | {
    code: "TARGET_RUN_FAILED";
    target: string;
    message: string;
    traceback: string;
    recoverable: true;
    recovery: string[];
  };
}

interface TargetRunnerOptions {
  projectRoot: string;
  readOnlyRoots: string[];
  rscript: string;
  runnerScript: string;
  bwrap?: string;
  timeoutMs?: number;
  writableFiles?: string[];
}

interface RunnerResponse {
  ok?: unknown;
  status?: unknown;
  requested?: unknown;
  targets?: unknown;
  error?: any;
}

const RESULT_PREFIX = "PI_R_RESULT:";
const MAX_RESULT_CAPTURE = 1024 * 1024;

function directoryArguments(path: string): string[] {
  const parts = dirname(resolve(path)).split(sep).filter(Boolean);
  const result: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `${sep}${part}`;
    if (current !== "/nix" && current !== "/nix/store" && current !== "/etc") result.push("--dir", current);
  }
  return result;
}

function parseTarget(value: unknown): TargetStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TargetStatus>;
  if (typeof candidate.name !== "string" || !["missing", "outdated", "current", "failed"].includes(candidate.freshness ?? "")) return undefined;
  return {
    name: candidate.name,
    freshness: candidate.freshness as TargetFreshness,
    bytes: typeof candidate.bytes === "number" ? candidate.bytes : null,
    time: typeof candidate.time === "string" ? candidate.time : null,
    warning: typeof candidate.warning === "string" ? candidate.warning : null,
    error: typeof candidate.error === "string" ? candidate.error : null,
  };
}

function parseTargets(value: unknown): TargetStatus[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseTarget).filter((target): target is TargetStatus => target !== undefined);
}

async function executeRunner(
  operation: "list" | "run",
  names: string[],
  options: TargetRunnerOptions,
  signal?: AbortSignal,
): Promise<{ response: RunnerResponse; logPath: string }> {
  if (!isAbsolute(options.rscript) || !isAbsolute(options.runnerScript)) {
    throw new RecoverableError("TARGET_RUNNER_START_FAILED", "Target runner runtime paths must be absolute");
  }
  const runtimeRoot = resolve(options.projectRoot, ".pi/tmp/pi-r-target-runs");
  const targetStore = resolve(options.projectRoot, "_targets");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(targetStore, { recursive: true });
  if (await realpath(targetStore) !== targetStore) {
    throw new RecoverableError("INVALID_TARGET_STORE", "The project target store must not be a symbolic link");
  }
  const writableFiles = options.writableFiles ?? [];
  for (const path of writableFiles) {
    if (!isAbsolute(path)) throw new RecoverableError("INVALID_OUTPUT_PATH", "Declared target output paths must be absolute");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "", { flag: "a" });
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${operation}`;
  const logPath = resolve(runtimeRoot, `${runId}.log`);
  const log = createWriteStream(logPath, { flags: "wx" });
  log.write(`pi-r target runner\noperation=${operation}\nrequested=${names.join(",")}\n`);

  const args = [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/nix/store", "/nix/store",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/etc", "/etc",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...directoryArguments(options.projectRoot),
    "--ro-bind", options.projectRoot, options.projectRoot,
  ];
  for (const root of options.readOnlyRoots) args.push(...directoryArguments(root), "--ro-bind", root, root);
  args.push("--bind", targetStore, targetStore);
  for (const path of writableFiles) args.push("--bind", path, path);
  args.push(
    "--setenv", "HOME", "/tmp/pi-r-target-home",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LC_ALL", "C",
    "--chdir", options.projectRoot,
    options.rscript, "--vanilla", options.runnerScript,
  );

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.bwrap ?? process.env.PI_R_BWRAP ?? "bwrap", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    });
    let stdout = "";
    let settled = false;
    const finishLog = () => new Promise<void>((resolveLog) => log.end(resolveLog));
    const fail = async (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.removeAllListeners();
      child.kill("SIGKILL");
      await finishLog();
      rejectPromise(error);
    };
    const timer = setTimeout(() => {
      void fail(new RecoverableError("TARGET_RUNNER_TIMEOUT", `Target ${operation} timed out`, { logPath }));
    }, options.timeoutMs ?? (operation === "run" ? 600_000 : 30_000));
    const abort = () => {
      void fail(new RecoverableError("TARGET_RUNNER_CANCELLED", `Target ${operation} was cancelled`, { logPath }));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      log.write(`[stdout] ${chunk}`);
      stdout = `${stdout}${chunk}`.slice(-MAX_RESULT_CAPTURE);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => log.write(`[stderr] ${chunk}`));
    child.once("error", (error) => { void fail(new RecoverableError("TARGET_RUNNER_START_FAILED", error.message, { logPath })); });
    child.once("close", async (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await finishLog();
      const marker = stdout.lastIndexOf(RESULT_PREFIX);
      if (marker < 0) {
        rejectPromise(new RecoverableError("TARGET_RUNNER_CRASH", `Target runner exited without a structured result (${exitSignal ?? code ?? "unknown"})`, { logPath }));
        return;
      }
      try {
        const response = JSON.parse(stdout.slice(marker + RESULT_PREFIX.length).split("\n", 1)[0]) as RunnerResponse;
        if (response.ok !== true) {
          throw new RecoverableError(response.error?.code ?? "TARGET_RUNNER_FAILED", response.error?.message ?? "Target runner failed", { logPath });
        }
        resolvePromise({ response, logPath });
      } catch (error) {
        rejectPromise(error instanceof RecoverableError
          ? error
          : new RecoverableError("INVALID_TARGET_RESULT", error instanceof Error ? error.message : String(error), { logPath }));
      }
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdin.end(`${JSON.stringify({ operation, names })}\n`);
  });
}

export async function listTargets(names: string[], options: TargetRunnerOptions, signal?: AbortSignal): Promise<TargetListResult> {
  const { response, logPath } = await executeRunner("list", names, options, signal);
  const targets = parseTargets(response.targets);
  if (targets.length !== names.length) throw new RecoverableError("INVALID_TARGET_RESULT", "Target runner returned an invalid target inventory", { logPath });
  return { targets, logPath };
}

export async function runTargets(names: string[], options: TargetRunnerOptions, signal?: AbortSignal): Promise<TargetRunResult> {
  const { response, logPath } = await executeRunner("run", names, options, signal);
  if (response.status !== "succeeded" && response.status !== "failed") {
    throw new RecoverableError("INVALID_TARGET_RESULT", "Target runner returned an invalid execution status", { logPath });
  }
  const error = response.status === "failed" && response.error && typeof response.error === "object"
    ? {
        code: "TARGET_RUN_FAILED" as const,
        target: typeof response.error.target === "string" ? response.error.target : names.at(-1) ?? "unknown",
        message: typeof response.error.message === "string" ? response.error.message : "Target execution failed",
        traceback: typeof response.error.traceback === "string" ? response.error.traceback : "",
        recoverable: true as const,
        recovery: Array.isArray(response.error.recovery) ? response.error.recovery.filter((item: unknown): item is string => typeof item === "string") : [],
      }
    : null;
  return { status: response.status, requested: names, targets: parseTargets(response.targets), error, logPath };
}
