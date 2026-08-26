import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { RecoverableError } from "../r-edit/errors.js";
import { sandboxRuntimePath } from "./sandbox.js";

export type WorkerEnvironment = "design" | "project";
export type WorkerState = "stopped" | "running" | "crashed";

export interface WorkerObject {
  name: string;
  bytes: number;
  class: string[];
  origin: "temporary" | "target" | "global";
  createdByCall?: number;
  lastModifiedByCall?: number;
}

export interface EvaluateRRequest {
  code: string;
  targets: string[];
  retain: string[];
}

export interface EvaluateRResult {
  value: unknown;
  result: unknown;
  stateDelta: { committed: string[]; discarded: string[]; rolledBack: boolean };
  preview: string;
  previewTruncated: boolean;
  warnings: string[];
  messages: string[];
  error: null | { code: string; message: string; recoverable: true; recovery: string[] };
  objects: WorkerObject[];
  worker: { environment: WorkerEnvironment; started: boolean; transientStateLost: boolean };
}

interface WorkerResponse {
  id?: unknown;
  value?: unknown;
  preview?: unknown;
  previewTruncated?: unknown;
  result?: unknown;
  stateDelta?: unknown;
  removed?: unknown;
  name?: unknown;
  summary?: unknown;
  warnings?: unknown;
  messages?: unknown;
  error?: unknown;
  objects?: unknown;
  target?: unknown;
  loaded?: unknown;
}

interface PendingRequest {
  resolve(value: WorkerResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface SandboxedRWorkerOptions {
  projectRoot: string;
  readOnlyRoots: string[];
  workerScript: string;
  bwrap?: string;
  sandboxPath?: string;
  requestTimeoutMs?: number;
  logDirectory?: string;
  onState?(state: WorkerState): void;
}

const MAX_PROTOCOL_LINE = 1024 * 1024;
const RESPONSE_PREFIX = "PI_R_RESPONSE:";
const MAX_DIAGNOSTIC_TAIL = 2048;

export interface WorkerCrashDiagnostics {
  code: string;
  message: string;
  environment?: WorkerEnvironment;
  logPath?: string;
  stderrTail: string;
  unexpectedStdoutTail: string;
}

function directoryArguments(path: string): string[] {
  const absolute = resolve(path);
  const parts = dirname(absolute).split(sep).filter(Boolean);
  const result: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `${sep}${part}`;
    if (current !== "/nix" && current !== "/nix/store" && current !== "/etc") result.push("--dir", current);
  }
  return result;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value.replace(/[\r\n]+$/, "")];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.replace(/[\r\n]+$/, ""))
    : [];
}

function objects(value: unknown): WorkerObject[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<WorkerObject>;
    if (typeof candidate.name !== "string" || typeof candidate.bytes !== "number" || !Number.isFinite(candidate.bytes)) return [];
    return [{
      name: candidate.name.slice(0, 200),
      bytes: Math.max(0, Math.trunc(candidate.bytes)),
      class: stringArray(candidate.class).slice(0, 8).map((name) => name.slice(0, 200)),
      origin: candidate.origin === "temporary" ? "temporary" : candidate.origin === "target" ? "target" : "global",
      ...(typeof candidate.createdByCall === "number" && Number.isInteger(candidate.createdByCall) ? { createdByCall: candidate.createdByCall } : {}),
      ...(typeof candidate.lastModifiedByCall === "number" && Number.isInteger(candidate.lastModifiedByCall) ? { lastModifiedByCall: candidate.lastModifiedByCall } : {}),
    }];
  });
}

export class SandboxedRWorker {
  readonly #options: SandboxedRWorkerOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #environment: WorkerEnvironment | undefined;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #state: WorkerState = "stopped";
  #transientStateLost = false;
  #stderrTail = "";
  #unexpectedStdoutTail = "";
  #logPath: string | undefined;
  #log: WriteStream | undefined;
  #lastCrash: WorkerCrashDiagnostics | undefined;

