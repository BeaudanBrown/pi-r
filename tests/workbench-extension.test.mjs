import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

function proposalForContract(contract) {
  const {
    contractVersion: _contractVersion,
    templateVersion: _templateVersion,
    policyVersion: _policyVersion,
    ...withoutVersions
  } = contract;
  return { ...withoutVersions, project: { name: contract.project.name } };
}

async function targetOperationsContract() {
  const contract = await fixtureContract();
  return {
    ...contract,
    dependencies: [],
    deliverables: [{ target: "answer", path: "artifacts/answer.txt" }],
    constants: { seed: 41, output_path: "artifacts/answer.txt", source_path: "analysis.R" },
    functions: [
      { name: "write_answer", parameters: ["seed", "output_path"] },
      { name: "fail_target", parameters: ["answer", "source_path"] },
    ],
    targets: [
      {
        name: "answer",
        function: "write_answer",
        artifact: "file",
        arguments: { seed: { constant: "seed" } },
        output: { parameter: "output_path", constant: "output_path" },
      },
      {
        name: "broken",
        function: "fail_target",
        artifact: "object",
        arguments: { answer: { target: "answer" }, source_path: { constant: "source_path" } },
      },
    ],
  };
}

async function tableArtifactProject() {
  const root = await repository();
  const contract = await fixtureContract();
  const tableContract = {
    ...contract,
    dependencies: ["data.table"],
    constants: { seed: 10 },
    functions: [
      { name: "make_table", parameters: ["seed"] },
      { name: "make_object", parameters: ["seed"] },
    ],
    targets: [
      {
        name: "sample_table",
        function: "make_table",
        artifact: "table",
        arguments: { seed: { constant: "seed" } },
      },
      {
        name: "sample_object",
        function: "make_object",
        artifact: "object",
        arguments: { seed: { constant: "seed" } },
      },
    ],
  };
  const staging = await mkdtemp(join(tmpdir(), "pi-r-table-project-"));
  const contractPath = join(staging, "contract.json");
  const generated = join(staging, "generated");
  await writeFile(contractPath, `${JSON.stringify(tableContract, null, 2)}\n`);
  await execFileAsync(cli, ["contract", "generate", contractPath, generated]);
  await execFileAsync("cp", ["-R", `${generated}/.`, root]);
  await writeFile(join(root, "R/make_table.R"), [
    "make_table <- function(seed) {",
    "  result <- data.table(value = c(seed, seed + 1L), group = c('a', 'b'))",
    "  setkey(result, value)",
    "  result",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(root, "R/make_object.R"), [
    "make_object <- function(seed) {",
    "  list(value = seed, label = 'bounded')",
    "}",
    "",
  ].join("\n"));
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "add table artifact fixture");
  await git(root, "switch", "-qc", "pi-r/workbench");
  await execFileAsync(process.env.PI_R_WORKER_RSCRIPT, ["--vanilla", "-e", "targets::tar_make(reporter = 'silent', callr_function = NULL)"], { cwd: root, timeout: 30_000 });
  const head = await git(root, "rev-parse", "HEAD");
  const state = {
    version: 1,
    phase: "implementation",
    projectRoot: root,
    workingDirectory: root,
    branch: "pi-r/workbench",
    head,
    contractState: "present",
    policyState: "pi-r-policy-v1",
    editableScopeCount: 2,
    pendingApproval: "none",
    workerState: "stopped",
    readOnlyRoots: [],
    allowedTools: [],
  };
  return { root, tableContract, entries: [{ type: "custom", customType: "pi-r-workbench-state", data: state }] };
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

function schemaPatterns(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (typeof value.pattern === "string") output.push(value.pattern);
  for (const child of Object.values(value)) schemaPatterns(child, output);
  return output;
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
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].customType, "pi-r-workbench-state");
  assert.equal(h.appended[0].data.phase, "design");
  assert.deepEqual(h.appended[0].data.readOnlyRoots, [await realpath(attached)]);
  assert.deepEqual(h.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "r_contract_propose", "evaluate_r", "r_worker_status", "r_worker_reset"]);
  const patterns = h.tools.flatMap((tool) => schemaPatterns(tool.parameters));
  assert.ok(patterns.length > 0);
  assert.equal(patterns.every((pattern) => pattern.startsWith("^") && pattern.endsWith("$")), true, `local llama.cpp requires anchored JSON Schema patterns: ${patterns.join(", ")}`);
  const skillPath = join(process.env.PI_R_RESOURCE_ROOT, "skills/pi-r/SKILL.md");
  assert.equal(await h.handlers.get("tool_call")({ toolName: "read", input: { path: skillPath } }, ctx), undefined);
  assert.equal(
    await h.handlers.get("tool_call")({ toolName: "read", input: { path: join(process.env.PI_R_RESOURCE_ROOT, "skills/pi-r/references/workbench.md") } }, ctx),
    undefined,
  );
  assert.deepEqual(
    await h.handlers.get("tool_call")({ toolName: "read", input: { path: join(process.env.PI_R_RESOURCE_ROOT, "extensions/pi-r.ts") } }, ctx),
    { block: true, reason: "pi-r read path is outside approved read-only roots" },
  );
  assert.match(ctx.widgets.at(-1)[1][0], /phase=design .*branch=pi-r\/workbench@[0-9a-f]{7,}/);
  assert.match(ctx.widgets.at(-1)[1][0], /contract=missing policy=pi-r-policy-v1 scopes=0 approval=none worker=stopped/);

  await h.commands[0].options.handler("stop", ctx);
  assert.deepEqual(h.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.deepEqual(h.appended.at(-1).data, { inactive: true });
  assert.match(ctx.notifications.at(-1)[0], /deactivated.*restored/i);

  const resumed = harness();
  const resumedContext = context(root, h.appended);
  await resumed.handlers.get("session_start")({}, resumedContext);
  assert.equal(resumed.activeToolChanges.length, 0, "an explicit stop marker must prevent later session resume");
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

test("active workbench projects one replaceable live-state snapshot into agent context", async () => {
  const root = await repository();
  const h = harness();
  const ctx = context(root);
  const projectContext = h.handlers.get("context");

  assert.equal(await projectContext({ messages: [{ role: "user", content: "inactive" }] }, ctx), undefined);
  await h.commands[0].options.handler("start", ctx);

  const original = [{ role: "user", content: "inspect state" }];
  const first = await projectContext({ messages: original }, ctx);
  assert.equal(first.messages.length, 2);
  assert.deepEqual(first.messages[0], original[0]);
  assert.equal(first.messages[1].role, "custom");
  assert.equal(first.messages[1].customType, "pi-r-live-state");
  assert.equal(first.messages[1].display, false);
  const snapshot = JSON.parse(first.messages[1].content);
  assert.equal(snapshot.phase, "design");
  assert.equal(snapshot.branch, "pi-r/workbench");
  assert.equal(snapshot.worker.state, "stopped");
  assert.equal(snapshot.environment.identity, "design:bundled");
  assert.deepEqual(snapshot.objects, []);
  assert.ok(first.messages[1].content.length <= 4096);

  const replaced = await projectContext({ messages: first.messages }, ctx);
  assert.equal(replaced.messages.filter((message) => message.customType === "pi-r-live-state").length, 1);
  assert.equal(h.appended.filter((entry) => entry.customType === "pi-r-live-state").length, 0);
});

test("design mode lazily evaluates structured R calls in one persistent sandbox", { timeout: 30_000 }, async (t) => {
  const root = await repository();
  const h = harness();
  const ctx = context(root);
  t.after(async () => h.handlers.get("session_shutdown")({ reason: "test-complete" }, ctx));
  await h.commands[0].options.handler("start", ctx);
  const evaluate = h.tools.find((tool) => tool.name === "evaluate_r");
  assert.ok(evaluate, "Design Mode must expose structured R evaluation");

  const first = await evaluate.execute("evaluate-1", {
    code: "message('hello')\nwarning('careful')\nx <- 41L\nx + 1L",
    targets: [],
  }, undefined, undefined, ctx);
  assert.equal(first.details.value, 42);
  assert.match(first.details.preview, /42/);
  assert.deepEqual(first.details.messages, ["hello"]);
  assert.deepEqual(first.details.warnings, ["careful"]);
  assert.equal(first.details.error, null);
  assert.equal(first.details.worker.started, true);
  assert.equal(first.details.worker.environment, "design");
  assert.doesNotMatch(first.content[0].text, /"objects"/);
  const liveAfterFirst = await h.handlers.get("context")({ messages: [] }, ctx);
  const firstSnapshot = JSON.parse(liveAfterFirst.messages[0].content);
  assert.equal(firstSnapshot.worker.state, "running");
  assert.equal(firstSnapshot.worker.transientStateLost, false);
  const x = firstSnapshot.objects.find((object) => object.name === "x");
  assert.equal(x.name, "x");
  assert.equal(x.origin, "temporary");
  assert.deepEqual(x.class, ["integer"]);
  assert.ok(x.bytes > 0);

  const second = await evaluate.execute("evaluate-2", {
    code: "x + 2L",
    targets: [],
  }, undefined, undefined, ctx);
  assert.equal(second.details.error, null);
  assert.equal(second.details.value, 43);
  assert.equal(second.details.worker.started, false);
  assert.match(ctx.widgets.at(-1)[1][0], /worker=running/);

  await evaluate.execute("bounded-live-state", {
    code: Array.from({ length: 60 }, (_, index) => `object_${index + 1} <- ${index + 1}L`).join("\n"),
    targets: [],
  }, undefined, undefined, ctx);
  const boundedMessage = (await h.handlers.get("context")({ messages: [] }, ctx)).messages[0];
  const boundedSnapshot = JSON.parse(boundedMessage.content);
  assert.equal(boundedSnapshot.objectCount, 61);
  assert.equal(boundedSnapshot.objectsTruncated, true);
  assert.ok(boundedSnapshot.objects.length <= 50);
  assert.ok(boundedMessage.content.length <= 4096);
});

test("the worker can write temporary storage but cannot mutate project or attached source", { timeout: 30_000 }, async (t) => {
  const root = await repository();
  const attached = await mkdtemp(join(tmpdir(), "pi-r-worker-input-"));
  await writeFile(join(attached, "input.txt"), "attached input\n");
  const h = harness();
  const ctx = context(root);
  t.after(async () => h.handlers.get("session_shutdown")({ reason: "test-complete" }, ctx));
  await h.commands[0].options.handler(`start ${attached}`, ctx);
  const evaluate = h.tools.find((tool) => tool.name === "evaluate_r");

  const readable = await evaluate.execute("read-attached", {
    code: `readLines(${JSON.stringify(join(attached, "input.txt"))})`,
    targets: [],
  }, undefined, undefined, ctx);
  assert.equal(readable.details.value, "attached input");
  const temporary = await evaluate.execute("write-temp", {
    code: "path <- tempfile(); writeLines('temporary', path); readLines(path)",
    targets: [],
  }, undefined, undefined, ctx);
  assert.equal(temporary.details.value, "temporary");
  const blocked = await evaluate.execute("write-source", {
    code: "writeLines('mutated', 'analysis.R')",
    targets: [],
  }, undefined, undefined, ctx);
  assert.equal(blocked.details.error.code, "R_EVALUATION_ERROR");
  assert.match(blocked.details.error.message, /cannot open|read-only/i);
  assert.equal(await readFile(join(root, "analysis.R"), "utf8"), "value <- 1\n");
});

test("worker status, reset, and crash recovery report transient state loss", { timeout: 30_000 }, async (t) => {
  const root = await repository();
  const h = harness();
  const ctx = context(root);
  t.after(async () => h.handlers.get("session_shutdown")({ reason: "test-complete" }, ctx));
  await h.commands[0].options.handler("start", ctx);
  const evaluate = h.tools.find((tool) => tool.name === "evaluate_r");
  const status = h.tools.find((tool) => tool.name === "r_worker_status");
  const reset = h.tools.find((tool) => tool.name === "r_worker_reset");
  await evaluate.execute("assign", { code: "temporary_object <- rep(1L, 100L)", targets: [] }, undefined, undefined, ctx);

  const running = await status.execute("status", {}, undefined, undefined, ctx);
  const object = running.details.objects.find((candidate) => candidate.name === "temporary_object");
  assert.equal(running.details.state, "running");
  assert.equal(object.origin, "temporary");
  assert.ok(object.bytes > 0);
  await h.commands[0].options.handler("status", ctx);
  assert.match(ctx.notifications.at(-1)[0], /objects=temporary_object~[0-9]+B/);
  const cleared = await reset.execute("reset", {}, undefined, undefined, ctx);
  assert.ok(cleared.details.lostObjects >= 1);
  assert.match(cleared.content[0].text, /transientStateLost.*true/);
  assert.equal((await status.execute("stopped", {}, undefined, undefined, ctx)).details.state, "stopped");
  const resetSnapshot = JSON.parse((await h.handlers.get("context")({ messages: [] }, ctx)).messages[0].content);
  assert.equal(resetSnapshot.worker.state, "stopped");
  assert.equal(resetSnapshot.worker.transientStateLost, true);
  assert.equal(resetSnapshot.worker.targetsCache, "preserved");
  assert.deepEqual(resetSnapshot.objects, []);

  await assert.rejects(
    evaluate.execute("crash", { code: "quit(save = 'no', status = 17L)", targets: [] }, undefined, undefined, ctx),
    /WORKER_CRASH.*transient state was lost/i,
  );
  const recovered = await evaluate.execute("recover", { code: "1L", targets: [] }, undefined, undefined, ctx);
  assert.equal(recovered.details.value, 1);
  assert.equal(recovered.details.worker.started, true);
  assert.equal(recovered.details.worker.transientStateLost, true);
  const recoveredSnapshot = JSON.parse((await h.handlers.get("context")({ messages: [] }, ctx)).messages[0].content);
  assert.equal(recoveredSnapshot.worker.state, "running");
  assert.equal(recoveredSnapshot.worker.transientStateLost, true);
  assert.deepEqual(recoveredSnapshot.objects, []);
});

test("typed proposals preserve one ignored draft and /r lock commits the reviewed scaffold atomically", async () => {
  const root = await repository();
  const h = harness();
  const ctx = context(root, [], [false, true]);
  await h.commands[0].options.handler("start", ctx);
  const proposal = h.tools.find((tool) => tool.name === "r_contract_propose");
  assert.ok(proposal);
  const contract = await fixtureContract();
  const proposalInput = proposalForContract((contract));
  const proposed = await proposal.execute("proposal-1", proposalInput, undefined, undefined, ctx);

  assert.match(proposed.content[0].text, /Functions and signatures[\s\S]*Target graph/);
  assert.equal(await git(root, "check-ignore", ".pi/tmp/pi-r-contract-draft.json"), ".pi/tmp/pi-r-contract-draft.json");
  assert.equal(await git(root, "status", "--porcelain"), "");
  const draftBeforeInvalid = await readFile(join(root, ".pi/tmp/pi-r-contract-draft.json"), "utf8");
  const draftContract = JSON.parse(draftBeforeInvalid);
  assert.deepEqual(draftContract.project.nixpkgs, JSON.parse(await readFile(process.env.PI_R_NIXPKGS_PIN_PATH, "utf8")));
  await assert.rejects(
    proposal.execute("proposal-authority", { ...proposalInput, policyVersion: "pi-r-policy-v999" }, undefined, undefined, ctx),
    /proposal rejected.*unknown fields/i,
  );
  const invalid = structuredClone(proposalInput);
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
  assert.deepEqual(h.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "r_function_inspect", "r_function_edit", "evaluate_r", "r_worker_status", "r_worker_reset", "r_targets_list", "r_targets_run", "r_target_workspace", "r_artifact_inspect", "r_dependency_propose", "r_dependency_scout"]);
  assert.equal(await git(root, "status", "--porcelain"), "");
});

