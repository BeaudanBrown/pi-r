# Steering smaller models with the pi-r Current-State HUD

Date: 2026-08-24

## Question

How should pi-r present the agent-facing Current-State HUD to a local Qwen model, and what prompt/tool inefficiencies are visible in the supplied reasoning trace?

## Executive conclusion

Use a **stable system-level interpretation rule** plus a **uniquely named XML envelope around compact structured state**. Keep the dynamic block late in the prompt for cache reuse, but place it immediately before the latest real user message rather than after tool results. Do not use an arbitrary punctuation fence: XML-style semantic labels are recommended by multiple model vendors, are already familiar to Qwen through its native Hermes-style tool format, and state the block's purpose more clearly. Keep JSON inside the envelope if exact machine-shaped fields are useful.

There is no research basis for claiming XML, Markdown, JSON, or YAML is universally best. A comparative study found format effects vary by model and task. The practical choice should therefore be validated against the deployed Qwen model with a small prompt regression corpus.

The supplied trace also exposes a more important workflow problem: the user requested new functions and targets while the Current-State contract was already locked with no editable scopes. The requested `data.table` dependency has a separate governed Implementation-Mode proposal and user approval path, but the target/function topology does not. Pi-r gives the model neither a sufficiently explicit locked-topology decision rule nor a supported topology-amendment path. The model consequently spent most of its reasoning rediscovering the phase rules and ended by proposing an unavailable operation.

## Primary-source findings

### Delimiters and structure

