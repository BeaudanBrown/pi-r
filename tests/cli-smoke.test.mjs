import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = process.env.PI_R_CLI;

if (!cli) throw new Error("PI_R_CLI must point to the packaged pi-r executable");

test("the packaged CLI reports its version", async () => {
  const { stdout } = await execFileAsync(cli, ["--version"]);
  assert.match(stdout.trim(), /^pi-r 0\.11\.0$/);
});

test("the packaged CLI exposes usable Pi and R resource paths", async () => {
  const { stdout } = await execFileAsync(cli, ["paths", "--json"]);
  const paths = JSON.parse(stdout);

  assert.deepEqual(Object.keys(paths).sort(), ["extension", "rHelper", "resources", "technologyPolicy"]);
  await Promise.all(Object.values(paths).map((path) => access(path)));
});

test("paths can be resolved from an explicit resource root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-r-resources-"));
  await mkdir(join(root, "extensions"));
  await mkdir(join(root, "R"));
  await mkdir(join(root, "resources"));
  await writeFile(join(root, "extensions", "pi-r.ts"), "export default () => {};\n");
  await writeFile(join(root, "R", "pi_r_runtime.R"), "invisible(NULL)\n");
  await writeFile(join(root, "resources", "technology-policy-v1.json"), "{}\n");

  const { stdout } = await execFileAsync(cli, ["paths", "--json"], {
    env: { ...process.env, PI_R_RESOURCE_ROOT: root },
  });
  const paths = JSON.parse(stdout);

  assert.equal(paths.resources, root);
  assert.equal(paths.extension, join(root, "extensions", "pi-r.ts"));
  assert.equal(paths.rHelper, join(root, "R", "pi_r_runtime.R"));
  assert.equal(paths.technologyPolicy, join(root, "resources", "technology-policy-v1.json"));
});