test("evaluate_r loads only explicitly requested targets under canonical names", { timeout: 60_000 }, async (t) => {
  const root = await repository();
  await writeFile(join(root, "_targets.R"), [
    "library(targets)",
    "global_value <- 7L",
    "list(tar_target(sample_target, global_value * 6L, format = 'qs'))",
    "",
  ].join("\n"));
  await git(root, "add", "_targets.R");
  await git(root, "commit", "-qm", "add target fixture");
  await execFileAsync(process.env.PI_R_WORKER_RSCRIPT, [
    "--vanilla", "-e", "targets::tar_make(reporter = 'silent')",
  ], { cwd: root, timeout: 30_000 });
  const h = harness();
  const ctx = context(root);
  t.after(async () => h.handlers.get("session_shutdown")({ reason: "test-complete" }, ctx));
  await h.commands[0].options.handler("start", ctx);
  const evaluate = h.tools.find((tool) => tool.name === "evaluate_r");

  const loaded = await evaluate.execute("load-target", { code: "sample_target", targets: ["sample_target"] }, undefined, undefined, ctx);
  assert.equal(loaded.details.error, null);
  assert.equal(loaded.details.value, 42);
  assert.ok(loaded.details.objects.some((object) => object.name === "sample_target" && object.origin === "target"));
  const loadedSnapshot = JSON.parse((await h.handlers.get("context")({ messages: [] }, ctx)).messages[0].content);
  assert.equal(loadedSnapshot.objects.find((object) => object.name === "sample_target").origin, "target");
  const unloaded = await evaluate.execute("omit-target", {
    code: "exists('sample_target', inherits = TRUE)",
    targets: [],
  }, undefined, undefined, ctx);
  assert.equal(unloaded.details.value, false);
  assert.ok(unloaded.details.objects.some((object) => object.name === "global_value" && object.origin === "global"));
  const unloadedSnapshot = JSON.parse((await h.handlers.get("context")({ messages: [] }, ctx)).messages[0].content);
  assert.equal(unloadedSnapshot.objects.some((object) => object.name === "sample_target"), false);
  assert.equal(unloadedSnapshot.objects.find((object) => object.name === "global_value").origin, "global");
});

