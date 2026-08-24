import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { RecoverableError } from "../r-edit/errors.js";
import type { ArtifactKind, TargetDefinition } from "../contract/types.js";

export type ArtifactFacet = "structure" | "summary";
export type ArtifactStatus = "current" | "missing" | "stale" | "failed";

export interface ArtifactEnvelope {
  identity: { target: string; metadataHash: string | null };
  kind: ArtifactKind;
  producer: { function: string; arguments: TargetDefinition["arguments"]; pattern: TargetDefinition["pattern"] | null };
  status: ArtifactStatus;
  facets: ArtifactFacet[];
  structure: any;
  summaries: any;
  warnings: Array<{ code: string; message: string; recoverable: true }>;
  error: null | { code: string; message: string; recoverable: true; recovery: string[] };
  cache: { hit: boolean; key: string };
}

interface InspectorOptions {
  projectRoot: string;
  readOnlyRoots: string[];
  rscript: string;
  inspectorScript: string;
  bwrap?: string;
  timeoutMs?: number;
}

const PREFIX = "PI_R_RESULT:";
const MAX_RESPONSE = 1024 * 1024;
const MAX_CACHE = 256 * 1024;

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

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseEnvelope(value: unknown, target: TargetDefinition, facets: ArtifactFacet[]): ArtifactEnvelope {
  if (!value || typeof value !== "object") throw new Error("Inspector returned a non-object envelope");
  const candidate = value as any;
  if (candidate.identity?.target !== target.name || !["current", "missing", "stale", "failed"].includes(candidate.status)) {
    throw new Error("Inspector returned an invalid artifact identity or status");
  }
  return {
    identity: {
      target: target.name,
      metadataHash: typeof candidate.identity.metadataHash === "string" ? candidate.identity.metadataHash : null,
    },
    kind: target.artifact,
    producer: { function: target.function, arguments: target.arguments, pattern: target.pattern ?? null },
    status: candidate.status,
    facets,
    structure: candidate.structure ?? null,
    summaries: candidate.summaries ?? null,
    warnings: Array.isArray(candidate.warnings)
      ? candidate.warnings.flatMap((warning: any) => typeof warning?.code === "string" && typeof warning?.message === "string"
          ? [{ code: warning.code, message: warning.message, recoverable: true as const }]
          : [])
      : [],
    error: candidate.error && typeof candidate.error === "object" && typeof candidate.error.code === "string"
      ? {
          code: candidate.error.code,
          message: typeof candidate.error.message === "string" ? candidate.error.message : "Artifact inspection failed",
          recoverable: true,
          recovery: strings(candidate.error.recovery),
        }
      : null,
    cache: { hit: candidate.cache?.hit === true, key: facets.slice().sort().join(",") },
  };
}

export async function inspectArtifact(
  target: TargetDefinition,
  facets: ArtifactFacet[],
  options: InspectorOptions,
  signal?: AbortSignal,
): Promise<ArtifactEnvelope> {
  if (!isAbsolute(options.rscript) || !isAbsolute(options.inspectorScript)) {
    throw new RecoverableError("ARTIFACT_INSPECTOR_START_FAILED", "Artifact inspector runtime paths must be absolute");
  }
  const cacheRoot = resolve(options.projectRoot, ".pi/tmp/pi-r-artifact-cache");
  await mkdir(cacheRoot, { recursive: true });
  const cachePath = resolve(cacheRoot, `${target.name}-${facets.slice().sort().join("-")}.json`);
  const cachedText = await readFile(cachePath, "utf8").catch(() => undefined);
  const cached = cachedText && Buffer.byteLength(cachedText) <= MAX_CACHE
    ? (() => { try { return JSON.parse(cachedText); } catch { return null; } })()
    : null;
  const request = {
    target: target.name,
    kind: target.artifact,
    producer: { function: target.function, arguments: target.arguments, pattern: target.pattern ?? null },
    facets,
    cached,
  };
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
  args.push(
    "--setenv", "HOME", "/tmp/pi-r-inspector-home",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LC_ALL", "C",
    "--chdir", options.projectRoot,
    options.rscript, "--vanilla", options.inspectorScript,
  );

  const raw = await new Promise<unknown>((resolvePromise, rejectPromise) => {
    const child = spawn(options.bwrap ?? process.env.PI_R_BWRAP ?? "bwrap", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
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
    const timer = setTimeout(() => fail(new RecoverableError("ARTIFACT_INSPECTOR_TIMEOUT", "Artifact inspection timed out")), options.timeoutMs ?? 30_000);
    const abort = () => fail(new RecoverableError("ARTIFACT_INSPECTOR_CANCELLED", "Artifact inspection was cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_RESPONSE) fail(new RecoverableError("INVALID_ARTIFACT_RESULT", "Artifact inspector returned an oversized result"));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8192); });
    child.once("error", (error) => fail(new RecoverableError("ARTIFACT_INSPECTOR_START_FAILED", error.message)));
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const marker = stdout.lastIndexOf(PREFIX);
      if (marker < 0) {
        rejectPromise(new RecoverableError("ARTIFACT_INSPECTOR_CRASH", `Artifact inspector exited without a structured result (${exitSignal ?? code ?? "unknown"}): ${stderr.trim()}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout.slice(marker + PREFIX.length).split("\n", 1)[0]));
      } catch (error) {
        rejectPromise(new RecoverableError("INVALID_ARTIFACT_RESULT", error instanceof Error ? error.message : String(error)));
      }
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });

  let envelope: ArtifactEnvelope;
  try {
    envelope = parseEnvelope(raw, target, facets);
  } catch (error) {
    throw new RecoverableError("INVALID_ARTIFACT_RESULT", error instanceof Error ? error.message : String(error));
  }
  if (envelope.status === "current" && !envelope.cache.hit && envelope.identity.metadataHash) {
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (Buffer.byteLength(serialized) <= MAX_CACHE) {
      try {
        await writeFile(temporary, serialized, "utf8");
        await rename(temporary, cachePath);
      } catch {
        await rm(temporary, { force: true });
      }
    }
  }
  return envelope;
}
