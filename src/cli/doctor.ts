/**
 * Pre-flight check. Run this first — it verifies each credential independently
 * so you know exactly which one is wrong instead of debugging a silent no-op.
 *
 *   npm run doctor
 */
import "dotenv/config";
import { config, provider } from "../config.js";

interface Check {
  name: string;
  run: () => Promise<string>;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("<") || value === "sk-ant-...") {
    throw new Error(`not set in .env`);
  }
  return value;
}

const checks: Check[] = [
  {
    name: "LLM provider + key",
    run: async () => {
      const p = provider();
      const key = config.llmApiKey;
      const model = config.agentModel;

      // A real tool-calling request, not just a ping: the agent and the judge
      // both depend on function calling, and free-tier models vary in whether
      // they support it. Better to fail here than three minutes into a demo.
      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: "user", content: "Call the ping tool." }],
          tools: [
            {
              type: "function",
              function: {
                name: "ping",
                description: "Reply to a ping.",
                parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
              },
            },
          ],
          tool_choice: "auto",
        }),
      });

      const body = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error(`key rejected (HTTP ${res.status}) for provider "${p.name}". ${p.notes}`);
      }
      if (res.status === 404) {
        throw new Error(`model "${model}" not found on ${p.name}. Set AGENT_MODEL to a valid model.`);
      }
      if (res.status === 429) {
        throw new Error(`rate limited (429) — free tier quota. Wait a minute and retry.`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${p.baseUrl}: ${body.slice(0, 250)}`);
      }

      const supportsTools = body.includes("tool_calls");
      return (
        `${p.name} reachable, model "${model}" responded` +
        (supportsTools
          ? ", function calling works"
          : " — WARNING: no tool_calls in response, this model may not support function calling")
      );
    },
  },
  {
    name: "OTEL_EXPORTER_OTLP_ENDPOINT + SIGNOZ_INGESTION_KEY",
    run: async () => {
      const endpoint = env("OTEL_EXPORTER_OTLP_ENDPOINT").replace(/\/$/, "");
      const selfHosted = /localhost|127\.0\.0\.1/.test(endpoint);
      // Cloud requires an ingestion key; a local collector does not.
      const key = selfHosted ? (process.env.SIGNOZ_INGESTION_KEY ?? "") : env("SIGNOZ_INGESTION_KEY");
      // Post an empty but well-formed OTLP payload. A 200 means endpoint + key
      // are both accepted; 401/403 means the key is wrong.
      const res = await fetch(`${endpoint}/v1/traces`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { "signoz-ingestion-key": key } : {}),
        },
        body: JSON.stringify({ resourceSpans: [] }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`ingestion key rejected (HTTP ${res.status})`);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status} from ${endpoint}: ${body.slice(0, 200)}`);
      }
      return `accepting telemetry at ${endpoint}`;
    },
  },
  {
    name: "SIGNOZ_API_URL + SIGNOZ_API_KEY",
    run: async () => {
      const url = env("SIGNOZ_API_URL").replace(/\/$/, "");
      const selfHosted = /localhost|127\.0\.0\.1/.test(url);
      const key = selfHosted ? (process.env.SIGNOZ_API_KEY ?? "") : env("SIGNOZ_API_KEY");
      const endMs = Date.now();
      const res = await fetch(`${url}/api/v5/query_range`, {
        method: "POST",
        headers: { "content-type": "application/json", "SIGNOZ-API-KEY": key },
        body: JSON.stringify({
          start: endMs - 60_000,
          end: endMs,
          requestType: "raw",
          variables: {},
          compositeQuery: {
            queries: [
              {
                type: "builder_query",
                spec: {
                  name: "A",
                  signal: "traces",
                  filter: { expression: "" },
                  selectFields: [{ name: "trace_id" }],
                  limit: 1,
                  offset: 0,
                  disabled: false,
                },
              },
            ],
          },
        }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `API key rejected (HTTP ${res.status}) — create one under Settings -> Service Accounts -> Keys`,
        );
      }
      if (res.status === 404) {
        throw new Error(`404 at ${url}/api/v5/query_range — is SIGNOZ_API_URL your workspace URL?`);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return `query API reachable at ${url}`;
    },
  },
];

async function main(): Promise<void> {
  console.log(`\nAgentLens — pre-flight check\n`);
  let failures = 0;

  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`  OK    ${check.name}\n        ${detail}`);
    } catch (err) {
      failures += 1;
      console.log(`  FAIL  ${check.name}\n        ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed. Fix .env before running the demo.\n`);
    process.exit(1);
  }
  console.log(`\nAll checks passed. Next: npm run demo\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
