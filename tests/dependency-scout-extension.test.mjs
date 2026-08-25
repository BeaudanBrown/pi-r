import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const extensionPath = process.env.PI_R_SCOUT_EXTENSION;
if (!extensionPath) throw new Error("PI_R_SCOUT_EXTENSION is required");
const extension = await import(pathToFileURL(extensionPath));

function harness() {
  const tools = [];
  extension.default({ registerTool(tool) { tools.push(tool); } });
  return tools;
}

test("isolated scout exposes only bounded research and structured submission tools", async () => {
  const tools = harness();
  assert.deepEqual(tools.map((tool) => tool.name), ["scout_http_get", "scout_submit"]);
  const fetchTool = tools[0];
  await assert.rejects(
    fetchTool.execute("private", { url: "https://localhost/private" }),
    /approved public registry/,
  );
  await assert.rejects(
    fetchTool.execute("arbitrary", { url: "https://example.com/package" }),
    /approved public registry/,
  );

  const submit = tools[1];
  await assert.rejects(
    submit.execute("too-many", { candidates: new Array(6).fill({}), unresolvedQuestions: [] }),
    /at most five/,
  );
  const report = {
    candidates: [{
      identifier: "yaml",
      summary: "Parse configuration",
      evidence: [{ source: "official-registry", url: "https://cran.r-project.org/package=yaml", title: "CRAN yaml", claim: "Package metadata" }],
      compatibility: ["R on Linux"],
      unresolvedQuestions: [],
    }],
    unresolvedQuestions: [],
  };
  const result = await submit.execute("submit", report);
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { kind: "pi-r-dependency-scout-v1", report });
});