test("locking restarts exploration in the generated environment with canonical globals and constants", { timeout: 180_000 }, async (t) => {
  const root = await repository();
  const h = harness();
  const ctx = context(root, [], [true]);
  t.after(async () => h.handlers.get("session_shutdown")({ reason: "test-complete" }, ctx));
  await h.commands[0].options.handler("start", ctx);
  const evaluate = h.tools.find((tool) => tool.name === "evaluate_r");
  await evaluate.execute("design-state", { code: "design_only <- 99L", targets: [] }, undefined, undefined, ctx);
  const contract = await fixtureContract();
  await h.tools.find((tool) => tool.name === "r_contract_propose").execute("proposal", proposalForContract((contract)), undefined, undefined, ctx);
  await h.commands[0].options.handler("lock", ctx);
  const lockSnapshot = JSON.parse((await h.handlers.get("context")({ messages: [] }, ctx)).messages[0].content);
  assert.equal(lockSnapshot.phase, "implementation");
  assert.equal(lockSnapshot.environment.identity.startsWith("project:"), true);
  assert.notEqual(lockSnapshot.environment.identity, "project:generated");
  assert.equal(lockSnapshot.worker.state, "stopped");
  assert.equal(lockSnapshot.worker.transientStateLost, true);
  assert.equal(lockSnapshot.transition, "contract-locked");
  assert.deepEqual(lockSnapshot.objects, []);

  const inspectTool = h.tools.find((tool) => tool.name === "r_function_inspect");
  const editTool = h.tools.find((tool) => tool.name === "r_function_edit");
  const inspected = await inspectTool.execute("inspect-load", { function: "load_input" }, undefined, undefined, ctx);
  await editTool.execute("implement-load", {
    function: "load_input",
    expectedSourceHash: inspected.details.sourceHash,
    operation: { kind: "replace", body: "{\npath\n}" },
  }, undefined, undefined, ctx);
  const loaded = await evaluate.execute("project-state", {
    code: "stopifnot(is.function(load_input), is.function(data.table), !exists('design_only')); input_path",
    targets: [],
  }, undefined, undefined, ctx);
  assert.equal(loaded.details.error, null);
  assert.equal(loaded.details.value, "data/input.qs");
  assert.equal(loaded.details.worker.environment, "project");
  assert.equal(loaded.details.worker.started, true);
  assert.ok(loaded.details.objects.some((object) => object.name === "input_path" && object.origin === "global"));
  assert.ok(loaded.details.objects.some((object) => object.name === "load_input" && object.origin === "global"));
});

