#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION,
  RecoverableError,
  checkScaffold,
  createEditCandidate,
  errorEnvelope,
  generateScaffold,
  inspectRFile,
  readContract,
  resourcePaths,
  summarizeContract,
} from "./index.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runRFunctions(args: string[]): Promise<void> {
  try {
    if (args.length === 2 && args[0] === "inspect") {
      printJson({ ok: true, value: await inspectRFile(args[1]) });
      return;
    }
    if (args.length === 2 && args[0] === "edit") {
      let request: unknown;
      try {
        request = JSON.parse(await readFile(args[1], "utf8"));
      } catch {
        throw new RecoverableError("INVALID_REQUEST", "Edit request must be readable JSON");
      }
      printJson({ ok: true, value: await createEditCandidate(request) });
      return;
    }
    process.stderr.write("Usage: pi-r r-functions inspect FILE | pi-r r-functions edit REQUEST.json\n");
    process.exitCode = 2;
  } catch (error) {
    printJson(errorEnvelope(error));
    process.exitCode = 1;
  }
}

async function runContract(args: string[]): Promise<void> {
  try {
    if (args.length === 2 && args[0] === "validate") {
      printJson({ ok: true, value: summarizeContract(await readContract(args[1])) });
      return;
    }
    if (args.length === 3 && args[0] === "generate") {
      const contract = await readContract(args[1]);
      const files = await generateScaffold(contract, args[2]);
      printJson({ ok: true, value: { output: resolve(args[2]), files } });
      return;
    }
    if (args.length === 3 && args[0] === "check") {
      const contract = await readContract(args[1]);
      await checkScaffold(contract, args[2]);
      printJson({ ok: true, value: { project: resolve(args[2]), drift: [] } });
      return;
    }
    process.stderr.write(
      "Usage: pi-r contract validate CONTRACT | pi-r contract <generate|check> CONTRACT PROJECT\n",
    );
    process.exitCode = 2;
  } catch (error) {
    printJson(errorEnvelope(error));
    process.exitCode = 1;
  }
}

async function printPaths(asJson: boolean): Promise<void> {
  const paths = resourcePaths();
  await Promise.all(Object.values(paths).map((path) => access(path)));

  if (asJson) {
    process.stdout.write(`${JSON.stringify(paths)}\n`);
    return;
  }

  process.stdout.write(
    `resources=${paths.resources}\nextension=${paths.extension}\nrHelper=${paths.rHelper}\n`,
  );
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    process.stdout.write(`pi-r ${VERSION}\n`);
    return;
  }

  if (args[0] === "paths" && args.slice(1).every((arg) => arg === "--json")) {
    await printPaths(args.includes("--json"));
    return;
  }

  if (args[0] === "r-functions") {
    await runRFunctions(args.slice(1));
    return;
  }

  if (args[0] === "contract") {
    await runContract(args.slice(1));
    return;
  }

  process.stderr.write(
    "Usage: pi-r --version | pi-r paths [--json] | pi-r r-functions ... | pi-r contract ...\n",
  );
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-r: ${message}\n`);
    process.exitCode = 1;
  });
}
