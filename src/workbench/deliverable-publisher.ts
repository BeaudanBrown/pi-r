import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { validateDeliverablePath } from "../contract/deliverables.js";
import type { ProjectContract } from "../contract/types.js";
import { RecoverableError } from "../r-edit/errors.js";

const MAX_DELIVERABLE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 40_000;

export interface PublishExecResult { code: number; stdout: string; stderr: string }
export type PublishRunner = (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<PublishExecResult>;
export interface DeliverableFreshness { target: string; freshness: "missing" | "outdated" | "current" | "failed" }
export interface DeliverableChange {
  target: string;
  path: string;
  status: "added" | "modified";
  bytes: number;
  sha256: string;
  gitBlob: string;
}
export interface DeliverablePublication {
  head: string;
  changes: DeliverableChange[];
  preview: string;
  digest: string;
}

function message(result: PublishExecResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

async function git(runner: PublishRunner, root: string, args: string[], allowFailure = false): Promise<PublishExecResult> {
  const result = await runner("git", args, { cwd: root, timeout: 10_000 });
  if (!allowFailure && result.code !== 0) throw new RecoverableError("PUBLISH_GIT_FAILED", message(result));
  return result;
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function porcelainPaths(output: string): Array<{ status: string; path: string }> {
  const entries = nulPaths(output);
  const parsed: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      throw new RecoverableError("UNSUPPORTED_DELIVERABLE_CHANGE", "Renamed or copied deliverables must be published as explicit contract path changes");
    }
    parsed.push({ status, path });
  }
  return parsed;
}

function boundedPreview(value: string): string {
  return Buffer.byteLength(value) <= MAX_PREVIEW_BYTES
    ? value
    : `${Buffer.from(value).subarray(0, MAX_PREVIEW_BYTES).toString("utf8")}\n[deliverable preview truncated]`;
}

async function untrackedPreview(path: string, content: Buffer): Promise<string> {
  if (content.includes(0) || content.length > 8_192) return `binary/large new deliverable: ${path} (${content.length} bytes)`;
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    ...content.toString("utf8").split("\n").map((line) => `+${line}`),
  ].join("\n");
}

export async function prepareDeliverablePublication(
  rootInput: string,
  contract: ProjectContract,
  freshness: DeliverableFreshness[],
  runner: PublishRunner,
): Promise<DeliverablePublication> {
  const root = await realpath(rootInput);
  if (contract.deliverables.length === 0) {
    throw new RecoverableError("NO_DECLARED_DELIVERABLES", "The locked Project Contract declares no versioned deliverables");
  }
  const declared = new Map(contract.deliverables.map((deliverable) => [deliverable.path, deliverable]));
  for (const path of declared.keys()) {
    try { validateDeliverablePath(path); }
    catch (error) { throw new RecoverableError("INVALID_DELIVERABLE_PATH", error instanceof Error ? error.message : "Invalid deliverable path"); }
  }

  const head = (await git(runner, root, ["rev-parse", "HEAD"])).stdout.trim();
  const staged = await git(runner, root, ["diff", "--cached", "--name-only", "-z"]);
  if (staged.stdout) throw new RecoverableError("STAGED_CHANGES_PRESENT", "Publish requires an empty Git index");

  const trackedStatus = await git(runner, root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
  const unrelated = porcelainPaths(trackedStatus.stdout).filter((entry) => !declared.has(entry.path));
  if (unrelated.length) {
    throw new RecoverableError("UNRELATED_TRACKED_CHANGES", "Publish refuses unrelated tracked changes", { paths: unrelated.map((entry) => entry.path).sort() });
  }

  const paths = [...declared.keys()].sort();
  const statusResult = await git(runner, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
  const statuses = new Map(porcelainPaths(statusResult.stdout).map((entry) => [entry.path, entry.status]));
  if (statuses.size === 0) throw new RecoverableError("NO_DELIVERABLE_CHANGES", "No declared deliverables have changed");

  const freshnessByTarget = new Map(freshness.map((entry) => [entry.target, entry.freshness]));
  const changes: DeliverableChange[] = [];
  const previews: string[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const status = statuses.get(path);
    if (!status) continue;
    const declaration = declared.get(path)!;
    if (freshnessByTarget.get(declaration.target) !== "current") {
      throw new RecoverableError("STALE_DELIVERABLE", `Deliverable target '${declaration.target}' is not current`, {
        target: declaration.target,
        freshness: freshnessByTarget.get(declaration.target) ?? "missing",
      });
    }
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new RecoverableError("INVALID_DELIVERABLE_PATH", `Deliverable escapes the project: ${path}`);
    }
    const metadata = await lstat(absolute).catch(() => undefined);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new RecoverableError("INVALID_DELIVERABLE", `Changed deliverable must be a regular non-linked file: ${path}`);
    }
    const canonical = await realpath(absolute);
    if (canonical !== absolute) throw new RecoverableError("INVALID_DELIVERABLE_PATH", `Deliverable resolves through a symlink: ${path}`);
    if (metadata.size > MAX_DELIVERABLE_BYTES) {
      throw new RecoverableError("DELIVERABLE_TOO_LARGE", `Deliverable exceeds ${MAX_DELIVERABLE_BYTES} bytes: ${path}`);
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new RecoverableError("DELIVERABLE_SET_TOO_LARGE", "Declared deliverables exceed the publication size bound");
    const content = await readFile(absolute);
    const tracked = (await git(runner, root, ["ls-files", "--error-unmatch", "--", path], true)).code === 0;
    const gitBlob = (await git(runner, root, ["hash-object", "--path", path, "--", path])).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(gitBlob)) throw new RecoverableError("PUBLISH_GIT_FAILED", `Could not identify deliverable blob: ${path}`);
    changes.push({
      target: declaration.target,
      path,
      status: tracked ? "modified" : "added",
      bytes: metadata.size,
      sha256: createHash("sha256").update(content).digest("hex"),
      gitBlob,
    });
    if (tracked) {
      const diff = await git(runner, root, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", path]);
      previews.push(diff.stdout || `binary deliverable changed: ${path} (${metadata.size} bytes)`);
    } else {
      previews.push(await untrackedPreview(path, content));
    }
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash("sha256").update(JSON.stringify({ head, changes })).digest("hex");
  return { head, changes, preview: boundedPreview(previews.join("\n\n")), digest };
}
