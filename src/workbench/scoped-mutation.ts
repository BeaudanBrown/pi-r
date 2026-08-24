import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { validateContract } from "../contract/contract.js";
import { RecoverableError } from "../r-edit/errors.js";
import { createEditCandidate } from "../r-edit/scoped-edit.js";
import { withTemporaryRFile } from "../r-edit/tooling.js";
import type { EditOperation } from "../r-edit/types.js";

const execFileAsync = promisify(execFile);
const CAPABILITY_VERSION = "r-function-body-edit-v1";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface ScopedMutationRequest {
  function: string;
  expectedSourceHash: string;
  operation: EditOperation;
}

export interface ApprovedFunctionInspection {
  contractHash: string;
  contractVersion: number;
  function: string;
  path: string;
  policyVersion: string;
  signature: string;
  source: string;
  sourceHash: string;
}

export interface PreparedScopedMutation {
  capabilityVersion: typeof CAPABILITY_VERSION;
  candidate: string;
  contractHash: string;
  contractVersion: number;
  diff: string;
  function: string;
  original: string;
  path: string;
  policyVersion: string;
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function validateRequest(input: unknown): ScopedMutationRequest {
  if (!input || typeof input !== "object") {
    throw new RecoverableError("INVALID_REQUEST", "Scoped edit request must be an object");
  }
  const request = input as Partial<ScopedMutationRequest>;
  if (typeof request.function !== "string" || !request.function) {
    throw new RecoverableError("INVALID_REQUEST", "Scoped edit request requires an Approved Function name");
  }
  if (typeof request.expectedSourceHash !== "string" || !HASH_PATTERN.test(request.expectedSourceHash)) {
    throw new RecoverableError("INVALID_REQUEST", "expectedSourceHash must be a sha256 digest of the current function file");
  }
  const operation = request.operation;
  if (
    !operation ||
    typeof operation !== "object" ||
    !(
      (operation.kind === "replace" && typeof operation.body === "string") ||
      (operation.kind === "patch" && typeof operation.oldText === "string" && operation.oldText.length > 0 && typeof operation.newText === "string")
    )
  ) {
    throw new RecoverableError("INVALID_REQUEST", "operation must be a body replacement or non-empty exact patch");
  }
  return { function: request.function, expectedSourceHash: request.expectedSourceHash, operation };
}

const POLICY_SCRIPT = String.raw`
forbidden <- c(
  "library", "require", "requireNamespace", "install.packages", "install.packages.check",
  "install_github", "install_git", "install_url", "install_version", "pkg_install", "pak",
  "source", "sys.source", "setwd", "data.frame", "as.data.frame", "tibble", "tribble",
  "as_tibble", "as.tbl", "as_data_frame", "get", "mget", "getFromNamespace", "do.call",
  "match.fun", "eval", "eval.parent", "evalq", "parse", "str2lang", "str2expression",
  "as.name", "as.symbol", "call", "system", "system2", "shell", "pipe"
)
violations <- character()
walk <- function(node) {
  if (is.call(node)) {
    head <- node[[1L]]
    if (is.symbol(head)) {
      name <- as.character(head)
      if (name %in% c("::", ":::")) violations <<- c(violations, "namespace-operator")
      if (name %in% forbidden) violations <<- c(violations, name)
    } else if (is.call(head)) {
      walk(head)
    }
    for (index in seq_along(node)[-1L]) walk(node[[index]])
  } else if (is.symbol(node)) {
    name <- as.character(node)
    if (name %in% forbidden) violations <<- c(violations, name)
  } else if (is.expression(node)) {
    for (item in node) walk(item)
  } else if (is.pairlist(node)) {
    for (index in seq_along(node)) {
      text <- deparse(node[[index]])
      if (length(text) && nzchar(paste(text, collapse = ""))) walk(parse(text = text, keep.source = FALSE))
    }
  }
}
walk(parse(file = commandArgs(TRUE)[[1L]], keep.source = FALSE))
if (length(violations)) {
  cat(paste(sort(unique(violations)), collapse = "\n"))
  quit(status = 42L)
}
`;

async function assertPolicy(candidate: string): Promise<void> {
  await withTemporaryRFile(candidate, async (path) => {
    try {
      await execFileAsync(
        process.env.PI_R_BASE_RSCRIPT ?? process.env.PI_R_RSCRIPT ?? "Rscript",
        ["--vanilla", "-e", POLICY_SCRIPT, path],
        { maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      const stdout = typeof error === "object" && error && "stdout" in error ? String(error.stdout).trim() : "";
      if (stdout) {
        throw new RecoverableError(
          "POLICY_VIOLATION",
          "Candidate uses operations forbidden by the locked R policy",
          { rules: stdout.split("\n") },
        );
      }
      throw new RecoverableError("POLICY_FAILURE", "Locked R policy validation could not run");
    }
  });
}

function formattedDiff(path: string, original: string, candidate: string): string {
  const removed = original.split("\n").map((line) => `-${line}`);
  const added = candidate.split("\n").map((line) => `+${line}`);
  return `diff --pi-r ${path}\n--- committed/${path}\n+++ formatted/${path}\n${[...removed, ...added].join("\n")}`;
}

export async function inspectApprovedFunction(
  projectRoot: string,
  functionName: unknown,
): Promise<ApprovedFunctionInspection> {
  if (typeof functionName !== "string" || !functionName) {
    throw new RecoverableError("INVALID_REQUEST", "Inspection requires an Approved Function name");
  }
  const root = resolve(projectRoot);
  const contractText = await readFile(resolve(root, "pi-r.yml"), "utf8");
  const contract = validateContract(JSON.parse(contractText));
  const approved = contract.functions.find((candidate) => candidate.name === functionName);
  if (!approved) {
    throw new RecoverableError(
      "SCOPE_VIOLATION",
      `Function '${functionName}' is not an Approved Function in the locked Project Contract`,
    );
  }
  const manifest = JSON.parse(await readFile(resolve(root, ".pi-r/manifest.json"), "utf8")) as {
    contractHash?: unknown;
    policyVersion?: unknown;
  };
  const contractHash = sha256(contractText);
  if (manifest.contractHash !== contractHash || manifest.policyVersion !== contract.policyVersion) {
    throw new RecoverableError("CONTRACT_DRIFT", "Project Contract provenance does not match the locked manifest");
  }
  const path = `R/${approved.name}.R`;
  const source = await readFile(resolve(root, path), "utf8");
  return {
    contractHash,
    contractVersion: contract.contractVersion,
    function: approved.name,
    path,
    policyVersion: contract.policyVersion,
    signature: `${approved.name} <- function(${approved.parameters.join(", ")})`,
    source,
    sourceHash: sha256(source),
  };
}

export async function prepareScopedMutation(projectRoot: string, input: unknown): Promise<PreparedScopedMutation> {
  const request = validateRequest(input);
  const inspection = await inspectApprovedFunction(projectRoot, request.function);
  const path = resolve(projectRoot, inspection.path);
  const original = inspection.source;
  if (inspection.sourceHash !== request.expectedSourceHash) {
    throw new RecoverableError(
      "STALE_CONTENT",
      "Approved Function file changed since it was read",
      { expected: request.expectedSourceHash, actual: inspection.sourceHash },
    );
  }
  const edit = await createEditCandidate({
    path,
    function: inspection.function,
    operation: request.operation,
  });
  if (edit.function.signature !== inspection.signature) {
    throw new RecoverableError("SCOPE_VIOLATION", "Candidate changed the contract-approved function signature");
  }
  await assertPolicy(edit.candidate);
  if ((await readFile(path, "utf8")) !== original) {
    throw new RecoverableError("STALE_CONTENT", "Approved Function file changed during candidate validation");
  }

  return {
    capabilityVersion: CAPABILITY_VERSION,
    candidate: edit.candidate,
    contractHash: inspection.contractHash,
    contractVersion: inspection.contractVersion,
    diff: formattedDiff(inspection.path, original, edit.candidate),
    function: inspection.function,
    original,
    path: inspection.path,
    policyVersion: inspection.policyVersion,
  };
}