test("governed dependency proposals validate before one approved environment commit", { timeout: 240_000 }, async (t) => {
  const root = await repository();
  const confirmations = [true, false, true];
  const h = harness();
  const ctx = context(root, [], confirmations);
  t.after(async () => h.handlers.get("session_shutdown")({ reason: "test-complete" }, ctx));
  await h.commands[0].options.handler("start", ctx);
  const contract = await fixtureContract();
  await h.tools.find((tool) => tool.name === "r_contract_propose").execute("proposal", proposalForContract((contract)), undefined, undefined, ctx);
  await h.commands[0].options.handler("lock", ctx);

  const dependency = h.tools.find((tool) => tool.name === "r_dependency_propose");
  assert.ok(dependency, "Implementation Mode must expose governed dependency proposals");
  const evaluate = h.tools.find((tool) => tool.name === "evaluate_r");
  await evaluate.execute("retain-until-approval", { code: "temporary_before_environment <- 1L", targets: [] }, undefined, undefined, ctx);
  const initialHead = await git(root, "rev-parse", "HEAD");
  const initialContract = await readFile(join(root, "pi-r.yml"), "utf8");

  const fakeScoutDirectory = await mkdtemp(join(tmpdir(), "pi-r-fake-scout-"));
  const fakeScout = join(fakeScoutDirectory, "scout.mjs");
  await writeFile(fakeScout, `#!/usr/bin/env node
import { readdirSync } from "node:fs";
const args = process.argv.slice(2);
const required = ["--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools"];
if (required.some((flag) => !args.includes(flag)) || readdirSync(".").length !== 0) { console.error(JSON.stringify({ args, cwd: process.cwd(), files: readdirSync(".") })); process.exit(17); }
const prompt = args.at(-1);
const request = JSON.parse(prompt.slice(prompt.indexOf("\\n") + 1));
if (Object.keys(request).sort().join(",") !== "candidateHints,constraints,requirement,technologyPolicy" || !request.technologyPolicy.packages.some((entry) => entry.package === "dplyr" && entry.status === "prohibited")) { console.error(JSON.stringify(request)); process.exit(18); }
const evidence = (name) => [{ source: "official-registry", url: "https://cran.r-project.org/package=" + name, title: "CRAN " + name, claim: "Registry metadata for " + name }];
const report = {
  candidates: [
    { identifier: "yaml", summary: "Parse a portable configuration document", evidence: evidence("yaml"), compatibility: ["R on Linux"], unresolvedQuestions: ["Confirm table conversion semantics"] },
    { identifier: "dplyr", summary: "Alternative table grammar", evidence: evidence("dplyr"), compatibility: ["R on Linux"], unresolvedQuestions: [] },
    { identifier: "data.tabel", summary: "Possible spelling supplied by research", evidence: evidence("data.table"), compatibility: [], unresolvedQuestions: ["Confirm canonical identifier"] }
  ],
  unresolvedQuestions: ["Which configuration shape is required?"]
};
console.log(JSON.stringify({ type: "tool_result_end", message: { toolName: "scout_submit", details: { kind: "pi-r-dependency-scout-v1", report } } }));
`);
  await chmod(fakeScout, 0o700);
  const previousScout = process.env.PI_R_SCOUT_PI;
  const previousScoutEntry = process.env.PI_R_SCOUT_PI_ENTRY;
  process.env.PI_R_SCOUT_PI = process.execPath;
  process.env.PI_R_SCOUT_PI_ENTRY = fakeScout;
  t.after(async () => {
    if (previousScout === undefined) delete process.env.PI_R_SCOUT_PI;
    else process.env.PI_R_SCOUT_PI = previousScout;
    if (previousScoutEntry === undefined) delete process.env.PI_R_SCOUT_PI_ENTRY;
    else process.env.PI_R_SCOUT_PI_ENTRY = previousScoutEntry;
    await rm(fakeScoutDirectory, { recursive: true, force: true });
  });
  const scout = h.tools.find((tool) => tool.name === "r_dependency_scout");
  assert.ok(scout, "Implementation Mode must expose bounded dependency research");
  const researched = await scout.execute("scout", {
    requirement: "Parse a small portable configuration document into tabular settings",
    domain: "tabular",
    ecosystem: "R",
    platforms: ["x86_64-linux"],
    candidateHints: ["yaml"],
  }, undefined, undefined, ctx);
  assert.equal(researched.details.policyVersion, "pi-r-technology-v1");
  assert.equal(researched.details.candidates.find((candidate) => candidate.identifier === "yaml").selectable, true);
  assert.equal(researched.details.candidates.find((candidate) => candidate.identifier === "dplyr").policy.status, "prohibited");
  assert.equal(researched.details.candidates.find((candidate) => candidate.identifier === "dplyr").selectable, false);
  const typoCandidates = researched.details.candidates.find((candidate) => candidate.identifier === "data.tabel").resolution.candidates;
  assert.equal(typoCandidates[0], "data.table");
  assert.ok(typoCandidates.length <= 5);
  assert.match(researched.content[0].text, /research-only[\s\S]*r_dependency_propose/);
  assert.doesNotMatch(researched.content[0].text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await git(root, "rev-parse", "HEAD"), initialHead);
  assert.equal(await readFile(join(root, "pi-r.yml"), "utf8"), initialContract);
  await assert.rejects(
    scout.execute("unsafe-scout", {
      requirement: "Inspect /home/operator/private.csv to discover a parsing package",
      domain: "tabular",
      ecosystem: "R",
      platforms: ["x86_64-linux"],
    }, undefined, undefined, ctx),
    /UNSAFE_SCOUT_REQUIREMENT/,
  );

  await assert.rejects(
    dependency.execute("unknown", {
      operation: "add",
      package: "data.tabel",
      domain: "tabular",
      rationale: "Misspelled package request",
      scope: "project",
    }, undefined, undefined, ctx),
    /UNKNOWN_PACKAGE.*data\.table/,
  );
  assert.equal(await git(root, "rev-parse", "HEAD"), initialHead);
  assert.equal(await readFile(join(root, "pi-r.yml"), "utf8"), initialContract);
  assert.equal((await h.tools.find((tool) => tool.name === "r_worker_status").execute("after-resolution-failure", {}, undefined, undefined, ctx)).details.state, "running");

  await assert.rejects(
    dependency.execute("required-removal", {
      operation: "remove",
      package: "data.table",
      domain: "tabular",
      rationale: "Attempt to remove the canonical table package",
      scope: "project",
    }, undefined, undefined, ctx),
    /REQUIRED_PACKAGE/,
  );

  await assert.rejects(
    dependency.execute("prohibited", {
      operation: "add",
      package: "dplyr",
      domain: "tabular",
      rationale: "Use an alternate table API",
      scope: "project",
    }, undefined, undefined, ctx),
    /PROHIBITED_PACKAGE.*data\.table/,
  );
  assert.equal(await git(root, "rev-parse", "HEAD"), initialHead);
  assert.equal(await readFile(join(root, "pi-r.yml"), "utf8"), initialContract);

  const projectOnly = await dependency.execute("add-project-package", {
    operation: "add",
    package: "yaml",
    domain: "configuration",
    rationale: "Read an approved project-only configuration format",
    scope: "project",
  }, undefined, undefined, ctx);
  assert.equal(projectOnly.details.policy.status, "allowed");
  assert.equal(projectOnly.details.proposal.scope, "project");
  assert.equal(projectOnly.details.nextContract.dependencyApprovals.yaml.policyStatus, "allowed");
  assert.equal(await git(root, "rev-parse", "HEAD"), initialHead);

  const proposed = await dependency.execute("add-shared-package", {
    operation: "add",
    package: "digest",
    domain: "hashing",
    rationale: "Compute a reusable specialist hash",
    scope: "shared",
  }, undefined, undefined, ctx);
  assert.equal(proposed.details.policy.status, "unregistered");
  assert.equal(proposed.details.proposal.scope, "shared");
  assert.ok(proposed.details.resolvedPackages.some((entry) => entry.name === "digest" && entry.exists && entry.available && !entry.broken));
  assert.equal(proposed.details.nextContract.dependencies.includes("digest"), true);
  assert.equal(await git(root, "rev-parse", "HEAD"), initialHead);
  assert.equal(await readFile(join(root, "pi-r.yml"), "utf8"), initialContract);
  assert.equal((await h.tools.find((tool) => tool.name === "r_worker_status").execute("still-running", {}, undefined, undefined, ctx)).details.state, "running");

  await h.commands[0].options.handler("environment", ctx);
  assert.equal(await git(root, "rev-parse", "HEAD"), initialHead);
  assert.equal((await h.tools.find((tool) => tool.name === "r_worker_status").execute("after-cancel", {}, undefined, undefined, ctx)).details.state, "running");
  assert.match(ctx.notifications.at(-1)[0], /cancelled.*candidate preserved/i);

  await h.commands[0].options.handler("environment", ctx);
  const activatedHead = await git(root, "rev-parse", "HEAD");
  assert.notEqual(activatedHead, initialHead);
  assert.equal(await git(root, "rev-list", "--count", `${initialHead}..HEAD`), "1");
  const activated = JSON.parse(await readFile(join(root, "pi-r.yml"), "utf8"));
  assert.equal(activated.dependencies.includes("digest"), true);
  assert.deepEqual(activated.dependencyApprovals.digest, {
    scope: "shared",
    domain: "hashing",
    rationale: "Compute a reusable specialist hash",
    policyStatus: "unregistered",
  });
  assert.match(await readFile(join(root, "flake.nix"), "utf8"), /rPackages\."digest"/);
  assert.match(await readFile(join(root, "_targets.R"), "utf8"), /"data\.table", "digest"/);
  assert.match(await git(root, "log", "-1", "--format=%B"), /Add governed R dependency digest[\s\S]*Technology-Policy: pi-r-technology-v1[\s\S]*Approval-Scope: shared/);
  const sharedPolicy = JSON.parse(await readFile(process.env.PI_R_SHARED_POLICY_PATH, "utf8"));
  assert.equal(sharedPolicy.packages.digest.status, "allowed");
  assert.deepEqual(sharedPolicy.packages.digest.domains, ["hashing"]);
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=no"), "");

  const live = JSON.parse((await h.handlers.get("context")({ messages: [] }, ctx)).messages[0].content);
  assert.equal(live.environment.identity.startsWith("project:"), true);
  assert.equal(live.worker.state, "stopped");
  assert.equal(live.worker.transientStateLost, true);
  assert.equal(live.worker.targetsCache, "preserved");
  assert.equal(live.transition, "environment-activated");
  assert.deepEqual(live.objects, []);

  const restarted = await evaluate.execute("new-environment", {
    code: "requireNamespace('digest', quietly = TRUE)",
    targets: [],
  }, undefined, undefined, ctx);
  assert.equal(restarted.details.value, true);
  assert.equal(restarted.details.worker.started, true);
  assert.equal(restarted.details.worker.environment, "project");
});

