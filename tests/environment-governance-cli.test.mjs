import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const cli = process.env.PI_R_CLI;
const contract = process.env.PI_R_CONTRACT_FIXTURE;
if (!cli || !contract) throw new Error("PI_R_CLI and PI_R_CONTRACT_FIXTURE are required");

async function fakeNix() {
  const root = await mkdtemp(join(tmpdir(), "pi-r-fake-nix-"));
  const executable = join(root, "nix");
  await writeFile(executable, `#!/bin/sh
case "$*" in
  *attrNames*) printf '%s\\n' '["data_table","data_tree","yaml"]' ;;
  *data.tabel*) printf '%s\\n' '[{"name":"data.tabel","attribute":"data_tabel","exists":false,"available":false,"broken":false,"version":null}]' ;;
  *yaml*) printf '%s\\n' '[{"name":"yaml","attribute":"yaml","exists":true,"available":true,"broken":false,"version":"2.3.10"}]' ;;
  *) printf '%s\\n' '[]' ;;
esac
`);
  await chmod(executable, 0o755);
  return executable;
}

async function run(args, environment = {}) {
  try {
    const result = await execFileAsync(cli, args, {
      encoding: "utf8",
      env: { ...process.env, ...environment },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("technology policy classifies required, prohibited, and unregistered package choices", async () => {
  const required = await run(["packages", "policy", "data.table", "tabular"]);
  assert.equal(required.code, 0, required.stderr);
  assert.deepEqual(JSON.parse(required.stdout).value, {
    package: "data.table",
    domain: "tabular",
    status: "required",
    rationale: "Canonical tabular representation and transformation package",
    alternatives: [],
    registered: true,
  });

  const prohibited = await run(["packages", "policy", "dplyr", "tabular"]);
  assert.equal(prohibited.code, 0, prohibited.stderr);
  assert.equal(JSON.parse(prohibited.stdout).value.status, "prohibited");
  assert.deepEqual(JSON.parse(prohibited.stdout).value.alternatives, ["data.table"]);
  const prohibitedDomainBypass = await run(["packages", "policy", "dplyr", "visualization"]);
  assert.equal(JSON.parse(prohibitedDomainBypass.stdout).value.status, "prohibited");

  const unregistered = await run(["packages", "policy", "specialistPkg", "specialist"]);
  assert.equal(unregistered.code, 0, unregistered.stderr);
  assert.equal(JSON.parse(unregistered.stdout).value.status, "unregistered");
  assert.equal(JSON.parse(unregistered.stdout).value.registered, false);
});

test("pinned nixpkgs resolution returns versions and bounded candidates without mutation", async () => {
  const nix = await fakeNix();
  const valid = await run(["packages", "resolve", contract, "yaml"], { PI_R_NIX: nix });
  assert.equal(valid.code, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout).value.packages, [{
    name: "yaml",
    attribute: "yaml",
    exists: true,
    available: true,
    broken: false,
    version: "2.3.10",
    candidates: [],
  }]);

  const invalid = await run(["packages", "resolve", contract, "data.tabel"], { PI_R_NIX: nix });
  assert.equal(invalid.code, 1);
  const error = JSON.parse(invalid.stdout).error;
  assert.equal(error.code, "UNKNOWN_PACKAGE");
  assert.equal(error.recoverable, true);
  assert.deepEqual(error.details.packages, [{ name: "data.tabel", candidates: ["data.table", "data.tree"] }]);
});
