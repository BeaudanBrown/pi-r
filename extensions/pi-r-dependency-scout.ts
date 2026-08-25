const ALLOWED_HOSTS = [
  "r-project.org",
  "bioconductor.org",
  "nixos.org",
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "tidyverse.org",
  "r-lib.org",
  "ropensci.org",
  "posit.co",
] as const;
const MAX_FETCHES = 8;
const MAX_RESPONSE_BYTES = 100_000;

interface ExtensionAPI {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: any, signal?: AbortSignal): Promise<unknown>;
  }): void;
}

function allowedUrl(input: unknown): URL {
  if (typeof input !== "string" || input.length > 2_000) throw new Error("URL must be a bounded HTTPS string");
  const url = new URL(input);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    !ALLOWED_HOSTS.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))
  ) {
    throw new Error("Only approved public registry, Nix, upstream, and primary-documentation HTTPS hosts are available");
  }
  return url;
}

async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(next.value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

async function fetchPrimary(input: URL, signal?: AbortSignal): Promise<{ url: string; status: number; contentType: string; text: string }> {
  let url = input;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const timeout = AbortSignal.timeout(10_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, {
      signal: combined,
      redirect: "manual",
      headers: { accept: "application/json,text/plain,text/html;q=0.8", "user-agent": "pi-r-dependency-scout/1" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Primary source returned a redirect without a location");
      url = allowedUrl(new URL(location, url).toString());
      continue;
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0] ?? "unknown";
    if (!contentType.startsWith("text/") && contentType !== "application/json" && contentType !== "application/ld+json") {
      throw new Error(`Unsupported research content type: ${contentType}`);
    }
    const text = await boundedBody(response);
    return { url: url.toString(), status: response.status, contentType, text };
  }
  throw new Error("Primary source exceeded the redirect bound");
}

function submission(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Structured report must be an object");
  const report = value as Record<string, unknown>;
  if (!Array.isArray(report.candidates) || report.candidates.length > 5) throw new Error("Submit at most five candidates");
  if (!Array.isArray(report.unresolvedQuestions) || report.unresolvedQuestions.length > 8) throw new Error("Submit bounded unresolved questions");
  return report;
}

export default function piRDependencyScout(pi: ExtensionAPI): void {
  let fetches = 0;
  pi.registerTool({
    name: "scout_http_get",
    label: "Fetch primary dependency evidence",
    description: "Fetch one bounded HTTPS page from approved R registries, Nix, an upstream repository, or primary documentation. At most eight calls are allowed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: { url: { type: "string", minLength: 1, maxLength: 2000 } },
    },
    async execute(_toolCallId, params, signal) {
      if (fetches >= MAX_FETCHES) throw new Error(`Research fetch limit reached (${MAX_FETCHES})`);
      fetches += 1;
      const result = await fetchPrimary(allowedUrl(params.url), signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: { url: result.url, status: result.status, contentType: result.contentType, bytes: Buffer.byteLength(result.text) },
      };
    },
  });

  pi.registerTool({
    name: "scout_submit",
    label: "Submit dependency candidates",
    description: "Submit the final bounded dependency candidate report. This does not select, install, approve, mutate, or activate anything.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["candidates", "unresolvedQuestions"],
      properties: {
        candidates: {
          type: "array", maxItems: 5, uniqueItems: true,
          items: {
            type: "object", additionalProperties: false,
            required: ["identifier", "summary", "evidence", "compatibility", "unresolvedQuestions"],
            properties: {
              identifier: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9.]{0,99}$" },
              summary: { type: "string", minLength: 1, maxLength: 600 },
              evidence: {
                type: "array", minItems: 1, maxItems: 4,
                items: {
                  type: "object", additionalProperties: false,
                  required: ["source", "url", "title", "claim"],
                  properties: {
                    source: { enum: ["official-registry", "nix-metadata", "primary-documentation"] },
                    url: { type: "string", minLength: 1, maxLength: 1000 },
                    title: { type: "string", minLength: 1, maxLength: 200 },
                    claim: { type: "string", minLength: 1, maxLength: 500 },
                  },
                },
              },
              compatibility: { type: "array", maxItems: 5, items: { type: "string", minLength: 1, maxLength: 300 } },
              unresolvedQuestions: { type: "array", maxItems: 5, items: { type: "string", minLength: 1, maxLength: 300 } },
            },
          },
        },
        unresolvedQuestions: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 300 } },
      },
    },
    async execute(_toolCallId, params) {
      const report = submission(params);
      return {
        content: [{ type: "text", text: "Structured dependency candidates submitted to the parent resolver." }],
        details: { kind: "pi-r-dependency-scout-v1", report },
        terminate: true,
      };
    },
  });
}
