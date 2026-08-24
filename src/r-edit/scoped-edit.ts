import { readFile } from "node:fs/promises";
import { RecoverableError } from "./errors.js";
import { formatRBody, assertBaseRParse, withTemporaryRFile } from "./tooling.js";
import { assertTreeSitterParse, inspectRFile } from "./tree-sitter.js";
import type { EditCandidate, EditRequest, RFunction } from "./types.js";

function validateRequest(input: unknown): EditRequest {
  if (!input || typeof input !== "object") {
    throw new RecoverableError("INVALID_REQUEST", "Edit request must be a JSON object");
  }
  const request = input as Partial<EditRequest>;
  if (typeof request.path !== "string" || typeof request.function !== "string") {
    throw new RecoverableError("INVALID_REQUEST", "Edit request requires path and function strings");
  }
  const operation = request.operation;
  if (!operation || typeof operation !== "object") {
    throw new RecoverableError("INVALID_REQUEST", "Edit request requires an operation");
  }
  if (operation.kind === "replace" && typeof operation.body === "string") {
    return { path: request.path, function: request.function, operation };
  }
  if (
    operation.kind === "patch" &&
    typeof operation.oldText === "string" &&
    operation.oldText.length > 0 &&
    typeof operation.newText === "string"
  ) {
    return { path: request.path, function: request.function, operation };
  }
  throw new RecoverableError("INVALID_REQUEST", "Operation must be a replacement or non-empty exact patch");
}

function replaceRange(source: string, startByte: number, endByte: number, replacement: string): string {
  const bytes = Buffer.from(source, "utf8");
  return Buffer.concat([
    bytes.subarray(0, startByte),
    Buffer.from(replacement, "utf8"),
    bytes.subarray(endByte),
  ]).toString("utf8");
}

function bodyForOperation(body: string, operation: EditRequest["operation"]): string {
  if (operation.kind === "replace") return operation.body;
  const matches = body.split(operation.oldText).length - 1;
  if (matches !== 1) {
    throw new RecoverableError(
      "STALE_CONTENT",
      "Patch oldText was not found exactly once in the selected function body",
      { matches },
    );
  }
  return body.replace(operation.oldText, operation.newText);
}

function assertStructureUnchanged(before: RFunction[], after: RFunction[], selectedName: string): RFunction {
  const beforeShape = before.map(({ name, signature }) => ({ name, signature }));
  const afterShape = after.map(({ name, signature }) => ({ name, signature }));
  if (JSON.stringify(beforeShape) !== JSON.stringify(afterShape)) {
    throw new RecoverableError(
      "SCOPE_VIOLATION",
      "Candidate changed a top-level function name or signature",
    );
  }
  const selected = after.find((fn) => fn.name === selectedName);
  if (!selected) {
    throw new RecoverableError("SCOPE_VIOLATION", "Candidate removed the selected function");
  }
  return selected;
}

export async function createEditCandidate(input: unknown): Promise<EditCandidate> {
  const request = validateRequest(input);
  const source = await readFile(request.path, "utf8");
  const inspection = await inspectRFile(request.path);
  const selected = inspection.functions.find((fn) => fn.name === request.function);
  if (!selected) {
    throw new RecoverableError(
      "FUNCTION_NOT_FOUND",
      `Top-level function '${request.function}' was not found`,
    );
  }

  const sourceBytes = Buffer.from(source, "utf8");
  const currentBody = sourceBytes
    .subarray(selected.bodyRange.startByte, selected.bodyRange.endByte)
    .toString("utf8");
  const requestedBody = bodyForOperation(currentBody, request.operation);
  const unformattedCandidate = replaceRange(
    source,
    selected.bodyRange.startByte,
    selected.bodyRange.endByte,
    requestedBody,
  );

  await withTemporaryRFile(unformattedCandidate, assertTreeSitterParse);
  const formattedBody = await formatRBody(requestedBody);
  const candidate = replaceRange(
    source,
    selected.bodyRange.startByte,
    selected.bodyRange.endByte,
    formattedBody,
  );

  return withTemporaryRFile(candidate, async (candidatePath) => {
    await assertTreeSitterParse(candidatePath);
    await assertBaseRParse([candidatePath]);
    const candidateInspection = await inspectRFile(candidatePath);
    const editedFunction = assertStructureUnchanged(
      inspection.functions,
      candidateInspection.functions,
      request.function,
    );
    return {
      path: inspection.path,
      function: editedFunction,
      candidate,
    };
  });
}
