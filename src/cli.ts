#!/usr/bin/env node

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, resourcePaths } from "./index.js";

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

  process.stderr.write("Usage: pi-r --version | pi-r paths [--json]\n");
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-r: ${message}\n`);
    process.exitCode = 1;
  });
}
