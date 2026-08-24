import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = process.env.PI_R_CLI;
const contract = process.env.PI_R_CONTRACT_FIXTURE;
if (!cli || !contract) throw new Error("PI_R_CLI and PI_R_CONTRACT_FIXTURE are required");

async function run(args) {
  try {
    const result = await execFileAsync(cli, args);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function outputDirectory() {
  return join(await mkdtemp(join(tmpdir(), "pi-r-project-")), "generated");
}

async function filesBelow(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(root, relative)));
    else files.push(relative);
  }
  return files.sort();
}

async function snapshot(root) {
  return Object.fromEntries(
    await Promise.all(
      (await filesBelow(root)).map(async (path) => [path, await readFile(join(root, path), "utf8")]),
    ),
  );
}

test("a schema-validated contract exposes the complete semantic design", async () => {
  const result = await run(["contract", "validate", contract]);
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout).value;
  assert.deepEqual(value, {
    contractVersion: 1,
    templateVersion: "pi-r-template-v1",
    policyVersion: "pi-r-policy-v1",
    project: "confidential-analysis",
    dependencies: ["data.table"],
    functions: ["load_input", "make_config", "summarise_groups", "write_result"],
    constants: ["input_path", "output_path", "threshold"],
    targets: ["raw_data", "config", "summaries", "report"],
  });
});

test("generation creates the complete deterministic Nix/targets scaffold", async () => {
  const first = await outputDirectory();
  const second = await outputDirectory();
  for (const output of [first, second]) {
    const result = await run(["contract", "generate", contract, output]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }

  const firstSnapshot = await snapshot(first);
  assert.deepEqual(firstSnapshot, await snapshot(second));
  assert.deepEqual(Object.keys(firstSnapshot), [
    ".envrc",
    ".gitignore",
    ".pi-r/manifest.json",
    "R/constants.R",
    "R/load_input.R",
    "R/make_config.R",
    "R/summarise_groups.R",
    "R/write_result.R",
    "_targets.R",
    "flake.lock",
    "flake.nix",
    "pi-r.yml",
  ]);

  const targets = firstSnapshot["_targets.R"];
  assert.match(targets, /load_input\(path = PI_R_CONSTANTS\$input_path\)/);
  assert.match(targets, /summarise_groups\(input = raw_data, config = config\)/);
  assert.match(targets, /make_config\(threshold = PI_R_CONSTANTS\$threshold\), format = "qs"/);
  assert.match(targets, /format = "qs", pattern = map\(raw_data\)/);
  assert.match(targets, /format = "file", pattern = cross\(summaries, config\)/);
  assert.match(targets, /tar_option_set\(packages = c\("data.table"\), workspace_on_error = TRUE\)/);
  assert.match(firstSnapshot["R/constants.R"], /input_path = "data\/input\.qs"[\s\S]*output_path = "artifacts\/report\.qs"[\s\S]*threshold = 0\.5/);
  assert.match(firstSnapshot["flake.nix"], /rPackages\."data_table"/);
  assert.match(firstSnapshot["flake.lock"], /b6018f87da91d19d0ab4cf979885689b469cdd41/);
  assert.equal(firstSnapshot[".envrc"], "use flake\n");

  await execFileAsync("nix-instantiate", ["--parse", join(first, "flake.nix")]);
  await execFileAsync("Rscript", [
    "--vanilla",
    "-e",
    "parse(file = commandArgs(TRUE)[[1]])",
    join(first, "_targets.R"),
  ]);
});

test("contract checking detects machine-owned drift but permits function body implementation", async () => {
  const output = await outputDirectory();
  assert.equal((await run(["contract", "generate", contract, output])).code, 0);
  assert.equal((await run(["contract", "check", contract, output])).code, 0);

  const functionPath = join(output, "R", "load_input.R");
  const functionSource = await readFile(functionPath, "utf8");
  await writeFile(functionPath, functionSource.replace('stop("Not implemented: load_input", call. = FALSE)', "qs::qread(path)"));
  assert.equal((await run(["contract", "check", contract, output])).code, 0);

  const targetsPath = join(output, "_targets.R");
  await writeFile(targetsPath, `${await readFile(targetsPath, "utf8")}# manual drift\n`);
  const drift = await run(["contract", "check", contract, output]);
  assert.equal(drift.code, 1);
  assert.deepEqual(JSON.parse(drift.stdout).error, {
    code: "DRIFT_DETECTED",
    message: "Generated project does not match its locked contract",
    recoverable: true,
    details: { paths: ["_targets.R"] },
  });
});

test("function signature drift is detected", async () => {
  const output = await outputDirectory();
  assert.equal((await run(["contract", "generate", contract, output])).code, 0);
  const functionPath = join(output, "R", "make_config.R");
  await writeFile(functionPath, (await readFile(functionPath, "utf8")).replace("function(threshold)", "function(threshold, extra)"));
  const result = await run(["contract", "check", contract, output]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).error.details.paths, ["R/make_config.R"]);
});

test("static or unknown branching forms are rejected without creating output", async () => {
  const invalid = join(await mkdtemp(join(tmpdir(), "pi-r-invalid-contract-")), "invalid.yml");
  await writeFile(
    invalid,
    (await readFile(contract, "utf8")).replace("kind: map", "kind: static"),
  );
  const output = await outputDirectory();
  const result = await run(["contract", "generate", invalid, output]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "INVALID_CONTRACT");
  await assert.rejects(access(output));
});