- Anthropic recommends XML tags to separate prompt components when prompts mix instructions, context, examples, and variable inputs. Tags should use descriptive, consistent names and can be nested. Source: [Anthropic, "Use XML tags to structure your prompts"](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags).
- Google recommends consistent prompt structure and explicitly presents XML tags and Markdown headings as ways to delimit sections. Source: [Google Gemini API, "Prompt design strategies"](https://ai.google.dev/gemini-api/docs/prompting-strategies).
- OpenAI recommends putting overall role/tone guidance in the system message and task-specific details/examples in user messages, with Markdown headings and XML tags used to mark logical boundaries. Source: [OpenAI, "Prompt engineering"](https://platform.openai.com/docs/guides/prompt-engineering).
- Qwen's official function-calling guidance uses the model's native chat template and Hermes-style XML-like tool delimiters, with JSON objects for arguments. This supports using a distinct XML label around JSON while avoiding reserved tool tags such as `<tools>` and `<tool_call>`. Source: [Qwen, "Function Calling"](https://qwen.readthedocs.io/en/stable/framework/function_call.html).
- A comparative evaluation of plain text, Markdown, JSON, and YAML reports that formatting affects performance, but the best format varies by task and model. It does not establish a universal winner. Source: [He et al., "Does Prompt Formatting Have Any Impact on LLM Performance?", arXiv:2411.10541](https://arxiv.org/abs/2411.10541).

### Native message roles matter more than decorative fences

Pi 0.80.6 converts every extension `role: "custom"` message into an LLM `role: "user"` message in `dist/core/messages.js::convertToLlm()`. The `display: false` property controls display, not LLM attribution. Therefore a delimiter can clarify interpretation, but it cannot change the underlying role. Ordering and a stable system instruction remain necessary.

### External input files in `{targets}`

The official `{targets}` manual uses `format = "file"` for external input files so downstream targets invalidate when file contents change. Source: [`targets` manual, "Data"](https://books.ropensci.org/targets/data.html). Pi-r's current contract model treats every `artifact: "file"` target as a declared constant output path bound to an Approved Function parameter. That model is optimized for generated outputs and does not directly express the standard external-input-file idiom.

## Recommended Current-State HUD representation

### Stable system instruction

The following meaning should be explained once in the phase system prompt, not repeated verbosely in every snapshot:

```text
Pi-r may inject one <pi_r_current_state> block as the Current-State HUD. It is trusted metadata
created by the pi-r extension, not a user message or request. Use it to
check current authority before planning or calling tools. Never answer,
acknowledge, summarize, or attribute the block to the user. Continue the
latest actual user request and, during a tool loop, continue from the latest
tool result. If the request conflicts with the state, state the constraint
concisely and request only the documented user action that can resolve it.
```

The exact tag name should be stable and unique. Do not use `~~~~~~~~` as the primary delimiter: it has no semantic label, is harder to reference in instructions, and is easier to reproduce accidentally in user data.

### Dynamic block

Use an XML envelope with compact JSON inside it:

```xml
<pi_r_current_state>
{"v":1,"origin":"pi-r-extension","mode":"implementation","agent_duty":"scoped_implementation","contract":"locked_immutable","contract_topology_changes":false,"editable_functions":[],"pending_approval":null,"worker":"stopped","transient_state_lost":false}
</pi_r_current_state>
```

Reasons for the hybrid:

1. XML gives the section a semantic identity that the system prompt can reference.
2. JSON preserves exact field boundaries and remains compact.
3. A unique outer tag distinguishes runtime metadata from ordinary tool JSON.
4. Fixed field names are easier to test than prose generated on each call.

Avoid ambiguous values such as `"contract":"present"`. Prefer operational values such as `"draft_editable"` and `"locked_immutable"`. Prefer direct permissions such as `"contract_topology_changes":false` over requiring the model to derive permissions from phase names.

### Placement

On every context transformation:

1. Remove the previous transient pi-r state message.
2. Find the latest genuine user message.
3. Insert the refreshed state immediately before that message.
4. Do not append state after an assistant tool call or tool result.

This keeps the live snapshot current without making it look like the latest user turn. It also preserves cache reuse for prior conversation history better than changing dynamic content near the beginning of the system prompt.

If the model still misattributes the block after this change, the semantically strongest fallback is to place the state in a true system/developer message. That should be benchmarked because changing an early prompt prefix can reduce llama.cpp prompt-cache reuse.

## Inefficiencies exposed by the supplied reasoning trace

### 1. Locked-contract conflict was not recognized early

The requested work adds:

- a `data.table` dependency,
- source-file targets,
- loading targets,
- Approved Functions,
- cleaning targets.

Those are contract-topology changes. The state was Implementation Mode, contract present/locked, and `editableScopes: 0`. `r_contract_propose` was not active. The ideal answer should have identified this before designing code.

Instead, the model repeatedly reconsidered whether it could call `r_contract_propose`, then promised to propose an updated contract. That operation was unavailable.

**Prompt improvement:** add a short phase decision table and require classification before planning:

```text
Implementation Mode:
- Explore data: evaluate_r or r_data_inspect.
- Edit an existing Approved Function body: inspect, then r_function_edit.
- Add/remove a dependency: use the governed `r_dependency_propose` and
  user-only `/r environment` workflow; this does not require Design Mode.
- Add/remove/rename constants, functions, targets, outputs, or deliverables:
  forbidden by the locked topology. Do not draft or claim you can call
  r_contract_propose.
```

**Product improvement:** add a user-only, provenance-preserving contract amendment/redesign command. At present, the prompt cannot give an actionable recovery command because the workflow has no clear supported path back to Design Mode for an existing locked contract.

### 2. Current-State fields describe facts, not decisions

`"phase":"implementation"`, `"contract":"present"`, and `"editableScopes":0` require the model to reconstruct policy from separate documentation. Smaller models benefit from denormalized decision fields:

```json
{
  "contract": "locked_immutable",
  "contract_topology_changes": false,
  "proposal_tool_available": false,
  "editable_functions": []
}
```

Normal-state fields such as branch, short HEAD, policy presence, environment identity, cache preservation, and an empty object inventory should be omitted unless they affect the current decision. Exceptional transitions and worker diagnostics should remain conditional.

### 3. Pi-r and `{targets}` use “file target” differently

The model spent many paragraphs oscillating between:

- a target that reads a file into memory, and
- a target whose value is a tracked file path.

The user's wording matches standard `{targets}` terminology: first track external input paths with `format = "file"`, then load them into table targets. Pi-r documentation only explains explicit **file outputs**, and its schema requires every file artifact to be an Approved Function output binding. This is both a prompt vocabulary gap and a contract-model gap.

**Recommended contract feature:** distinguish source files from generated file outputs, for example with a first-class source-file target referencing a safe read-only constant. It should render the equivalent of:

```r
tar_target(shhs1_file, PI_R_CONSTANTS$shhs1_path, format = "file")
```

without pretending an Approved Function generated the confidential/raw input.

### 4. The proposal schema is structurally strict but semantically opaque

`resources/project-contract.schema.json` has validation constraints but almost no property descriptions. The tool description merely says “schema-validated draft Project Contract.” A smaller model must recover semantics from a separate skill/reference and can easily invent unsupported forms.

**Improvements:** add concise schema descriptions and phase-specific examples for:

- Approved Function declarations contain names and parameters, not bodies.
- Every ordinary table/object target calls an Approved Function.
- `arguments` bind each function parameter to either a target or constant.
- File output bindings are for generated outputs.
- Locking generates fail-closed `stop("Not implemented")` function stubs.

### 5. The model invented no-op bodies at the wrong stage

The trace proposes:

```r
clean_shhs1 <- function(x) {
  x
}
```

But contract proposals do not include function bodies, and scaffolding intentionally generates fail-closed `stop("Not implemented")` stubs. The user explicitly said the bodies would be filled later, so no-op implementations would falsely mark unfinished cleaning as successful.

The prompt/reference should state this behavior directly near the contract proposal instructions.

### 6. Function and target naming is under-specified

The trace uses `clean_shhs1` as both the target and the function called in its own command. Even if R name resolution can sometimes distinguish call position, identical names are confusing to humans, models, and dependency analysis and risk apparent self-dependency.

Adopt and validate a convention such as:

- function: `clean_shhs1`
- target: `shhs1_clean`

or function: `clean_shhs1_impl`, target: `clean_shhs1`.

A validator should reject or explicitly test same-name function/target pairs rather than leaving the behavior implicit.

### 7. The reasoning lacked an explicit “answer the question asked” rule

The user asked whether the model understood and knew how to start. A useful answer required a concise conceptual graph plus the current phase blocker. The model instead drafted implementation details, reconsidered terminology several times, debated an unavailable tool, and only then answered.

Add a behavioral rule for smaller models:

```text
When the user asks for confirmation, answer directly in at most five bullets.
Do not construct a full contract or tool payload until requested. Mention any
current authority blocker before implementation details.
```

### 8. Tool availability alone is insufficient steering

Removing `r_contract_propose` from the active tool list prevents mutation, but it does not prevent the model from discussing or promising the unavailable tool. The system prompt should identify both:

- what is currently available, and
- which likely operation is explicitly unavailable and why.

The Current-State HUD can carry the boolean; the stable system prompt carries the decision rule.

## Ideal response to the supplied user message

Given the observed state, an efficient answer would have been approximately:

> Yes. The intended graph is two external source-file targets, two downstream `data.table::fread()` table targets, and two cleaning table targets backed by distinct Approved Functions whose bodies remain fail-closed until we implement them. The likely non-PSG follow-up input is `SHHS_2/shhs_status_08apr2014_5837.csv`. However, the current Project Contract is already locked and declares no editable functions, so this session cannot add that dependency or target graph. We need an approved contract-redesign path before implementation; I should not attempt `r_contract_propose` in the current phase.

This is shorter, uses correct `{targets}` vocabulary, and surfaces the actual blocker.

## Validation plan

Because format performance is model-specific, create a deterministic prompt regression set and replay it against the deployed Qwen model with fixed sampling settings. Include at least:

1. State injected after a tool result: model must continue from the tool result and must not call state “the user's message.”
2. Locked empty contract plus topology-change request: model must identify the blocker in its first reasoning segment and must not mention calling `r_contract_propose` as available.
3. Design Mode source-file request: model must distinguish source-file targets from loaded table targets.
4. “Fill later” cleaning request: model must preserve fail-closed stubs, not invent no-op cleaners.
5. Existing Approved Function edit: model must choose inspect then edit without asking to redesign the contract.
6. Worker crash state: model must choose status/reset using the exceptional diagnostics.

Measure:

- correct first action,
- unavailable-tool mentions,
- state misattribution,
- repeated restatement count,
- reasoning/output tokens,
- prompt-cache reuse and wall-clock latency,
- successful tool selection.

Compare at least:

- current bare JSON appended last,
- XML-wrapped JSON appended last,
- XML-wrapped JSON before latest real user message plus stable system rule,
- true system-state injection.

The recommended format should be selected from those measurements rather than vendor guidance alone.