  constructor(options: SandboxedRWorkerOptions) {
    this.#options = options;
  }

  get state(): WorkerState {
    return this.#state;
  }

  get environment(): WorkerEnvironment | undefined {
    return this.#environment;
  }

  async evaluate(
    request: EvaluateRRequest,
    environment: WorkerEnvironment,
    rscript: string,
    signal?: AbortSignal,
  ): Promise<EvaluateRResult> {
    if (
      typeof request.code !== "string" ||
      !Array.isArray(request.targets) || request.targets.some((name) => typeof name !== "string") ||
      !Array.isArray(request.retain) || request.retain.some((name) => typeof name !== "string")
    ) {
      throw new RecoverableError("INVALID_REQUEST", "evaluate_r requires code plus arrays of canonical target and retained-object names");
    }
    const started = await this.#ensureStarted(environment, rscript);
    const transientStateLost = this.#transientStateLost;
    this.#transientStateLost = false;
    const response = await this.#request({ operation: "evaluate", code: request.code, targets: request.targets, retain: request.retain }, signal);
    const result = response.result ?? null;
    const stateDelta = response.stateDelta && typeof response.stateDelta === "object"
      ? response.stateDelta as EvaluateRResult["stateDelta"]
      : { committed: [], discarded: [], rolledBack: response.error != null };
    return {
      value: response.value ?? null,
      result,
      stateDelta,
      preview: JSON.stringify(result),
      previewTruncated: false,
      warnings: stringArray(response.warnings),
      messages: stringArray(response.messages),
      error: response.error && typeof response.error === "object" ? response.error as EvaluateRResult["error"] : null,
      objects: objects(response.objects),
      worker: { environment, started, transientStateLost },
    };
  }

  async loadWorkspace(
    target: string,
    rscript: string,
    signal?: AbortSignal,
  ): Promise<{ target: string; loaded: string[]; objects: WorkerObject[]; worker: { started: boolean; transientStateLost: boolean } }> {
    const started = await this.#ensureStarted("project", rscript);
    const transientStateLost = this.#transientStateLost;
    this.#transientStateLost = false;
    const response = await this.#request({ operation: "workspace", target }, signal);
    if (response.error && typeof response.error === "object") {
      const error = response.error as { code?: unknown; message?: unknown };
      throw new RecoverableError(
        typeof error.code === "string" ? error.code : "TARGET_WORKSPACE_LOAD_FAILED",
        typeof error.message === "string" ? error.message : "Failed target workspace could not be loaded",
      );
    }
    return {
      target: typeof response.target === "string" ? response.target : target,
      loaded: stringArray(response.loaded),
      objects: objects(response.objects),
      worker: { started, transientStateLost },
    };
  }

  async inspectObject(
    request: { name: string; columns: string[]; columnOffset: number; columnLimit: number },
  ): Promise<{ name: string; summary: unknown; error: unknown; objects: WorkerObject[] }> {
    if (!this.#child || this.#state !== "running") {
      throw new RecoverableError("WORKER_STOPPED", "No running worker contains objects to inspect");
    }
    const response = await this.#request({ operation: "inspect", ...request });
    return {
      name: typeof response.name === "string" ? response.name : request.name,
      summary: response.result ?? response.summary ?? null,
      error: response.error ?? null,
      objects: objects(response.objects),
    };
  }

