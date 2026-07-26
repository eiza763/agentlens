# SigNoz setup: dashboard panels and alerts

`dashboard.json` in this folder can be imported directly via **Dashboards → + New
dashboard → Import JSON**.

A caveat worth stating plainly: SigNoz's dashboard JSON schema has changed across
versions, so if your workspace rejects the import or renders a panel empty, build
that panel by hand using the recipe below. The recipes are the source of truth —
they only depend on the query builder UI, which is stable. Each takes about
twenty seconds to enter.

Every panel reads the **evaluation spans** emitted by `agentlens-evaluator`
(span name `evaluate_run support-triage`), except the last one which reads the
agent's own spans.

---

## Why panels read spans, not metrics

AgentLens emits both. Spans carry one row per evaluated run with the score as a
numeric attribute; metrics carry the same numbers as OTel histograms and counters.

The dashboards use spans because `avg()` over a span attribute is unambiguous in
the query builder, whereas averaging an OTel histogram requires reasoning about
`_sum`/`_count` series. The metrics are still there and are the right choice at
high volume — see [Metrics reference](#metrics-reference).

---

## Panels

### 1. Mean overall score by variant  (time series)

The headline quality signal.

| Field | Value |
|---|---|
| Signal | Traces |
| Filter | `name = 'evaluate_run support-triage'` |
| Aggregation | `avg` of `agentlens.eval.score.overall` |
| Group by | `agentlens.variant` |
| Legend | `{{agentlens.variant}}` |

### 2. Groundedness by variant  (time series)

**The panel the whole project exists for.** Groundedness is the fraction of the
answer's factual claims that a tool result actually supports. When someone ships
a prompt that makes the agent invent policies, this line drops and nothing else
in your observability stack moves.

| Field | Value |
|---|---|
| Signal | Traces |
| Filter | `name = 'evaluate_run support-triage'` |
| Aggregation | `avg` of `agentlens.eval.score.groundedness` |
| Group by | `agentlens.variant` |

### 3. Mean overall score  (single value)

Same as panel 1 with no group-by. Set thresholds: red below `0.75`, amber below
`0.85`, green above.

### 4. Mean groundedness  (single value)

Same as panel 2 with no group-by. Red below `0.8`.

### 5. Failed runs  (single value)

| Field | Value |
|---|---|
| Signal | Traces |
| Filter | `name = 'evaluate_run support-triage' AND agentlens.eval.verdict = 'fail'` |
| Aggregation | `count()` |

### 6. Failure modes  (table)

Turns "quality dropped" into "the agent invented refund policies 6 times".

| Field | Value |
|---|---|
| Signal | Traces |
| Filter | `name = 'evaluate_run support-triage' AND agentlens.eval.verdict = 'fail'` |
| Aggregation | `count()` |
| Group by | `agentlens.eval.failure_mode`, `agentlens.variant` |

### 7. Mean score by task  (table)

Shows *which* tasks are weak. Trap tasks `T05`–`T07` degrade first.

| Field | Value |
|---|---|
| Signal | Traces |
| Filter | `name = 'evaluate_run support-triage'` |
| Aggregation | `avg` of `agentlens.eval.score.overall` |
| Group by | `agentlens.task.id`, `agentlens.variant` |

### 8. Tokens spent, split by verdict  (time series)

Tokens spent on a `fail` run bought nothing. Two series side by side make the
waste legible without needing any pricing data.

| Field | Value |
|---|---|
| Signal | Traces |
| Filter | `name = 'evaluate_run support-triage'` |
| Aggregation | `sum` of `agentlens.tokens.total` |
| Group by | `agentlens.eval.verdict` |

### 9. Agent latency p95 by variant  (time series)

| Field | Value |
|---|---|
| Signal | Traces |
| Filter | `name = 'invoke_agent support-triage'` |
| Aggregation | `p95` of span duration |
| Group by | `agentlens.variant` |

Include this deliberately. During the demo it stays flat while panels 1 and 2
fall off a cliff — the visual proof that latency and error rate cannot see a
hallucination.

### 10. Tool-call rejection rate  (time series)

Business rules the agent tried to break.

| Field | Value |
|---|---|
| Signal | Traces |
| Filter | `agentlens.tool.error = true` |
| Aggregation | `count()` |
| Group by | `gen_ai.tool.name` |

---

## Alerts

Create under **Alerts → New alert → Trace-based**.

### Alert 1 — Agent groundedness regression

The one that matters. Fires when the agent starts making things up.

- **Query:** Signal Traces, filter `name = 'evaluate_run support-triage'`,
  aggregation `avg` of `agentlens.eval.score.groundedness`
- **Condition:** below `0.8`, for at least `5 minutes`
- **Severity:** critical
- **Message:**
  > Agent groundedness has fallen below 0.8. The agent is likely stating facts no
  > tool result supports. Open the AgentLens dashboard, check the Failure modes
  > panel, and follow the span link on any failing evaluation to the exact
  > conversation.

### Alert 2 — Agent quality regression

- **Query:** `avg(agentlens.eval.score.overall)` on the same filter
- **Condition:** below `0.75` for `5 minutes`
- **Severity:** warning

### Alert 3 — Evaluation failure rate

- **Query:** `count()` filtered to `agentlens.eval.verdict = 'fail'`
- **Condition:** above `3` in `5 minutes`
- **Severity:** warning

### Alert 4 — Token budget per run

- **Query:** `avg(agentlens.tokens.total)` on evaluation spans
- **Condition:** above `12000` for `10 minutes`
- **Severity:** warning
- Catches an agent that starts looping through tools without converging.

---

## Metrics reference

Emitted in parallel with the spans. Prefer these once you have thousands of runs
per hour, where per-run spans get sampled but metrics stay exact.

| Metric | Type | Key attributes |
|---|---|---|
| `gen_ai.client.token.usage` | histogram | `gen_ai.token.type` (`input`/`output`), `gen_ai.request.model`, `agentlens.variant` |
| `agentlens.run.tokens` | histogram | `agentlens.variant`, `agentlens.task.id` |
| `agentlens.run.steps` | histogram | `agentlens.variant`, `agentlens.task.id` |
| `agentlens.run.duration` | histogram (ms) | `agentlens.variant`, `agentlens.task.id` |
| `agentlens.eval.score` | histogram | `agentlens.eval.dimension` (`overall`/`groundedness`/`task_completion`/`tool_selection`/`efficiency`), `agentlens.variant` |
| `agentlens.eval.runs` | counter | `agentlens.eval.verdict` |
| `agentlens.eval.failures` | counter | `agentlens.eval.failure_mode` |
| `agentlens.eval.tokens` | histogram | `agentlens.eval.verdict` |

`gen_ai.client.token.usage` uses the OpenTelemetry GenAI semantic convention
name, so it aggregates with token usage from any other OTel-instrumented LLM
service in the same workspace rather than sitting in its own silo.
