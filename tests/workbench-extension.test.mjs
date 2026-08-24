import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const extensionPath = process.env.PI_R_COMPILED_EXTENSION;
if (!extensionPath) throw new Error("PI_R_COMPILED_EXTENSION must point to the compiled extension");
const extension = await import(pathToFileURL(extensionPath));
const cli = process.env.PI_R_CLI;
const contractFixture = process.env.PI_R_CONTRACT_FIXTURE;
if (!cli || !contractFixture) throw new Error("PI_R_CLI and PI_R_CONTRACT_FIXTURE are required");

async function fixtureContract() {
  const base = await mkdtemp(join(tmpdir(), "pi-r-contract-object-"));
  const output = join(base, "generated");
  await execFileAsync(cli, ["contract", "generate", contractFixture, output]);
  return JSON.parse(await readFile(join(output, "pi-r.yml"), "utf8"));
}

async function git(cwd, ...args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-r-workbench-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "user.name", "pi-r test");
  await writeFile(join(root, "analysis.R"), "value <- 1\n");
  await git(root, "add", "analysis.R");
  await git(root, "commit", "-qm", "initial");
  return realpath(root);
}

function harness(entries = []) {
  const commands = [];
  const tools = [];
  const handlers = new Map();
  const activeToolChanges = [];
  const appended = [];
  const allTools = ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({
    name,
    sourceInfo: { source: "builtin" },
  }));
  const pi = {
    registerCommand(name, options) { commands.push({ name, options }); },
    registerTool(definition) { tools.push(definition); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(type, data) { appended.push({ type: "custom", customType: type, data }); },
    getAllTools() { return allTools; },
    getActiveTools() { return allTools.map((tool) => tool.name); },
    setActiveTools(names) { activeToolChanges.push([...names]); },
    async exec(command, args, options = {}) {
      try {
        const result = await execFileAsync(command, args, {
          cwd: options.cwd,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        });
        return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
      } catch (error) {
        return {
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? String(error),
          code: typeof error.code === "number" ? error.code : 1,
          killed: false,
        };
      }
    },
  };
  extension.default(pi);
  return { commands, tools, handlers, activeToolChanges, appended, entries };
}

function context(root, entries = [], confirmations = []) {
  const notifications = [];
  const widgets = [];
  const confirmationRequests = [];
  return {
    cwd: root,
    sessionManager: {
      getBranch() { return entries; },
      getEntries() { return entries; },
    },
    ui: {
      notify(...args) { notifications.push(args); },
      setWidget(...args) { widgets.push(args); },
      setStatus() {},
      async confirm(...args) {
        confirmationRequests.push(args);
        return confirmations.shift() ?? false;
      },
    },
    notifications,
    widgets,
    confirmationRequests,
  };
}

test("/r start stashes tracked changes and enters a dedicated constrained branch", async () => {
  const root = await repository();
  await writeFile(join(root, "analysis.R"), "value <- 2\n");
  await writeFile(join(root, "untracked.txt"), "preserve me\n");
  const attached = await mkdtemp(join(tmpdir(), "pi-r-attached-"));
  const h = harness();
  const ctx = context(root);

  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0].name, "r");
  await h.commands[0].options.handler(`start ${attached}`, ctx);

  assert.equal(await git(root, "branch", "--show-current"), "pi-r/workbench");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=no"), "");
  assert.match(await git(root, "stash", "list"), /pi-r: tracked changes before workbench start/);
  assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "preserve me\n");
  assert.deepEqual(h.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "r_contract_propose"]);
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].customType, "pi-r-workbench-state");
  assert.equal(h.appended[0].data.phase, "design");
  assert.deepEqual(h.appended[0].data.readOnlyRoots, [await realpath(attached)]);
  assert.match(ctx.widgets.at(-1)[1][0], /phase=design .*branch=pi-r\/workbench@[0-9a-f]{7,}/);
  assert.match(ctx.widgets.at(-1)[1][0], /contract=missing policy=pi-r-policy-v1 scopes=0 approval=none worker=stopped/);

  await h.handlers.get("session_shutdown")({ reason: "new" }, ctx);
  assert.deepEqual(h.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "bash", "edit", "write"]);
});

