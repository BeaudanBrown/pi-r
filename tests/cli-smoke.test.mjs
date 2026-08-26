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
  assert.match(stdout.trim(), /^pi-r 0\.19\.0$/);
});

test("the packaged CLI exposes usable Pi and R resource paths", async () => {
  const { stdout } = await execFileAsync(cli, ["paths", "--json"]);
  const paths = JSON.parse(stdout);

  assert.deepEqual(Object.keys(paths).sort(), ["extension", "rHelper", "reference", "resources", "scoutExtension", "skill", "technologyPolicy"]);
  await Promise.all(Object.values(paths).map((path) => access(path)));
});

test("the packaged CLI ignores inherited test resource roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-r-resources-"));
  await mkdir(join(root, "extensions"));
  await mkdir(join(root, "R"));
  await mkdir(join(root, "resources"));
  await mkdir(join(root, "skills", "pi-r", "references"), { recursive: true });
  await writeFile(join(root, "extensions", "pi-r.ts"), "export default () => {};\n");
  await writeFile(join(root, "extensions", "pi-r-dependency-scout.ts"), "export default () => {};\n");
  await writeFile(join(root, "R", "pi_r_runtime.R"), "invisible(NULL)\n");
  await writeFile(join(root, "resources", "technology-policy-v1.json"), "{}\n");
  await writeFile(join(root, "skills", "pi-r", "SKILL.md"), "---\nname: pi-r\ndescription: Test\n---\n");
  await writeFile(join(root, "skills", "pi-r", "references", "workbench.md"), "# Test\n");

  const { stdout } = await execFileAsync(cli, ["paths", "--json"], {
    env: { ...process.env, PI_R_TEST_RESOURCE_ROOT: root },
  });
  const paths = JSON.parse(stdout);

  assert.notEqual(paths.resources, root);
  await Promise.all(Object.values(paths).map((path) => access(path)));
});
