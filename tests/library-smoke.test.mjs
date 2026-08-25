import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const libraryPath = process.env.PI_R_LIBRARY;
if (!libraryPath) throw new Error("PI_R_LIBRARY must point to the packaged library");

test("the packaged TypeScript library exposes its version and resources", async () => {
  const library = await import(pathToFileURL(libraryPath));
  assert.equal(library.VERSION, "0.10.0");

  const paths = library.resourcePaths();
  assert.deepEqual(Object.keys(paths).sort(), ["extension", "rHelper", "resources"]);
  await Promise.all(Object.values(paths).map((path) => access(path)));
});