test("/r start rejects a Git repository without HEAD and stays inactive", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-r-headless-"));
  await git(root, "init", "-q");
  const h = harness();
  const ctx = context(root);

  await h.commands[0].options.handler("start", ctx);

  assert.equal(h.appended.length, 0);
  assert.equal(h.activeToolChanges.length, 0);
  assert.match(ctx.notifications.at(-1)[0], /pi-r start failed/i);
  assert.equal(ctx.notifications.at(-1)[1], "error");
});

test("design mode gates model tools to reads inside approved roots", async () => {
  const root = await repository();
  const attached = await mkdtemp(join(tmpdir(), "pi-r-attached-"));
  await writeFile(join(attached, "notes.txt"), "read only\n");
  const outside = await mkdtemp(join(tmpdir(), "pi-r-outside-"));
  await writeFile(join(outside, "secret.txt"), "no\n");
  const h = harness();
  const ctx = context(root);
  await h.commands[0].options.handler(`start ${attached}`, ctx);
  const gate = h.handlers.get("tool_call");

  assert.equal(await gate({ toolName: "read", input: { path: join(root, "analysis.R") } }, ctx), undefined);
  assert.equal(await gate({ toolName: "grep", input: { pattern: "read", path: attached } }, ctx), undefined);
  assert.equal((await gate({ toolName: "read", input: { path: join(outside, "secret.txt") } }, ctx)).block, true);
  assert.equal((await gate({ toolName: "bash", input: { command: "pwd" } }, ctx)).block, true);
  assert.equal((await gate({ toolName: "write", input: { path: join(root, "x") } }, ctx)).block, true);
});

test("typed proposals preserve one ignored draft and /r lock commits the reviewed scaffold atomically", async () => {
  const root = await repository();
  const h = harness();
  const ctx = context(root, [], [false, true]);
  await h.commands[0].options.handler("start", ctx);
  const proposal = h.tools.find((tool) => tool.name === "r_contract_propose");
  assert.ok(proposal);
  const contract = await fixtureContract();
  const proposed = await proposal.execute("proposal-1", contract, undefined, undefined, ctx);

  assert.match(proposed.content[0].text, /Functions and signatures[\s\S]*Target graph/);
  assert.equal(await git(root, "check-ignore", ".pi/tmp/pi-r-contract-draft.json"), ".pi/tmp/pi-r-contract-draft.json");
  assert.equal(await git(root, "status", "--porcelain"), "");
  const draftBeforeInvalid = await readFile(join(root, ".pi/tmp/pi-r-contract-draft.json"), "utf8");
  const invalid = structuredClone(contract);
  invalid.targets[0].function = "not_approved";
  await assert.rejects(
    proposal.execute("proposal-2", invalid, undefined, undefined, ctx),
    /proposal rejected.*unapproved function/i,
  );
  assert.equal(await readFile(join(root, ".pi/tmp/pi-r-contract-draft.json"), "utf8"), draftBeforeInvalid);

  const headBefore = await git(root, "rev-parse", "HEAD");
  await h.commands[0].options.handler("lock", ctx);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
  assert.equal(await readFile(join(root, "analysis.R"), "utf8"), "value <- 1\n");
  assert.match(ctx.notifications.at(-1)[0], /cancelled.*draft preserved/i);

  await h.commands[0].options.handler("lock", ctx);
  assert.notEqual(await git(root, "rev-parse", "HEAD"), headBefore);
  assert.equal(await git(root, "rev-list", "--count", `${headBefore}..HEAD`), "1");
  assert.match(await git(root, "log", "-1", "--format=%B"), /Lock pi-r project contract[\s\S]*Contract-Hash: sha256:/);
  assert.equal(JSON.parse(await readFile(join(root, "pi-r.yml"), "utf8")).contractVersion, 1);
  assert.match(await readFile(join(root, "_targets.R"), "utf8"), /tar_target/);
  assert.match(ctx.confirmationRequests[0][1], /Functions and signatures[\s\S]*Constants[\s\S]*Dependencies[\s\S]*Target graph[\s\S]*Generated-source diff[\s\S]*diff --pi-r/);
  assert.equal(h.appended.at(-1).data.phase, "implementation");
  assert.equal(h.appended.at(-1).data.editableScopeCount, contract.functions.length);
  assert.deepEqual(h.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "r_function_inspect", "r_function_edit"]);
  assert.equal(await git(root, "status", "--porcelain"), "");
});