  async clearTemporary(): Promise<{ removed: string[]; objects: WorkerObject[] }> {
    if (!this.#child || this.#state !== "running") return { removed: [], objects: [] };
    const response = await this.#request({ operation: "clear_temporary" });
    return { removed: stringArray(response.removed), objects: objects(response.objects) };
  }

  async invalidateTargets(): Promise<WorkerObject[]> {
    if (!this.#child || this.#state !== "running") return [];
    const response = await this.#request({ operation: "invalidate_targets" });
    return objects(response.objects);
  }

  async status(): Promise<{ state: WorkerState; environment?: WorkerEnvironment; objects: WorkerObject[]; transientStateLost: boolean; lastCrash?: WorkerCrashDiagnostics; logPath?: string }> {
    if (!this.#child || this.#state !== "running") {
      return {
        state: this.#state,
        environment: this.#environment,
        objects: [],
        transientStateLost: this.#transientStateLost,
        ...(this.#lastCrash ? { lastCrash: this.#lastCrash } : {}),
        ...(this.#logPath ? { logPath: this.#logPath } : {}),
      };
    }
    const response = await this.#request({ operation: "status" });
    return {
      state: this.#state,
      environment: this.#environment,
      objects: objects(response.objects),
      transientStateLost: this.#transientStateLost,
      ...(this.#logPath ? { logPath: this.#logPath } : {}),
    };
  }

  async healthCheck(environment: WorkerEnvironment, rscript: string): Promise<{ healthy: true; logPath?: string }> {
    await this.#ensureStarted(environment, rscript);
    await this.#request({ operation: "status" });
    this.#lastCrash = undefined;
    return { healthy: true, ...(this.#logPath ? { logPath: this.#logPath } : {}) };
  }

  async reset(reason = "reset requested"): Promise<{ lostObjects: number; reason: string }> {
    const status = await this.status().catch(() => ({ objects: [] as WorkerObject[] }));
    const lostObjects = status.objects.filter((object) => object.origin !== "global").length;
    this.stop(false);
    this.#transientStateLost = lostObjects > 0;
    return { lostObjects, reason };
  }

  stop(markLost = false): void {
    if (this.#child) {
      this.#child.removeAllListeners();
      this.#child.kill("SIGKILL");
    }
    this.#child = undefined;
    this.#environment = undefined;
    this.#buffer = "";
    this.#log?.end();
    this.#log = undefined;
    if (markLost) this.#transientStateLost = true;
    this.#setState("stopped");
    this.#rejectPending(new RecoverableError("WORKER_STOPPED", "R worker stopped and transient state was lost"));
  }

  async #ensureStarted(environment: WorkerEnvironment, rscript: string): Promise<boolean> {
    if (this.#child && this.#state === "running" && this.#environment === environment) return false;
    if (this.#child) this.stop(true);
    if (!isAbsolute(rscript) || !isAbsolute(this.#options.workerScript)) {
      throw new RecoverableError("WORKER_START_FAILED", "R worker runtime paths must be absolute");
    }
    const logDirectory = this.#options.logDirectory ?? resolve(this.#options.projectRoot, ".pi/tmp/pi-r-worker");
    await mkdir(logDirectory, { recursive: true });
    this.#log?.end();
    this.#stderrTail = "";
    this.#unexpectedStdoutTail = "";
    this.#logPath = resolve(logDirectory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.log`);
    this.#log = createWriteStream(this.#logPath, { flags: "wx", mode: 0o600 });
    this.#log.write(`pi-r worker\nenvironment=${environment}\nruntime=${rscript}\n`);
    const runtimePath = sandboxRuntimePath(this.#options.sandboxPath);
    const args = [
      "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--ro-bind", "/nix/store", "/nix/store",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/etc", "/etc",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      ...directoryArguments(this.#options.projectRoot),
      "--ro-bind", this.#options.projectRoot, this.#options.projectRoot,
    ];
    for (const root of this.#options.readOnlyRoots) {
      args.push(...directoryArguments(root), "--ro-bind", root, root);
    }
    if (process.env.PI_R_REAL_WORKER_SCRIPT) {
      args.push("--setenv", "PI_R_REAL_WORKER_SCRIPT", process.env.PI_R_REAL_WORKER_SCRIPT);
    }
    const valueSummaryScript = process.env.PI_R_VALUE_SUMMARY_SCRIPT;
    if (!valueSummaryScript || !isAbsolute(valueSummaryScript)) {
      throw new RecoverableError("WORKER_START_FAILED", "Packaged value-summary runtime is unavailable");
    }
    args.push("--setenv", "PI_R_VALUE_SUMMARY_SCRIPT", valueSummaryScript);
    args.push(
      "--setenv", "HOME", "/tmp/pi-r-home",
      "--setenv", "TMPDIR", "/tmp",
      "--setenv", "LC_ALL", "C",
      "--setenv", "PATH", runtimePath,
      "--setenv", "PI_R_WORKER_ENVIRONMENT", environment,
      "--chdir", this.#options.projectRoot,
      rscript, "--vanilla", this.#options.workerScript,
    );
    const child = spawn(this.#options.bwrap ?? process.env.PI_R_BWRAP ?? "bwrap", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: runtimePath },
    });
    this.#child = child;
    this.#environment = environment;
    this.#buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#receive(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-MAX_DIAGNOSTIC_TAIL);
      this.#log?.write(`stderr: ${chunk}`);
    });
    child.once("error", (error) => this.#crash(`R worker failed to start: ${error.message}`, "WORKER_START_FAILED"));
    child.once("exit", (code, signal) => this.#crash(`R worker exited (${signal ?? code ?? "unknown"})`, "WORKER_EXITED"));
    this.#setState("running");
    return true;
  }

  #request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerResponse> {
    const child = this.#child;
    if (!child || this.#state !== "running") {
      return Promise.reject(new RecoverableError("WORKER_CRASH", "R worker is not running; transient state was lost"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#crash("R worker request timed out");
        reject(new RecoverableError("WORKER_TIMEOUT", "R worker request timed out; transient state was lost"));
      }, this.#options.requestTimeoutMs ?? 30_000);
      const abort = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        this.stop(true);
        reject(new RecoverableError("WORKER_CANCELLED", "R evaluation was cancelled; transient state was lost"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        timer,
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_PROTOCOL_LINE) {
      this.#crash("R worker emitted an oversized protocol response");
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.startsWith(RESPONSE_PREFIX)) {
        this.#unexpectedStdoutTail = `${this.#unexpectedStdoutTail}${line}\n`.slice(-MAX_DIAGNOSTIC_TAIL);
        this.#log?.write(`unexpected-stdout: ${line}\n`);
        newline = this.#buffer.indexOf("\n");
        continue;
      }
      let response: WorkerResponse;
      try {
        response = JSON.parse(line.slice(RESPONSE_PREFIX.length)) as WorkerResponse;
      } catch {
        this.#crash("R worker emitted an invalid framed response", "WORKER_PROTOCOL_ERROR");
        return;
      }
      const id = typeof response.id === "number" ? response.id : undefined;
      const pending = id === undefined ? undefined : this.#pending.get(id);
      if (pending && id !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.resolve(response);
      }
      newline = this.#buffer.indexOf("\n");
    }
  }

  #crash(message: string, code = "WORKER_CRASH"): void {
    if (this.#state === "crashed") return;
    const child = this.#child;
    if (child) {
      child.removeAllListeners();
      child.kill("SIGKILL");
    }
    this.#child = undefined;
    this.#transientStateLost = true;
    this.#setState("crashed");
    const explanation = message ? `${message}; transient state was lost` : "R worker crashed; transient state was lost";
    this.#lastCrash = {
      code,
      message: explanation,
      environment: this.#environment,
      logPath: this.#logPath,
      stderrTail: this.#stderrTail.trim(),
      unexpectedStdoutTail: this.#unexpectedStdoutTail.trim(),
    };
    this.#log?.write(`crash: ${code}: ${explanation}\n`);
    this.#log?.end();
    this.#log = undefined;
    this.#rejectPending(new RecoverableError(code, explanation, this.#lastCrash as unknown as Record<string, unknown>));
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #setState(state: WorkerState): void {
    this.#state = state;
    this.#options.onState?.(state);
  }
}
