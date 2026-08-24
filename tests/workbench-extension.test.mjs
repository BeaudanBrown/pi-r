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
  const handlers = new Map();
  const activeToolChanges = [];
  const appended = [];
  const allTools = ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({
    name,
    sourceInfo: { source: "builtin" },
  }));
  const pi = {
    registerCommand(name, options) { commands.push({ name, options }); },
    registerTool() { throw new Error("workbench extension must not register model tools"); },
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
  return { commands, handlers, activeToolChanges, appended, entries };
}

function context(root, entries = []) {
  const notifications = [];
  const widgets = [];
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
    },
    notifications,
    widgets,
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
  assert.deepEqual(h.activeToolChanges.at(-1), ["read", "grep", "find", "ls"]);
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
  assert.deepEqual(resumed.activeToolChanges.at(-1), ["read", "grep", "find", "ls"]);
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
  assert.equal(h.activeToolChanges.length, 0);
  assert.deepEqual(ctx.notifications.at(-1), ["pi-r workbench is not active", "info"]);
  const beforeAgent = await h.handlers.get("before_agent_start")({ systemPrompt: "ordinary" }, ctx);
  assert.equal(beforeAgent, undefined);
});