test("implementation mode commits only validated Approved Function body edits", async () => {
  const root = await repository();
  const h = harness();
  const ctx = context(root, [], [true]);
  await h.commands[0].options.handler("start", ctx);
  const contract = await fixtureContract();
  await h.tools.find((tool) => tool.name === "r_contract_propose")
    .execute("proposal", contract, undefined, undefined, ctx);
  await h.commands[0].options.handler("lock", ctx);
  const inspectTool = h.tools.find((tool) => tool.name === "r_function_inspect");
  const editTool = h.tools.find((tool) => tool.name === "r_function_edit");
  assert.ok(inspectTool, "Implementation Mode must expose Approved Function inspection");
  assert.ok(editTool, "Implementation Mode must expose its scoped body editing capability");
  const path = join(root, "R/load_input.R");
  const inspected = await inspectTool.execute("inspect-1", { function: "load_input" }, undefined, undefined, ctx);
  assert.match(inspected.content[0].text, /load_input <- function\(path\)[\s\S]*Source-Hash: sha256:/);
  const headBefore = await git(root, "rev-parse", "HEAD");

  const result = await editTool.execute("edit-1", {
    function: "load_input",
    expectedSourceHash: inspected.details.sourceHash,
    operation: {
      kind: "replace",
      body: "{\n  identity_local <- function(value) value\n  lapply(list(path), function(item) identity_local(item))[[1]]\n}",
    },
  }, undefined, undefined, ctx);

  assert.equal(await git(root, "rev-list", "--count", `${headBefore}..HEAD`), "1");
  const committed = await readFile(path, "utf8");
  assert.match(committed, /^load_input <- function\(path\)/);
  assert.match(committed, /identity_local <- function/);
  assert.match(committed, /function\(item\)/);
  assert.match(result.content[0].text, /Formatted diff[\s\S]*Commit: [0-9a-f]{40}/);
  assert.equal(result.details.commitHash, await git(root, "rev-parse", "HEAD"));
  assert.equal(h.appended.at(-1).data.head, result.details.commitHash);
  assert.match(
    await git(root, "log", "-1", "--format=%B"),
    /Capability: r-function-body-edit-v1[\s\S]*Contract-Version: 1[\s\S]*Policy-Version: pi-r-policy-v1/,
  );
  assert.deepEqual(h.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "r_function_inspect", "r_function_edit"]);
  const gate = h.handlers.get("tool_call");
  assert.equal((await gate({ toolName: "bash", input: { command: "true" } }, ctx)).block, true);
  assert.equal((await gate({ toolName: "write", input: { path } }, ctx)).block, true);

  const patchInspection = await inspectTool.execute("inspect-2", { function: "load_input" }, undefined, undefined, ctx);
  const patchHead = await git(root, "rev-parse", "HEAD");
  await editTool.execute("edit-2", {
    function: "load_input",
    expectedSourceHash: patchInspection.details.sourceHash,
    operation: { kind: "patch", oldText: "identity_local(item)", newText: "toupper(identity_local(item))" },
  }, undefined, undefined, ctx);
  assert.equal(await git(root, "rev-list", "--count", `${patchHead}..HEAD`), "1");
  assert.match(await readFile(path, "utf8"), /toupper\(identity_local\(item\)\)/);
  assert.equal(await git(root, "status", "--porcelain"), "");
});

