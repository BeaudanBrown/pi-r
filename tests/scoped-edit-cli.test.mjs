import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = process.env.PI_R_CLI;
const fixture = process.env.PI_R_EDIT_FIXTURE;
if (!cli || !fixture) throw new Error("PI_R_CLI and PI_R_EDIT_FIXTURE are required");

async function run(args, environment = {}) {
  try {
    const result = await execFileAsync(cli, args, {
      env: { ...process.env, ...environment },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function tempCopy() {
  const directory = await mkdtemp(join(tmpdir(), "pi-r-edit-"));
  const path = join(directory, basename(fixture));
  await writeFile(path, await readFile(fixture, "utf8"));
  return path;
}

async function requestFile(request) {
  const directory = await mkdtemp(join(tmpdir(), "pi-r-request-"));
  const path = join(directory, "request.json");
  await writeFile(path, JSON.stringify(request));
  return path;
}

test("inspect discovers top-level signatures, body ranges, and local helpers", async () => {
  const result = await run(["r-functions", "inspect", fixture]);
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.deepEqual(
    envelope.value.functions.map(({ name, signature, localHelpers }) => ({
      name,
      signature,
      localHelpers: localHelpers.map((helper) => helper.name),
    })),
    [
      {
        name: "summarise_groups",
        signature: "summarise_groups <- function(input, value_col)",
        localHelpers: ["local_mean"],
      },
      {
        name: "write_result",
        signature: "write_result <- function(table, output_path)",
        localHelpers: [],
      },
    ],
  );
  for (const fn of envelope.value.functions) {
    assert.ok(fn.bodyRange.startByte < fn.bodyRange.endByte);
    assert.equal(typeof fn.bodyRange.start.row, "number");
  }
});

test("full replacement returns a formatted, parseable candidate without changing the file", async () => {
  const path = await tempCopy();
  const original = await readFile(path, "utf8");
  const request = await requestFile({
    path,
    function: "write_result",
    operation: {
      kind: "replace",
      body: "{\nqs_save( table , output_path )\ninvisible(output_path)\n}",
    },
  });

  const result = await run(["r-functions", "edit", request]);
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.match(envelope.value.candidate, /qs_save\(table, output_path\)/);
  assert.match(envelope.value.candidate, /invisible\(output_path\)/);
  assert.equal(await readFile(path, "utf8"), original);
});

test("the pinned formatter is idempotent for representative data.table syntax", async () => {
  const path = await tempCopy();
  const body = "{\nresult<-input[,.(mean_value=mean(get(value_col),na.rm=TRUE)),by=group]\nresult\n}";
  const firstRequest = await requestFile({
    path,
    function: "summarise_groups",
    operation: { kind: "replace", body },
  });
  const firstResult = await run(["r-functions", "edit", firstRequest]);
  assert.equal(firstResult.code, 0, firstResult.stderr);
  const firstCandidate = JSON.parse(firstResult.stdout).value.candidate;
  assert.match(firstCandidate, /input\[, \.\(mean_value = mean\(get\(value_col\), na\.rm = TRUE\)\), by = group\]/);

  const formattedPath = join(await mkdtemp(join(tmpdir(), "pi-r-formatted-")), "formatted.R");
  await writeFile(formattedPath, firstCandidate);
  const secondRequest = await requestFile({
    path: formattedPath,
    function: "summarise_groups",
    operation: { kind: "replace", body },
  });
  const secondResult = await run(["r-functions", "edit", secondRequest]);
  assert.equal(secondResult.code, 0, secondResult.stderr);
  assert.equal(JSON.parse(secondResult.stdout).value.candidate, firstCandidate);
});

test("an exact patch is confined to the selected body and rejects stale content", async () => {
  const path = await tempCopy();
  const original = await readFile(path, "utf8");
  const validRequest = await requestFile({
    path,
    function: "summarise_groups",
    operation: {
      kind: "patch",
      oldText: "mean(x, na.rm = TRUE)",
      newText: "median(x, na.rm = TRUE)",
    },
  });
  const valid = await run(["r-functions", "edit", validRequest]);
  assert.equal(valid.code, 0, valid.stderr);
  assert.match(JSON.parse(valid.stdout).value.candidate, /median\(x, na\.rm = TRUE\)/);

  const staleRequest = await requestFile({
    path,
    function: "summarise_groups",
    operation: { kind: "patch", oldText: "not current", newText: "replacement" },
  });
  const stale = await run(["r-functions", "edit", staleRequest]);
  assert.equal(stale.code, 1);
  assert.deepEqual(JSON.parse(stale.stdout), {
    ok: false,
    error: {
      code: "STALE_CONTENT",
      message: "Patch oldText was not found exactly once in the selected function body",
      recoverable: true,
      details: { matches: 0 },
    },
  });
  assert.equal(await readFile(path, "utf8"), original);
});

test("invalid candidates return structured errors and never mutate source", async () => {
  const path = await tempCopy();
  const original = await readFile(path, "utf8");
  const request = await requestFile({
    path,
    function: "write_result",
    operation: { kind: "replace", body: "{\nif (\n}" },
  });

  const result = await run(["r-functions", "edit", request]);
  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "INVALID_R_SYNTAX");
  assert.equal(envelope.error.recoverable, true);
  assert.equal(await readFile(path, "utf8"), original);
});

test("the packaged CLI ignores inherited internal Tree-sitter overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-r-stale-tree-sitter-"));
  const stale = join(directory, "tree-sitter");
  await writeFile(stale, "#!/bin/sh\necho stale runtime >&2\nexit 2\n");
  await chmod(stale, 0o755);

  const result = await run(["r-functions", "inspect", fixture], { PI_R_TREE_SITTER: stale });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("Tree-sitter CLI incompatibility is non-retryable and not reported as R syntax", async () => {
  const path = await tempCopy();
  const request = await requestFile({
    path,
    function: "write_result",
    operation: { kind: "replace", body: "{\ninvisible(output_path)\n}" },
  });
  const directory = await mkdtemp(join(tmpdir(), "pi-r-incompatible-tree-sitter-"));
  const incompatible = join(directory, "tree-sitter");
  await writeFile(incompatible, "#!/bin/sh\necho \"error: unexpected argument '--lib-path' found\" >&2\nexit 2\n");
  await chmod(incompatible, 0o755);

  const result = await run(["r-functions", "edit", request], { PI_R_TEST_TREE_SITTER: incompatible });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).error, {
    code: "RUNTIME_INCOMPATIBLE",
    message: "Tree-sitter CLI is incompatible with the packaged R parser",
    recoverable: true,
    retryable: false,
    agentAction: "Do not change the R candidate; restart with one coherent pi-r runtime",
    details: {
      validator: "tree-sitter",
      phase: "parse",
      diagnostic: "error: unexpected argument '--lib-path' found",
    },
  });
});

test("a fresh base-R parse is required after Tree-sitter validation", async () => {
  const path = await tempCopy();
  const original = await readFile(path, "utf8");
  const request = await requestFile({
    path,
    function: "write_result",
    operation: { kind: "replace", body: "{\ninvisible(output_path)\n}" },
  });
  const directory = await mkdtemp(join(tmpdir(), "pi-r-failing-r-"));
  const failingR = join(directory, "Rscript");
  await writeFile(failingR, "#!/bin/sh\nexit 1\n");
  await chmod(failingR, 0o755);

  const result = await run(["r-functions", "edit", request], {
    PI_R_TEST_BASE_RSCRIPT: failingR,
  });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).error, {
    code: "INVALID_R_SYNTAX",
    message: "Candidate failed a fresh base-R parse",
    recoverable: true,
    details: { validator: "base-r" },
  });
  assert.equal(await readFile(path, "utf8"), original);
});

test("patches cannot target text outside the selected function body", async () => {
  const path = await tempCopy();
  const request = await requestFile({
    path,
    function: "write_result",
    operation: {
      kind: "patch",
      oldText: "summarise_groups <- function",
      newText: "changed <- function",
    },
  });

  const result = await run(["r-functions", "edit", request]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "STALE_CONTENT");
});
