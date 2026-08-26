import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { RecoverableError } from "../r-edit/errors.js";
import { sandboxRuntimePath } from "./sandbox.js";

export interface DataInspectionRequest {
  path: string;
  columns: string[];
  columnOffset: number;
  columnLimit: number;
  key?: string;
  comparePath?: string;
}

export interface DataInspection {
  path: string;
  bytes?: number;
  rows?: number;
  schema?: {
    total: number;
    offset: number;
    returned: number;
    nextOffset: number | null;
    items: Array<{ name: string; class: string[] }>;
  };
  selected?: unknown[];
  missingColumns?: string[];
  key?: unknown;
  overlap?: unknown;
  error?: { code: string; message: string; recoverable: true } | null;
}

interface DataInspectorOptions {
  projectRoot: string;
  readOnlyRoots: string[];
  rscript: string;
  inspectorScript: string;
  valueSummaryScript: string;
  bwrap?: string;
  sandboxPath?: string;
  timeoutMs?: number;
}

const PREFIX = "PI_R_RESULT:";
const MAX_RESPONSE = 256 * 1024;

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

export async function inspectData(
  request: DataInspectionRequest,
  options: DataInspectorOptions,
  signal?: AbortSignal,
): Promise<DataInspection> {
  const runtimePaths = [request.path, options.rscript, options.inspectorScript, options.valueSummaryScript];
  if (runtimePaths.some((path) => !isAbsolute(path)) || (request.comparePath && !isAbsolute(request.comparePath))) {
    throw new RecoverableError("DATA_INSPECTOR_START_FAILED", "Data inspector paths must be absolute");
  }
  const runtimePath = sandboxRuntimePath(options.sandboxPath);
  const args = [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
    "--ro-bind", "/nix/store", "/nix/store",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/etc", "/etc",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...directoryArguments(options.projectRoot),
    "--ro-bind", options.projectRoot, options.projectRoot,
  ];
  for (const root of options.readOnlyRoots) args.push(...directoryArguments(root), "--ro-bind", root, root);
  args.push(
    "--setenv", "HOME", "/tmp/pi-r-data-inspector-home",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LC_ALL", "C",
    "--setenv", "PATH", runtimePath,
    "--setenv", "PI_R_VALUE_SUMMARY_SCRIPT", options.valueSummaryScript,
    "--chdir", options.projectRoot,
    options.rscript, "--vanilla", options.inspectorScript,
  );

  return new Promise<DataInspection>((resolvePromise, rejectPromise) => {
    const child = spawn(options.bwrap ?? process.env.PI_R_BWRAP ?? "bwrap", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: runtimePath },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.removeAllListeners();
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    const timer = setTimeout(
      () => fail(new RecoverableError("DATA_INSPECTOR_TIMEOUT", "Raw data inspection timed out")),
      options.timeoutMs ?? 30_000,
    );
    const abort = () => fail(new RecoverableError("DATA_INSPECTOR_CANCELLED", "Raw data inspection was cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_RESPONSE) fail(new RecoverableError("DATA_INSPECTOR_OUTPUT_LIMIT", "Raw data inspection exceeded its output limit"));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2048); });
    child.once("error", (error) => fail(new RecoverableError("DATA_INSPECTOR_START_FAILED", error.message)));
    child.once("exit", (code, exitSignal) => {
      if (settled) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      settled = true;
      if (code !== 0) {
        rejectPromise(new RecoverableError("DATA_INSPECTOR_FAILED", `Raw data inspector exited (${exitSignal ?? code}): ${stderr.trim()}`));
        return;
      }
      const line = stdout.split("\n").find((candidate) => candidate.startsWith(PREFIX));
      if (!line) {
        rejectPromise(new RecoverableError("DATA_INSPECTOR_PROTOCOL_ERROR", "Raw data inspector returned no framed result", { stderrTail: stderr.trim() }));
        return;
      }
      try {
        resolvePromise(JSON.parse(line.slice(PREFIX.length)) as DataInspection);
      } catch {
        rejectPromise(new RecoverableError("DATA_INSPECTOR_PROTOCOL_ERROR", "Raw data inspector returned invalid JSON", { stderrTail: stderr.trim() }));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