test("policy, syntax, formatter, stale-content, and scope failures do not mutate or commit", async () => {
  const root = await repository();
  const h = harness();
  const ctx = context(root, [], [true]);
  await h.commands[0].options.handler("start", ctx);
  const contract = await fixtureContract();
  await h.tools.find((tool) => tool.name === "r_contract_propose")
    .execute("proposal", contract, undefined, undefined, ctx);
  await h.commands[0].options.handler("lock", ctx);
  const inspectTool = h.tools.find((tool) => tool.name === "r_function_inspect");
  const editTool = h.tools.find((tool) => tool.name === "r_function_edit");
  const path = join(root, "R/load_input.R");
  const original = await readFile(path, "utf8");
  const digest = (await inspectTool.execute("inspect", { function: "load_input" }, undefined, undefined, ctx)).details.sourceHash;
  const head = await git(root, "rev-parse", "HEAD");
  const forbiddenBodies = [
    ["library(pkg)", /POLICY_VIOLATION.*library/],
    ["install.packages(\"pkg\")", /POLICY_VIOLATION.*install\.packages/],
    ["source(\"other.R\")", /POLICY_VIOLATION.*source/],
    ["setwd(\"..\")", /POLICY_VIOLATION.*setwd/],
    ["base::mean(1)", /POLICY_VIOLATION.*namespace-operator/],
    ["data.frame(value = 1)", /POLICY_VIOLATION.*data\.frame/],
    ["tibble(value = 1)", /POLICY_VIOLATION.*tibble/],
    ["as.data.frame(list(value = 1))", /POLICY_VIOLATION.*as\.data\.frame/],
    ["do.call(\"library\", list(\"pkg\"))", /POLICY_VIOLATION.*do\.call/],
    ["loader <- library\nloader(\"pkg\")", /POLICY_VIOLATION.*library/],
  ];
  for (const [expression, expected] of forbiddenBodies) {
    await assert.rejects(editTool.execute("forbidden", {
      function: "load_input",
      expectedSourceHash: digest,
      operation: { kind: "replace", body: `{\n${expression}\n}` },
    }, undefined, undefined, ctx), expected);
  }
  await assert.rejects(editTool.execute("stale", {
    function: "load_input",
    expectedSourceHash: `sha256:${"0".repeat(64)}`,
    operation: { kind: "replace", body: "{\npath\n}" },
  }, undefined, undefined, ctx), /STALE_CONTENT/);
  await assert.rejects(editTool.execute("scope", {
    function: "not_approved",
    expectedSourceHash: digest,
    operation: { kind: "replace", body: "{\nNULL\n}" },
  }, undefined, undefined, ctx), /SCOPE_VIOLATION/);
  await assert.rejects(editTool.execute("syntax", {
    function: "load_input",
    expectedSourceHash: digest,
    operation: { kind: "replace", body: "{\nif (\n}" },
  }, undefined, undefined, ctx), /INVALID_R_SYNTAX/);
  const formatter = process.env.PI_R_FORMATTER_SCRIPT;
  process.env.PI_R_FORMATTER_SCRIPT = join(root, "missing-formatter.R");
  try {
    await assert.rejects(editTool.execute("formatter", {
      function: "load_input",
      expectedSourceHash: digest,
      operation: { kind: "replace", body: "{\npath\n}" },
    }, undefined, undefined, ctx), /FORMATTER_FAILURE/);
  } finally {
    process.env.PI_R_FORMATTER_SCRIPT = formatter;
  }

  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await git(root, "status", "--porcelain"), "");
});

test("persisted workbench state resumes only when project and branch still match", async () => {
  const root = await repository();
  const first = harness();
  const firstContext = context(root);
  await first.commands[0].options.handler("start", firstContext);
  const entries = structuredClone(first.appended);
  entries[0].data.allowedTools = ["bash"];

  const resumed = harness(entries);
  const resumedContext = context(root, entries);
  await resumed.handlers.get("session_start")({ reason: "resume" }, resumedContext);
  assert.deepEqual(resumed.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "r_contract_propose"]);
  await resumed.commands[0].options.handler("status", resumedContext);
  assert.match(resumedContext.notifications.at(-1)[0], /phase=design .*branch=pi-r\/workbench@/);

  await git(root, "switch", "-qc", "other-branch");
  const mismatched = harness(entries);
  const mismatchContext = context(root, entries);
  await mismatched.handlers.get("session_start")({ reason: "resume" }, mismatchContext);
  assert.deepEqual(mismatched.activeToolChanges.at(-1), []);
  assert.match(mismatchContext.notifications.at(-1)[0], /cannot resume.*branch/i);
});

test("inactive extension exposes only /r and adds no model context or policy tools", async () => {
  const root = await repository();
  const h = harness();
  const ctx = context(root);
  await h.handlers.get("session_start")({ reason: "startup" }, ctx);
  await h.commands[0].options.handler("status", ctx);

  assert.equal(h.commands.length, 1);
  assert.equal(h.tools.length, 0);
  assert.equal(h.activeToolChanges.length, 0);
  assert.deepEqual(ctx.notifications.at(-1), ["pi-r workbench is not active", "info"]);
  const beforeAgent = await h.handlers.get("before_agent_start")({ systemPrompt: "ordinary" }, ctx);
  assert.equal(beforeAgent, undefined);
});
