import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const extensionPath = process.env.PI_R_COMPILED_EXTENSION;
if (!extensionPath) {
  throw new Error("PI_R_COMPILED_EXTENSION must point to the compiled extension");
}

test("the Pi extension registers only the inactive /r command", async () => {
  const commands = [];
  const extension = await import(pathToFileURL(extensionPath));
  extension.default({
    registerCommand(name, options) {
      commands.push({ name, options });
    },
    on() {},
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "r");

  const notifications = [];
  await commands[0].options.handler("status", {
    ui: { notify: (...args) => notifications.push(args) },
  });
  assert.deepEqual(notifications, [["pi-r workbench is not active", "info"]]);
});
