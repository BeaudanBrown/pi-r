import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RecoverableError } from "./errors.js";

const execFileAsync = promisify(execFile);

async function temporaryRFile(content: string): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-r-candidate-"));
  const path = join(directory, "candidate.R");
  await writeFile(path, content, "utf8");
  return { directory, path };
}

export async function withTemporaryRFile<T>(
  content: string,
  operation: (path: string) => Promise<T>,
): Promise<T> {
  const temporary = await temporaryRFile(content);
  try {
    return await operation(temporary.path);
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
}

export async function formatRBody(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-r-format-"));
  const input = join(directory, "input.R");
  const output = join(directory, "output.R");
  await writeFile(input, body, "utf8");
  try {
    await execFileAsync(
      process.env.PI_R_RSCRIPT ?? "Rscript",
      ["--vanilla", process.env.PI_R_FORMATTER_SCRIPT ?? "", input, output],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return (await readFile(output, "utf8")).trimEnd();
  } catch {
    throw new RecoverableError(
      "FORMATTER_FAILURE",
      "Candidate body could not be formatted as R code",
      { formatter: "styler" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function assertBaseRParse(paths: readonly string[]): Promise<void> {
  try {
    await execFileAsync(
      process.env.PI_R_BASE_RSCRIPT ?? process.env.PI_R_RSCRIPT ?? "Rscript",
      [
        "--vanilla",
        "-e",
        "for (path in commandArgs(TRUE)) parse(file = path, keep.source = FALSE)",
        ...paths,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    throw new RecoverableError(
      "INVALID_R_SYNTAX",
      "Candidate failed a fresh base-R parse",
      { validator: "base-r" },
    );
  }
}
