import assert from "node:assert/strict";
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const libraryPath = process.env.PI_R_LIBRARY;
if (!libraryPath) throw new Error("PI_R_LIBRARY must point to the packaged library");
const library = await import(pathToFileURL(libraryPath));

test("the packaged TypeScript library exposes its version and resources", async () => {
  assert.equal(library.VERSION, "0.22.0");

  const paths = library.resourcePaths();
  assert.deepEqual(Object.keys(paths).sort(), ["extension", "rHelper", "reference", "resources", "scoutExtension", "skill", "technologyPolicy"]);
  await Promise.all(Object.values(paths).map((path) => access(path)));
  assert.equal(library.resourcePaths({ PI_R_TEST_RESOURCE_ROOT: "/tmp/test-resources" }).resources, "/tmp/test-resources");
});

async function failingExecutable(name, diagnostic, code) {
  const directory = await mkdtemp(join(tmpdir(), "pi-r-library-failure-"));
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\necho ${JSON.stringify(diagnostic)} >&2\nexit ${code}\n`);
  await chmod(path, 0o755);
  return path;
}

test("Tree-sitter runtime failures are non-retryable and distinct from R syntax", async () => {
  const candidate = join(await mkdtemp(join(tmpdir(), "pi-r-valid-r-")), "candidate.R");
  await writeFile(candidate, "answer <- function() { 42 }\n");
  const previous = process.env.PI_R_TEST_TREE_SITTER;
  try {
    for (const [diagnostic, code] of [
      ["error: unexpected argument '--lib-path' found", 2],
      ["Failed to load language parser: incompatible ABI", 1],
    ]) {
      process.env.PI_R_TEST_TREE_SITTER = await failingExecutable("tree-sitter", diagnostic, code);
      await assert.rejects(library.assertTreeSitterParse(candidate), (error) => {
        assert.equal(error.structured.code, "RUNTIME_INCOMPATIBLE");
        assert.equal(error.structured.retryable, false);
        assert.match(error.structured.details.diagnostic, /(?:lib-path|incompatible ABI)/);
        return true;
      });
    }
  } finally {
    if (previous === undefined) delete process.env.PI_R_TEST_TREE_SITTER;
    else process.env.PI_R_TEST_TREE_SITTER = previous;
  }
});

test("base-R runtime failures are distinct from parse diagnostics", async () => {
  const candidate = join(await mkdtemp(join(tmpdir(), "pi-r-valid-base-r-")), "candidate.R");
  await writeFile(candidate, "answer <- function() { 42 }\n");
  const previous = process.env.PI_R_TEST_BASE_RSCRIPT;
  try {
    process.env.PI_R_TEST_BASE_RSCRIPT = await failingExecutable("Rscript", "base runtime failed", 1);
    await assert.rejects(library.assertBaseRParse([candidate]), (error) => {
      assert.equal(error.structured.code, "RUNTIME_INCOMPATIBLE");
      assert.equal(error.structured.retryable, false);
      return true;
    });

    process.env.PI_R_TEST_BASE_RSCRIPT = await failingExecutable("Rscript", "Error in parse: unexpected ')'", 1);
    await assert.rejects(library.assertBaseRParse([candidate]), (error) => {
      assert.equal(error.structured.code, "INVALID_R_SYNTAX");
      assert.equal(error.structured.retryable, true);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.PI_R_TEST_BASE_RSCRIPT;
    else process.env.PI_R_TEST_BASE_RSCRIPT = previous;
  }
});
