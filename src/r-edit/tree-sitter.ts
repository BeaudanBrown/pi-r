import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { RecoverableError } from "./errors.js";
import type { Inspection, Position, RFunction, SourceRange } from "./types.js";

const execFileAsync = promisify(execFile);

interface Capture {
  pattern: number;
  name: string;
  start: Position;
  end: Position;
}

interface TreeSitterTools {
  executable: string;
  grammar: string;
  query: string;
}

function tools(environment = process.env): TreeSitterTools {
  return {
    executable: environment.PI_R_TREE_SITTER ?? "tree-sitter",
    grammar: environment.PI_R_TREE_SITTER_R ?? "",
    query: environment.PI_R_TREE_SITTER_QUERY ?? "",
  };
}

function parseCaptures(output: string): Capture[] {
  const capturePattern = /pattern:\s+(\d+), capture: \d+ - ([\w.]+), start: \((\d+), (\d+)\), end: \((\d+), (\d+)\)/;
  return output
    .split("\n")
    .map((line) => line.match(capturePattern))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pattern: Number(match[1]),
      name: match[2],
      start: { row: Number(match[3]), column: Number(match[4]) },
      end: { row: Number(match[5]), column: Number(match[6]) },
    }));
}

function byteOffset(source: string, position: Position): number {
  const lines = source.split("\n");
  if (position.row >= lines.length) {
    throw new RecoverableError("TREE_SITTER_FAILURE", "Tree-sitter returned an invalid source range");
  }
  let offset = 0;
  for (let row = 0; row < position.row; row += 1) {
    offset += Buffer.byteLength(lines[row], "utf8") + 1;
  }
  return offset + position.column;
}

function sourceRange(source: string, start: Position, end: Position): SourceRange {
  return {
    start,
    end,
    startByte: byteOffset(source, start),
    endByte: byteOffset(source, end),
  };
}

function sliceRange(source: string, range: SourceRange): string {
  return Buffer.from(source, "utf8").subarray(range.startByte, range.endByte).toString("utf8");
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.startByte <= inner.startByte && outer.endByte >= inner.endByte;
}

export async function assertTreeSitterParse(path: string): Promise<void> {
  const configured = tools();
  try {
    await execFileAsync(
      configured.executable,
      [
        "parse",
        "--quiet",
        "--lib-path",
        configured.grammar,
        "--lang-name",
        "r",
        resolve(path),
      ],
      { maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    const diagnostic = [failure.stderr, failure.stdout]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
      .join("\n")
      .slice(0, 2000);
    if (/unexpected argument|unknown (?:argument|option)|unrecognized option/i.test(diagnostic)) {
      throw new RecoverableError(
        "RUNTIME_INCOMPATIBLE",
        "Tree-sitter CLI is incompatible with the packaged R parser",
        { validator: "tree-sitter", phase: "parse", diagnostic },
        {
          retryable: false,
          agentAction: "Do not change the R candidate; restart with one coherent pi-r runtime",
        },
      );
    }
    if (failure.code !== 1) {
      throw new RecoverableError(
        "TREE_SITTER_FAILURE",
        "Tree-sitter could not validate the R candidate",
        { validator: "tree-sitter", phase: "parse", ...(diagnostic ? { diagnostic } : {}) },
        { retryable: false, agentAction: "Do not retry the edit; report the validator failure to the operator" },
      );
    }
    throw new RecoverableError(
      "INVALID_R_SYNTAX",
      "Candidate failed Tree-sitter structural validation",
      { validator: "tree-sitter", ...(diagnostic ? { diagnostic } : {}) },
      { retryable: true, agentAction: "Correct the candidate R syntax before retrying" },
    );
  }
}

export async function inspectRFile(path: string): Promise<Inspection> {
  const absolutePath = resolve(path);
  const source = await readFile(absolutePath, "utf8");
  await assertTreeSitterParse(absolutePath);
  const configured = tools();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      configured.executable,
      [
        "query",
        "--captures",
        "--lib-path",
        configured.grammar,
        "--lang-name",
        "r",
        configured.query,
        absolutePath,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch {
    throw new RecoverableError("TREE_SITTER_FAILURE", "Tree-sitter could not inspect the R source");
  }

  const captures = parseCaptures(stdout);
  const topCaptures = captures.filter((capture) => capture.pattern === 0);
  const functions: RFunction[] = [];
  for (let index = 0; index < topCaptures.length; index += 1) {
    if (topCaptures[index].name !== "top.name") continue;
    const group: Capture[] = [topCaptures[index]];
    while (index + 1 < topCaptures.length && topCaptures[index + 1].name !== "top.name") {
      group.push(topCaptures[index + 1]);
      index += 1;
    }
    const byName = Object.fromEntries(group.map((capture) => [capture.name, capture]));
    const nameCapture = byName["top.name"];
    const functionCapture = byName["top.function"];
    const parametersCapture = byName["top.parameters"];
    const bodyCapture = byName["top.body"];
    if (!nameCapture || !functionCapture || !parametersCapture || !bodyCapture) continue;

    const nameRange = sourceRange(source, nameCapture.start, nameCapture.end);
    const functionRange = sourceRange(source, functionCapture.start, functionCapture.end);
    const parametersRange = sourceRange(source, parametersCapture.start, parametersCapture.end);
    const bodyRange = sourceRange(source, bodyCapture.start, bodyCapture.end);
    const signatureRange: SourceRange = {
      start: nameCapture.start,
      end: bodyCapture.start,
      startByte: nameRange.startByte,
      endByte: bodyRange.startByte,
    };
    functions.push({
      name: sliceRange(source, nameRange),
      signature: sliceRange(source, signatureRange).trimEnd(),
      parameters: sliceRange(source, parametersRange),
      bodyRange,
      functionRange,
      localHelpers: [],
    });
  }

  const assignedCaptures = captures.filter((capture) => capture.pattern === 1);
  for (let index = 0; index < assignedCaptures.length - 1; index += 1) {
    const nameCapture = assignedCaptures[index];
    const functionCapture = assignedCaptures[index + 1];
    if (nameCapture.name !== "assigned.name" || functionCapture.name !== "assigned.function") continue;
    const range = sourceRange(source, functionCapture.start, functionCapture.end);
    const owner = functions.find(
      (fn) => contains(fn.functionRange, range) && fn.functionRange.startByte !== range.startByte,
    );
    if (owner) {
      const nameRange = sourceRange(source, nameCapture.start, nameCapture.end);
      owner.localHelpers.push({ name: sliceRange(source, nameRange), range });
    }
    index += 1;
  }

  return { path: absolutePath, functions };
}
