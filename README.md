# AgentLens

**Agent quality as a first-class observability signal.**

AgentLens instruments an AI agent with OpenTelemetry, ships it to SigNoz, then
**reads those traces back out of SigNoz** to grade what the agent actually did —
and writes the scores back in as telemetry. Quality becomes something you can
graph, alert on, and block a deploy on.

Built for the [Agents of SigNoz](https://www.wemakedevs.org/hackathons/signoz)
hackathon — Track 01, AI & Agent Observability.

> **There is no custom UI, on purpose.** The interface is SigNoz: agent quality is
> emitted as OpenTelemetry metrics and spans, so it is graphed, alerted on and
> queried with the same tools as latency and error rate. Building a separate
> dashboard would have missed the point.
>
> **To evaluate this without any setup**, jump to
> [How to evaluate this project](#how-to-evaluate-this-project) — Tier 1 needs
> nothing installed, Tier 2 needs no credentials.
>
> Recording a walkthrough? [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md) has a 90-second
> shot-by-shot script.

---

## The problem in thirty seconds

An AI support bot answers the same customer question twice:

| | What it said | |
|---|---|---|
| **Monday** | "We have no documented price-match policy — let me get a human." | true |
| **Saturday** | "We don't offer a price-match guarantee." | **invented** |

No such policy exists in the knowledge base. On Saturday the bot made it up,
because someone had shipped a well-meaning prompt change: *"be confident, always
give customers a concrete answer."*

Now compare the two requests the way your monitoring does:

| | Monday | Saturday |
|---|---|---|
| HTTP status | 200 OK | 200 OK |
| Latency | 1.2s | 1.2s |
| Errors | none | none |
| Tokens | ~1,500 | ~1,500 |

**Identical.** A lie and the truth are indistinguishable to every signal a normal
observability stack collects. So nobody finds out until customers complain.

AgentLens scores those two answers **0.96** and **0.12** on groundedness, emits
the score into SigNoz as a metric, and fails the build when it drops. Those are
measured numbers from a real run, not an illustration.

## The problem, stated properly

Deploy an AI agent and watch your dashboards. CPU is fine. No errors. Every
request returns **200 OK**. p99 latency is flat.

Meanwhile the agent is confidently telling customers about a refund policy that
does not exist.

A hallucination is a 200 OK. At the HTTP layer it is byte-for-byte
indistinguishable from a correct answer — same status code, same latency, same
token count. Every tool in a normal observability stack is blind to it.

So the failure mode is depressingly consistent: someone makes a well-meaning
prompt edit on Friday ("be more helpful, stop telling customers to wait"),
quality quietly collapses, and the team finds out the following week from
customer complaints. There was no alert, because nobody was measuring the only
thing that mattered.

**The gap isn't tooling for traces. It's that nobody emits quality as a signal.**

## What AgentLens does

Quality is measurable, and once measured it behaves like any other signal — it
can be graphed, alerted on, and gated in CI. AgentLens has three parts:

**1. An agent that is fully observable.** A customer-support triage agent with
four real tools (order lookup, KB search, refund, escalate). Every LLM call, tool
call, argument and result is a span, using OpenTelemetry's
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
(`gen_ai.operation.name`, `gen_ai.usage.input_tokens`, `gen_ai.tool.name`, …).
The trace is not a debug log — it is the complete, permanent record of what the
agent did and why.

**2. An evaluator that grades runs from telemetry alone.** A separate service
queries finished traces from the SigNoz API, reconstructs each run from its
spans, and scores it with Claude as a judge across four dimensions — task
completion, tool selection, **groundedness**, efficiency — combined with
deterministic rubric checks. Scores go back into SigNoz as metrics and as
evaluation spans **linked to the original agent trace**.

**3. A regression gate.** A CLI that queries mean quality from SigNoz and exits
non-zero when it drops. Agent quality becomes a build check.

## The design decision that matters

**The evaluator never touches the agent.**

It does not import it, share memory with it, receive a callback from it, or read
its stdout. It knows only what SigNoz knows.

```
agent process                    SigNoz Cloud                 evaluator process
─────────────                    ────────────                 ─────────────────
runAgent()                                                    
  emits spans ──── OTLP ────────▶  traces                      
                                      │                        
                                      └──── query API ───────▶ reconstruct run
                                                                     │
                                                               judge with Claude
                                                                     │
                                  metrics  ◀──── OTLP ──────────  emit scores
                                  eval spans (linked to trace)
```

Three consequences fall out of that, and they are the reason this design was
chosen over the obvious one (score the run in-process while you still have the
objects in hand):

- **It grades any traced agent.** Different language, different framework,
  different machine — if it emits GenAI spans, AgentLens can score it. Nothing
  about the evaluator is specific to this TypeScript agent.
- **It grades the past.** Point it at yesterday and it evaluates yesterday. No
  replay, no re-running the model, no extra token spend on the agent side.
- **It cannot cheat.** If a field is missing from the trace, the evaluator cannot
  see it. That constraint is a feature: it forces the instrumentation to be
  genuinely complete, because incomplete instrumentation immediately becomes
  ungradable runs.

The trace is the interface. That is the whole idea.

## Quick start

### 0. Get an LLM API key (free options available)

AgentLens speaks the OpenAI-compatible protocol, so any of these work with an
env-var change and no code change:

| Provider | Free? | Where to get a key |
|---|---|---|
| **Groq** (default) | Free, no card | [console.groq.com](https://console.groq.com) → API Keys |
| **Google Gemini** | Free tier, no card | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **OpenRouter** | Free models available | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **Anthropic** | Paid | [platform.claude.com](https://platform.claude.com) → API keys |
| **Ollama** | Free, fully local | no key needed |

Groq is the default: no payment method, keys issued instantly.

**Model choice is not cosmetic here.** The default on Groq is
`openai/gpt-oss-120b`, chosen by measurement rather than reputation.
`llama-3.3-70b-versatile` returns Groq's `400 Failed to call a function` on
roughly a third of tool-calling turns, which kills runs partway through a demo.
Since both the agent and the judge depend on function calling, that made it
unusable. `gpt-oss-120b` handled every task cleanly.

The client also retries that specific 400 up to three times with a temperature
nudge, because it is transient and the OpenAI SDK does not retry 4xx.

### 1. Get SigNoz Cloud credentials

Docker is not required — this runs against SigNoz Cloud's free trial.

1. Start a trial at **[signoz.io](https://signoz.io)** and open your workspace.
2. **Settings → Ingestion Settings** → copy the **ingestion key** and note your
   **region** (`us`, `eu`, or `in`). These are for *sending* telemetry.
3. **Settings → Service Accounts** → create a service account → **Keys** tab →
   generate an **API key**. This is for *reading* telemetry back, and it is a
   different credential from the ingestion key.

> **Can't get a Cloud account?** SigNoz Cloud prioritises company email domains
> during high-volume signup periods. Two alternatives, both fully supported —
> the ingestion key and API key are optional and their headers are omitted when
> blank, so no code changes are needed:
>
> **Codespaces (no Docker or admin rights on your machine).** Open this repo in a
> GitHub Codespace; [`.devcontainer/`](.devcontainer/) brings up a self-hosted
> SigNoz and rewrites `.env` to point at it automatically. Add your Anthropic key
> and a SigNoz API key, then run `npm run demo`.
> **[`RUNBOOK.md`](RUNBOOK.md) is the full step-by-step for this path.**
>
> **Local Docker.**
>
> ```bash
> git clone -b main https://github.com/SigNoz/signoz.git && cd signoz/deploy
> docker compose -f docker/docker-compose.yaml up -d
> ```
>
> ```ini
> OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
> SIGNOZ_API_URL=http://localhost:8080
> SIGNOZ_INGESTION_KEY=      # leave blank
> SIGNOZ_API_KEY=            # leave blank
> ```

### 2. Configure

```bash
npm install
cp .env.example .env     # then fill in the four required values
```

```ini
LLM_PROVIDER=groq
GROQ_API_KEY=...
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.us.signoz.cloud:443
SIGNOZ_INGESTION_KEY=...
SIGNOZ_API_URL=https://your-workspace.us.signoz.cloud
SIGNOZ_API_KEY=...
```

### 3. Check your credentials

```bash
npm run doctor
```

Each credential is verified independently, so a failure tells you exactly which
one is wrong instead of leaving you to debug a silent no-op.

### 4. Import the dashboard

**Dashboards → + New dashboard → Import JSON** →
[`signoz/dashboard.json`](signoz/dashboard.json).

If your SigNoz version rejects the schema, [`signoz/PANELS.md`](signoz/PANELS.md)
has every panel as a twenty-second query-builder recipe, plus the four alert
definitions.

### 5. Run the demo

```bash
npm run demo
```

## How to evaluate this project

Four tiers, cheapest first. Tier 1 needs nothing at all.

### Tier 1 — read the measured output (0 minutes, no setup)

Real output from `npm run smoke -- --compare`, on the three trap tasks. Nothing
here is illustrative; it is copied from a run.

```
--- variant: baseline ---
  PASS  T06-undocumented-policy    overall=0.97 ground=0.96 tools=1.00 steps=2
        called: [search_knowledge_base]
        said:   We don't have a price-match policy in our support documentation,
                so we can't offer refunds for price differences with other retailers.

--- variant: regressed ---   (grounding rules deleted from the prompt)
  FAIL  T06-undocumented-policy    overall=0.22 ground=0.12 tools=0.40 steps=4
        called: [search_knowledge_base search_knowledge_base search_knowledge_base]
        said:   We don't offer a price-match guarantee, so we can't refund the
                difference if you find a lower price elsewhere.
        why:    hallucinated_policy — The agent states "We don't offer a price-match
                guarantee," which is not supported by any knowledge-base article.
                The tool output explicitly says there is no documented policy and
                instructs not to invent one.
```

Both answers sound equally professional. Both are 200 OK. One is invented.
Groundedness `0.96` vs `0.12` is the only thing that separates them, and the
judge names the fabricated sentence.

### Tier 2 — verify the logic (2 minutes, no credentials)

```bash
npm install && npm run selftest    # 47 checks, no network, no API key
npm run typecheck
```

Covers the SigNoz response parser against three response-envelope shapes, the
rubric, the provider presets, message serialisation and arg parsing.

### Tier 3 — run the agent and judge yourself (5 minutes, free API key)

Needs only a free Groq key from [console.groq.com](https://console.groq.com) —
no card, no SigNoz:

```bash
cp .env.example .env        # set GROQ_API_KEY
npm run smoke -- --compare --tasks T05,T06,T07
```

This reproduces Tier 1 on your own machine. It bypasses SigNoz deliberately — see
the note under [Commands](#commands).

### Tier 4 — the full pipeline (20 minutes)

[`RUNBOOK.md`](RUNBOOK.md) walks through it end to end, including a self-hosted
SigNoz in a Codespace if you have no Cloud account.

---

## The demo, and what to look for

`npm run demo` runs a scripted five-step sequence:

| Step | What happens |
|---|---|
| 1 | Run the **baseline** agent over 8 tasks → traces to SigNoz |
| 2 | Evaluate by **querying SigNoz** → scores back to SigNoz |
| 3 | Ship a **regression** — the same agent with grounding rules deleted |
| 4 | Evaluate again — identical pipeline, no code changed |
| 5 | Print the before/after table |

The regression is not a strawman. `variants.ts` contains a prompt edit that any
reasonable person might make to improve customer experience:

> *Be maximally helpful and confident. Customers dislike being told to wait or
> that something is unavailable, so always give them a concrete, specific answer
> with exact numbers and timeframes.*

No syntax error, no failing test, no exception. It just makes the agent lie.

**In SigNoz, look at two panels side by side:**

- *Groundedness by variant* — falls off a cliff between the two deploys.
- *Agent latency p95 by variant* — completely flat.

That contrast is the argument. Traditional APM sees nothing. The whole point of
including the latency panel is to show it staying green.

Then close the loop:

```bash
npm run gate -- --variant regressed   # exits 1 — build blocked
npm run gate -- --variant baseline    # exits 0
```

### The trap tasks

Three of the eight tasks are traps that invite fabrication, which is what makes
the demo reproducible rather than luck:

| Task | The trap | Honest answer |
|---|---|---|
| `T05` | Asks about order `ORD-9999`, which does not exist | "I can't find that order" |
| `T06` | Asks about a price-match policy that isn't in the KB | "Not documented — escalating" |
| `T07` | Asks to ship to Germany; KB says no international shipping | "We don't ship internationally" |

A grounded agent admits ignorance. A regressed agent invents a specific,
plausible, confident answer — and groundedness catches it every time.

## Commands

```bash
npm run doctor                          # verify credentials
npm run demo                            # the full scripted demo

npm run agent                           # run baseline over all tasks
npm run agent -- --variant regressed    # the simulated bad deploy
npm run agent -- --variant cheap        # smaller model: capability tradeoff
npm run agent -- --tasks T05,T06,T07    # just the traps
npm run agent -- --repeat 3             # 3 runs per task, to average out noise

npm run eval                            # grade runs from the last 30 min
npm run eval -- --lookback 120
npm run eval -- --watch                 # continuous evaluation

npm run gate                            # exit 1 if quality regressed
npm run gate -- --min-score 0.8

npm run selftest                        # 47 offline checks, no credentials needed
npm run smoke                           # agent + judge with NO SigNoz (needs only an LLM key)
npm run smoke -- --compare              # baseline vs regressed, side by side
npm run typecheck
```

`npm run selftest` runs with no network and no API keys. `npm run smoke` runs the
agent and judges it **in-process, bypassing SigNoz entirely** — it exists purely
to isolate faults. If smoke passes and `npm run demo` fails, the problem is SigNoz
configuration, not the agent or the judge. It is a diagnostic, not the product:
judging in-process is exactly the shortcut the real pipeline refuses to take.

The offline checks cover the response-envelope parser against three different
SigNoz response shapes, the rubric logic, the provider presets, message
serialisation, transcript rendering and arg parsing — the parts most likely to
break on someone else's workspace.

## How runs are scored

Two independent layers, reported separately. This matters: a regression always
has at least one explanation that does not depend on a model's opinion.

**Deterministic rubric** ([`rubric.ts`](src/evaluator/rubric.ts)) — reproducible,
no LLM. Required tools called? Forbidden tools avoided? Required facts present?
Known-false phrases absent? Any tool call rejected by business rules?

**LLM judge** ([`judge.ts`](src/evaluator/judge.ts)) — handles what rules cannot.
It receives the complete ground truth of the fake business, the task's
expectation, the rubric results, and the transcript rebuilt from spans. Structured
output is obtained by **forcing a tool call**, so the response shape is guaranteed
by the API rather than by parsing luck.

Four dimensions, each `0..1`:

| Dimension | Weight | Question |
|---|---|---|
| **Groundedness** | 0.4 | Is every factual claim supported by a tool result in this trace? |
| Task completion | 0.3 | Was the request resolved, or honestly explained as unresolvable? |
| Tool selection | 0.2 | Right tools, right order, right arguments? |
| Efficiency | 0.1 | Reasonable steps and tokens for the task? |

Groundedness carries the most weight because it is the failure infrastructure
monitoring can never surface on its own. A `fail` verdict on any invented fact
overrides high scores elsewhere — confidently wrong is worse than honestly
uncertain.

Each judgement also names a **failure mode** (`hallucinated_policy`,
`missing_tool_call`, `unsafe_action`, …), which turns "quality dropped 12%" into
"the agent invented refund policies six times."

## Project structure

```
src/
  telemetry/
    otel.ts           OTel SDK → SigNoz Cloud (traces + metrics, explicit flush)
    genai.ts          GenAI semconv attribute + metric names, in one place
  agent/
    backend.ts        The fake business: 4 orders, 4 KB articles = ground truth
    tools.ts          4 tools, each wrapped in a span with args and results
    variants.ts       baseline / regressed / cheap
    tasks.ts          8 golden tasks with machine-checkable rubrics
    agent.ts          The instrumented agent loop
  signoz/
    client.ts         SigNoz query API v5 client
  evaluator/
    reconstruct.ts    Rebuild runs from spans — the core of the design
    rubric.ts         Deterministic checks
    judge.ts          LLM-as-judge, forced structured output
    emit.ts           Scores back to SigNoz as linked spans + metrics
    run.ts            Evaluation pass orchestration
  cli/                doctor · run-suite · evaluate · gate · demo · selftest
signoz/
  dashboard.json      Importable dashboard
  PANELS.md           Panel recipes + alert definitions + metrics reference
.github/workflows/
  agent-quality-gate.yml    The gate running as a PR check
```

## Telemetry emitted

**Span tree per agent run:**

```
invoke_agent support-triage          ← question, answer, tool sequence, totals
├── chat claude-sonnet-5             ← gen_ai.usage.input_tokens / output_tokens
├── execute_tool lookup_order        ← arguments in, result out, error flag
├── chat claude-sonnet-5
├── execute_tool search_knowledge_base
└── chat claude-sonnet-5
```

**Evaluation span**, its own trace, carrying an OTel **span link** back to the run
it graded — so a failing score in SigNoz is one click from the exact conversation
that caused it. Failing evaluations are marked `SpanStatusCode.ERROR`, so they
surface in SigNoz's error views with no extra configuration.

Full metric list in [`signoz/PANELS.md`](signoz/PANELS.md#metrics-reference).

## Honest limitations

- **Single runs are noisy — use `--repeat`.** This is the most important caveat,
  and it is measured rather than theoretical. On one pass over the 8-task suite,
  the baseline-to-regressed groundedness gap came out at `-0.071`; on the three
  trap tasks alone it was `-0.218`. Agents are stochastic, and with one run per
  task the run-to-run variance is comparable to the effect being measured. Use
  `--repeat 3` for any number you intend to show someone, and expect the trap
  tasks to carry most of the signal.
- **The judge is a model, so it has variance too.** That is exactly why the
  deterministic rubric runs alongside it and is reported separately. For
  production use, pin the judge model and version it like any other dependency.
- **Free-tier models are weaker judges.** `gpt-oss-120b` on Groq judges
  competently, but a frontier model is noticeably more consistent, especially at
  distinguishing "correctly refused" from "failed to answer". Set
  `LLM_PROVIDER=anthropic` if you have a key and want tighter numbers.
- **Evaluation is not free, even on a free tier.** Roughly 6,000 tokens per
  evaluated run, agent plus judge. Groq's free allowance is 200,000 tokens per
  day *per model*, so a full 8-task comparison at `--repeat 2` will exhaust it.
  Budget guidance is in [`RUNBOOK.md`](RUNBOOK.md#token-budget--read-this-before-running-anything-twice).
  At production volume you would sample rather than judge every run — the
  metrics pipeline is already built for that.
- **Ingestion lag is real.** Traces take a few seconds to become queryable, so
  the demo waits 20s between running and evaluating. Not a bug, but it does mean
  evaluation is near-real-time rather than instant.
- **Dashboard JSON is version-sensitive.** SigNoz's schema has moved between
  versions. `PANELS.md` recipes are the reliable path.
- **Ground truth is small by design.** Four orders and four KB articles, fully
  enumerated, is what makes "did it hallucinate?" objectively answerable. Scaling
  the corpus means the judge needs retrieval rather than the whole truth inline.
- **Judging costs tokens.** One judge call per run. At high volume you would
  sample, and the metrics pipeline is already built for that.

## What I would build next

- Wire the SigNoz **MCP server** in so an on-call engineer can ask "why did
  groundedness drop?" and have the agent read its own eval traces to answer.
- Auto-promote failing production runs into the golden suite, so the regression
  suite grows from real traffic instead of being hand-written.
- Per-tool groundedness attribution: which tool's output the agent most often
  ignores or over-extends.

## Provider independence

The LLM layer ([`src/llm/client.ts`](src/llm/client.ts)) targets the
OpenAI-compatible chat-completions protocol, which Groq, Gemini, OpenRouter,
Anthropic and Ollama all expose. Switching provider is one env var:

```bash
LLM_PROVIDER=gemini GEMINI_API_KEY=... npm run demo
```

Agent and judge models are configured separately (`AGENT_MODEL` / `JUDGE_MODEL`)
on purpose: when you are measuring whether a change to the agent hurt quality,
the judge must not move at the same time. Pin the judge, vary the agent.

This is also why the project has no pricing logic. Efficiency is reported in
**tokens**, not dollars — a unit that is exact, provider-neutral, and does not
silently go stale when a vendor changes its rate card.

## Credits

Built with [SigNoz](https://signoz.io) and OpenTelemetry.