test("implementation mode lists contracted targets with bounded freshness metadata", { timeout: 60_000 }, async (t) => {
  const root = await repository();
  const h = harness();
  const ctx = context(root, [], [true]);
  t.after(async () => h.handlers.get("session_shutdown")({ reason: "test-complete" }, ctx));
  await h.commands[0].options.handler("start", ctx);
  const contract = await fixtureContract();
  await h.tools.find((tool) => tool.name === "r_contract_propose").execute("proposal", proposalForContract((contract)), undefined, undefined, ctx);
  await h.commands[0].options.handler("lock", ctx);

  const listTargets = h.tools.find((tool) => tool.name === "r_targets_list");
  assert.ok(listTargets, "Implementation Mode must expose bounded target listing");
  const listed = await listTargets.execute("list-targets", {}, undefined, undefined, ctx);
  assert.deepEqual(listed.details.targets.map((target) => target.name), contract.targets.map((target) => target.name));
  assert.ok(listed.details.targets.every((target) => ["missing", "outdated", "current", "failed"].includes(target.freshness)));
  assert.deepEqual(
    listed.details.targets.map(({ function: producer, artifact }) => ({ producer, artifact })),
    contract.targets.map((target) => ({ producer: target.function, artifact: target.artifact })),
  );
  assert.ok(listed.content[0].text.length <= 8192);
  assert.match(listed.details.logPath, /[.]pi\/tmp\/pi-r-target-runs\//);
  assert.match(await readFile(listed.details.logPath, "utf8"), /operation=list/);
});

test("target execution requires explicit contracted names and stores complete local logs", { timeout: 90_000 }, async (t) => {
  const root = await repository();
  const h = harness();
  const ctx = context(root, [], [true, false, true]);
  t.after(async () => h.handlers.get("session_shutdown")({ reason: "test-complete" }, ctx));
  await h.commands[0].options.handler("start", ctx);
  const contract = await targetOperationsContract();
  await h.tools.find((tool) => tool.name === "r_contract_propose").execute("proposal", proposalForContract((contract)), undefined, undefined, ctx);
  await h.commands[0].options.handler("lock", ctx);
  const runTargets = h.tools.find((tool) => tool.name === "r_targets_run");
  assert.ok(runTargets, "Implementation Mode must expose controlled target execution");
  const inspectArtifact = h.tools.find((tool) => tool.name === "r_artifact_inspect");
  assert.ok(inspectArtifact, "Implementation Mode must expose general target-backed artifact inspection");
  const missingArtifact = await inspectArtifact.execute("inspect-missing", { target: "answer", facets: ["structure"] }, undefined, undefined, ctx);
  assert.equal(missingArtifact.details.status, "missing");
  assert.equal(missingArtifact.details.error.code, "MISSING_TARGET");
  assert.deepEqual(missingArtifact.details.error.recovery, ["Run r_targets_run for the target"]);

  await assert.rejects(
    runTargets.execute("implicit-all", { names: [], all: false }, undefined, undefined, ctx),
    /TARGET_SELECTION_REQUIRED/,
  );
  await assert.rejects(
    runTargets.execute("unknown", { names: ["not_contracted"], all: false }, undefined, undefined, ctx),
    /UNKNOWN_TARGET.*not_contracted/,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    runTargets.execute("cancelled", { names: ["answer"], all: false }, cancelled.signal, undefined, ctx),
    /TARGET_RUNNER_CANCELLED/,
  );

  for (const [name, body] of [
    ["write_answer", "{\nwriteLines(as.character(seed + 1L), output_path)\noutput_path\n}"],
    ["fail_target", "{\ndiagnostic_value <- readLines(answer)\nwriteLines('mutated', source_path)\ndiagnostic_value\n}"],
  ]) {
    const inspectTool = h.tools.find((tool) => tool.name === "r_function_inspect");
    const editTool = h.tools.find((tool) => tool.name === "r_function_edit");
    const inspected = await inspectTool.execute(`inspect-${name}`, { function: name }, undefined, undefined, ctx);
    await editTool.execute(`edit-${name}`, {
      function: name,
      expectedSourceHash: inspected.details.sourceHash,
      operation: { kind: "replace", body },
    }, undefined, undefined, ctx);
  }

  const head = await git(root, "rev-parse", "HEAD");
  const result = await runTargets.execute("run-answer", { names: ["answer"], all: false }, undefined, undefined, ctx);
  assert.equal(result.details.status, "succeeded", JSON.stringify(result.details));
  assert.deepEqual(result.details.requested, ["answer"]);
  assert.equal(await readFile(join(root, "artifacts/answer.txt"), "utf8"), "42\n");
  assert.match(await readFile(result.details.logPath, "utf8"), /operation=run[\s\S]*answer/);
  const refreshed = await h.tools.find((tool) => tool.name === "r_targets_list")
    .execute("list-after-run", {}, undefined, undefined, ctx);
  assert.equal(refreshed.details.targets.find((target) => target.name === "answer").freshness, "current");
  const inspected = await inspectArtifact.execute("inspect-answer", { target: "answer", facets: ["structure"] }, undefined, undefined, ctx);
  assert.equal(inspected.details.identity.target, "answer");
  assert.equal(inspected.details.kind, "file");
  assert.equal(inspected.details.producer.function, "write_answer");
  assert.equal(inspected.details.status, "current");
  assert.deepEqual(inspected.details.facets, ["structure"]);
  assert.equal(inspected.details.structure.exists, true);
  assert.equal(inspected.details.cache.hit, false);
  assert.equal(inspected.details.error, null);
  assert.ok(inspected.content[0].text.length <= 8192);
  const cached = await inspectArtifact.execute("inspect-answer-cached", { target: "answer", facets: ["structure"] }, undefined, undefined, ctx);
  assert.equal(cached.details.cache.hit, true);
  assert.equal(cached.details.identity.metadataHash, inspected.details.identity.metadataHash);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=no"), "");

  const functionInspection = await h.tools.find((tool) => tool.name === "r_function_inspect")
    .execute("inspect-write-answer-revision", { function: "write_answer" }, undefined, undefined, ctx);
  await h.tools.find((tool) => tool.name === "r_function_edit").execute("revise-write-answer", {
    function: "write_answer",
    expectedSourceHash: functionInspection.details.sourceHash,
    operation: { kind: "replace", body: "{\nwriteLines(as.character(seed + 2L), output_path)\noutput_path\n}" },
  }, undefined, undefined, ctx);
  const revisedHead = await git(root, "rev-parse", "HEAD");
  const staleArtifact = await inspectArtifact.execute("inspect-stale", { target: "answer", facets: ["structure"] }, undefined, undefined, ctx);
  assert.equal(staleArtifact.details.status, "stale");
  assert.equal(staleArtifact.details.error.code, "STALE_TARGET");
  assert.deepEqual(staleArtifact.details.error.recovery, ["Run r_targets_run for the target"]);
  await runTargets.execute("rerun-answer", { names: ["answer"], all: false }, undefined, undefined, ctx);
  assert.equal(await readFile(join(root, "artifacts/answer.txt"), "utf8"), "43\n");
  const invalidated = await inspectArtifact.execute("inspect-invalidated", { target: "answer", facets: ["structure"] }, undefined, undefined, ctx);
  assert.equal(invalidated.details.status, "current");
  assert.equal(invalidated.details.cache.hit, false);
  assert.notEqual(invalidated.details.identity.metadataHash, inspected.details.identity.metadataHash);
  assert.equal(await git(root, "rev-parse", "HEAD"), revisedHead);

  await writeFile(join(root, "artifacts/local-only.txt"), "do not publish\n");
  await h.commands[0].options.handler("publish", ctx);
  assert.equal(await git(root, "rev-parse", "HEAD"), revisedHead);
  assert.match(ctx.notifications.at(-1)[0], /cancelled.*unchanged/i);
  assert.match(ctx.confirmationRequests.at(-1)[1], /added artifacts\/answer\.txt[\s\S]*\+43/);

  await h.commands[0].options.handler("publish", ctx);
  const publicationHead = await git(root, "rev-parse", "HEAD");
  assert.notEqual(publicationHead, revisedHead);
  assert.equal(await git(root, "show", "--name-only", "--format=", "HEAD"), "artifacts/answer.txt");
  assert.match(await git(root, "log", "-1", "--format=%B"), /Publish declared deliverables[\s\S]*Capability: r_deliverable_publish[\s\S]*Deliverables: artifacts\/answer\.txt/);
  assert.equal(await readFile(join(root, "artifacts/local-only.txt"), "utf8"), "do not publish\n");
  assert.match(await git(root, "status", "--porcelain"), /\?\? artifacts\/local-only\.txt/);

  const failed = await runTargets.execute("run-broken", { names: ["broken"], all: false }, undefined, undefined, ctx);
  assert.equal(failed.details.status, "failed");
  assert.equal(failed.details.error.code, "TARGET_RUN_FAILED");
  assert.match(failed.details.error.target, /broken/);
  assert.match(failed.details.error.message, /cannot open|read-only/i);
  assert.ok(failed.details.error.traceback.length <= 2000);
  assert.match(await readFile(failed.details.logPath, "utf8"), /operation=run[\s\S]*broken/);
  assert.equal(await readFile(join(root, "analysis.R"), "utf8"), "value <- 1\n");
  const failedArtifact = await inspectArtifact.execute("inspect-broken", { target: "broken", facets: ["structure"] }, undefined, undefined, ctx);
  assert.equal(failedArtifact.details.status, "failed");
  assert.equal(failedArtifact.details.error.code, "FAILED_TARGET");
  assert.deepEqual(failedArtifact.details.error.recovery, ["Run r_targets_run for the target", "Load its failed workspace with r_target_workspace"]);

  const loadWorkspace = h.tools.find((tool) => tool.name === "r_target_workspace");
  assert.ok(loadWorkspace, "Implementation Mode must expose failed target workspaces to the persistent worker");
  const loaded = await loadWorkspace.execute("workspace", { target: "broken" }, undefined, undefined, ctx);
  assert.equal(loaded.details.target, "broken");
  assert.ok(loaded.details.objects.some((object) => object.name === "answer"), JSON.stringify(loaded.details));
  const evaluated = await h.tools.find((tool) => tool.name === "evaluate_r")
    .execute("diagnose", { code: "readLines(answer)", targets: [] }, undefined, undefined, ctx);
  assert.equal(evaluated.details.value, "43");

  await rm(join(root, "artifacts/answer.txt"));
  await link(join(root, "analysis.R"), join(root, "artifacts/answer.txt"));
  await assert.rejects(
    runTargets.execute("hard-linked-output", { names: ["answer"], all: false }, undefined, undefined, ctx),
    /INVALID_OUTPUT_PATH.*hard link|symbolic or hard link/,
  );
  assert.equal(await readFile(join(root, "analysis.R"), "utf8"), "value <- 1\n");
});

test("table artifact inspection returns structure and summaries without rows and warns on kind mismatch", { timeout: 120_000 }, async (t) => {
  const { root, entries } = await tableArtifactProject();
  const h = harness(entries);
  const ctx = context(root, entries);
  t.after(async () => h.handlers.get("session_shutdown")({ reason: "test-complete" }, ctx));
  await h.handlers.get("session_start")({ reason: "resume" }, ctx);
  const inspectArtifact = h.tools.find((tool) => tool.name === "r_artifact_inspect");
  const inspected = await inspectArtifact.execute("inspect-table", {
    target: "sample_table",
    facets: ["structure", "summary"],
  }, undefined, undefined, ctx);

  assert.equal(inspected.details.status, "current");
  assert.equal(inspected.details.kind, "table");
  assert.deepEqual(inspected.details.structure.dimensions, [2, 2]);
  assert.deepEqual(inspected.details.structure.columns, [
    { name: "value", type: "numeric" },
    { name: "group", type: "character" },
  ]);
  assert.deepEqual(inspected.details.structure.keys, ["value"]);
  assert.deepEqual(inspected.details.summaries[0], {
    name: "value", type: "numeric", missing: 0, minimum: 10, maximum: 11, mean: 10.5,
  });
  assert.equal("rows" in inspected.details.structure, false);
  assert.doesNotMatch(inspected.content[0].text, /\"a\"|\"b\"/);
  assert.deepEqual(inspected.details.warnings, []);
  const object = await inspectArtifact.execute("inspect-object", {
    target: "sample_object",
    facets: ["structure"],
  }, undefined, undefined, ctx);
  assert.equal(object.details.kind, "object");
  assert.deepEqual(object.details.structure.class, ["list"]);
  assert.equal(object.details.structure.length, 2);
  assert.deepEqual(object.details.structure.names, ["value", "label"]);
  assert.equal(JSON.stringify(object.details).includes("bounded"), false);

  const functionTool = h.tools.find((tool) => tool.name === "r_function_inspect");
  const editTool = h.tools.find((tool) => tool.name === "r_function_edit");
  const functionState = await functionTool.execute("inspect-maker", { function: "make_table" }, undefined, undefined, ctx);
  await editTool.execute("replace-maker", {
    function: "make_table",
    expectedSourceHash: functionState.details.sourceHash,
    operation: { kind: "replace", body: "{\nlist(value = c(seed, seed + 1L))\n}" },
  }, undefined, undefined, ctx);
  await h.tools.find((tool) => tool.name === "r_targets_run")
    .execute("rerun-table", { names: ["sample_table"], all: false }, undefined, undefined, ctx);
  const mismatch = await inspectArtifact.execute("inspect-table-mismatch", {
    target: "sample_table",
    facets: ["structure"],
  }, undefined, undefined, ctx);
  assert.equal(mismatch.details.status, "current");
  assert.equal(mismatch.details.error, null);
  assert.deepEqual(mismatch.details.warnings, [{
    code: "DECLARED_TABLE_NOT_DATA_TABLE",
    message: "Declared table target is not a data.table",
    recoverable: true,
  }]);
  const listed = await h.tools.find((tool) => tool.name === "r_targets_list")
    .execute("list-mismatched-table", {}, undefined, undefined, ctx);
  assert.equal(listed.details.targets.find((target) => target.name === "sample_table").freshness, "current");
});

test("implementation mode commits only validated Approved Function body edits", async () => {
  const root = await repository();
  const h = harness();
  const ctx = context(root, [], [true]);
  await h.commands[0].options.handler("start", ctx);
  const contract = await fixtureContract();
  await h.tools.find((tool) => tool.name === "r_contract_propose").execute("proposal", proposalForContract((contract)), undefined, undefined, ctx);
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
  assert.deepEqual(h.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "r_function_inspect", "r_function_edit", "evaluate_r", "r_worker_status", "r_worker_reset", "r_targets_list", "r_targets_run", "r_target_workspace", "r_artifact_inspect", "r_dependency_propose", "r_dependency_scout"]);
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
  await h.tools.find((tool) => tool.name === "r_contract_propose").execute("proposal", proposalForContract((contract)), undefined, undefined, ctx);
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
  assert.deepEqual(resumed.activeToolChanges.at(-1), ["read", "grep", "find", "ls", "r_contract_propose", "evaluate_r", "r_worker_status", "r_worker_reset"]);
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
