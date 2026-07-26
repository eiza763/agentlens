# START HERE — from nothing to a recorded demo

One linear path. Roughly **40 minutes**, most of it waiting for Docker images.

Written for this exact situation: no SigNoz Cloud account, no Docker locally, a
free Groq key, repo already on GitHub.

**Have ready:** your Groq API key (`gsk_...`). Get one free at
[console.groq.com](https://console.groq.com) → API Keys if you don't have it.

---

# PART 1 — Get SigNoz running (~15 min)

## 1.1 Launch the Codespace

Open this URL:

```
https://github.com/codespaces/new?repo=eiza763/agentlens
```

- Branch: `main`
- **Machine type: 4-core / 8GB** — do NOT pick 2-core, ClickHouse will be killed

Click **Create codespace**. VS Code opens in your browser.

## 1.2 Wait for setup to finish

The terminal at the bottom shows the container building. It installs npm
packages, clones SigNoz, and pulls several GB of Docker images.

**Wait for a banner of `=====` characters** ending with `npm run demo`. That means
setup finished. Typically 5–10 minutes.

> Terminal closed or output lost? Run it again manually:
> ```bash
> bash .devcontainer/setup-signoz.sh
> ```

## 1.3 Check the containers are up

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

You want several containers showing `Up`. Names vary by SigNoz release; you're
looking for a ClickHouse, a query-service, and an OTel collector.

If the list is empty, wait 60 seconds and try again. ClickHouse is slow to start.

## 1.4 Open the SigNoz UI

1. Click the **PORTS** tab in the bottom panel of VS Code
2. Find port **8080**
3. Click the **globe icon** (Open in Browser)

SigNoz asks you to create the first account.

**Use any email and password.** This is your own private instance — no signup
gate, no verification email. **Write the password down**, you need it next.

> Port 8080 missing? Wait, refresh the PORTS tab. Or click **Forward a Port** and
> enter `8080`.

## 1.5 Create a SigNoz API key

AgentLens needs this to read traces back out.

1. In SigNoz: **Settings** (gear icon) → **API Keys**
2. **Create a key**, any name, role **Admin**
3. **Copy it**

> Your build may say **Service Accounts** instead. Create a service account, open
> its **Keys** tab, generate a key there. Same thing.

## 1.6 Fill in `.env`

`.env` already exists and already points at localhost. You add three lines.

Click `.env` in the VS Code file explorer on the left. (If hidden: the explorer
shows dotfiles by default in Codespaces.)

Set these:

```ini
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...                 # your Groq key
SIGNOZ_API_KEY=...                   # from step 1.5

AGENT_MODEL=openai/gpt-oss-20b
JUDGE_MODEL=openai/gpt-oss-20b
```

Leave these as they are:

```ini
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
SIGNOZ_API_URL=http://localhost:8080
SIGNOZ_INGESTION_KEY=
```

Save with **Ctrl+S**.

> Why `gpt-oss-20b` and not `120b`? Groq's free tier allows 200k tokens per day
> **per model**. If you have already used 120b today, 20b gives a fresh
> allowance. Both handle tool calling correctly.

## 1.7 Verify everything

```bash
npm run doctor
```

You want **three OK lines**.

| Failure | Fix |
|---|---|
| `key rejected (401/403)` on the LLM | Re-copy the Groq key |
| `rate limited (429)` | Wait a minute, or switch model |
| `SIGNOZ_API_URL ... 404` | Query service still starting — wait 60s, rerun |
| `SIGNOZ_API_KEY ... 401/403` | Recreate the key (step 1.5) |
| `connection refused` | Collector still starting — wait 60s, rerun |

**A SigNoz failure on the first attempt is normal.** ClickHouse needs 2–3 minutes
before it accepts writes. Rerun before assuming something is broken.

**Do not continue until doctor is all OK.**

---

# PART 2 — Generate the data (~6 min)

This is the only part that costs LLM tokens: about **70,000**, comfortably inside
a daily free allowance.

Run these one at a time:

```bash
# The good deploy
npm run agent -- --variant baseline --repeat 2 --tasks T05,T06,T07
```

Wait for `Done.` Then:

```bash
sleep 25
npm run eval -- --lookback 15 --variant baseline
```

You should see PASS lines with scores. Then the regression:

```bash
npm run agent -- --variant regressed --repeat 2 --tasks T05,T06,T07
sleep 25
npm run eval -- --lookback 15 --variant regressed
```

You should now see some **FAIL** lines with `hallucinated_policy`.

## 2.1 Confirm the gates behave

```bash
npm run gate -- --variant baseline
npm run gate -- --variant regressed
```

Baseline should **pass**. Regressed should print **REGRESSION DETECTED**.

> Regressed didn't fail? Wait 30 seconds for ingestion and rerun the gate — the
> gate reads from SigNoz, so it needs the eval spans to have landed. Gates cost
> **zero tokens**, so rerun freely.

> `NO DATA`? Ingestion is lagging. `npm run eval -- --lookback 60` then retry.

**Do not continue until the regressed gate fails.** That is your demo.

---

# PART 3 — Screenshots and video (~15 min)

## 3.1 Build the two panels that matter

Try importing first: SigNoz → **Dashboards** → **+ New dashboard** →
**Import JSON** → paste the contents of `signoz/dashboard.json`.

**If the import fails, don't fight it.** Build just these two by hand — twenty
seconds each, and they are the only two you need:

**Panel A — Groundedness by variant** (time series)
- Signal: **Traces**
- Filter: `name = 'evaluate_run support-triage'`
- Aggregation: **avg** of `agentlens.eval.score.groundedness`
- Group by: `agentlens.variant`

**Panel B — Agent latency p95 by variant** (time series)
- Signal: **Traces**
- Filter: `name = 'invoke_agent support-triage'`
- Aggregation: **p95** of span duration
- Group by: `agentlens.variant`

Set the time range to **Last 30 minutes**. Arrange **A directly above B**.

You should see two lines in Panel A — `baseline` high, `regressed` lower — while
Panel B stays flat. **That contrast is your entire submission.**

## 3.2 Take two screenshots

1. **The stacked panels** (A above B) — your headline image
2. **The failure modes table**, or an eval span showing
   `agentlens.eval.failure_mode = hallucinated_policy` and the judge's reasoning

Windows: `Win + Shift + S` to snip. Save both.

Some judges only look at images. These two carry the argument on their own.

## 3.3 Record the video

**Xbox Game Bar** is built into Windows 10, nothing to install:

- `Win + Alt + R` starts and stops recording
- It records the **active window** — click the browser first
- Files land in `Videos\Captures`

In a Codespace the terminal is inside the browser, so one window captures both
SigNoz and the terminal.

Target **90 seconds**. Gates and dashboards cost no tokens, so **retake as often
as you like**.

### Scene 1 (0:00–0:25) — the problem

Show the two stacked panels.

> "This is an AI customer-support agent, traced with OpenTelemetry into SigNoz.
> Two deploys. Look at the bottom panel first — latency is completely flat, no
> errors, every request returned 200 OK. Now the top panel: groundedness fell off
> a cliff."

### Scene 2 (0:25–0:50) — what broke

Show the failure modes table, then click into a failing evaluation.

> "Groundedness measures how much of the agent's answer is actually backed by
> something it looked up. It dropped because someone shipped a prompt change —
> 'be confident, always give customers a concrete answer.' No syntax error, no
> failing test. It just makes the agent invent policies.
>
> Here it told a customer 'we don't offer a price-match guarantee.' That policy
> does not exist. The judge caught the exact sentence."

### Scene 3 (0:50–1:10) — how it works

Show the span tree of one agent run.

> "Every LLM call and tool call is a span, using OpenTelemetry's GenAI semantic
> conventions. And here's the key design decision: the evaluator never touches
> the agent. It queries finished traces out of SigNoz, rebuilds each run from its
> spans, grades it, and writes the scores back in as metrics. So it can grade any
> traced agent, in any language, including runs from yesterday."

### Scene 4 (1:10–1:30) — the payoff

Switch to the terminal:

```bash
npm run gate -- --variant regressed
```

> "And because quality is a signal, CI can block on it. A hallucination is a
> 200 OK — latency and error rate can never see it. This can."

**Stop there.** No summary, no apology for what isn't finished.

---

# PART 4 — Submit

1. Upload the video to **YouTube as unlisted**, or use [Loom](https://loom.com)
2. Put the link and the two screenshots at the **very top of the README**
3. Commit and push:
   ```bash
   git add -A && git commit -m "Add demo video and screenshots" && git push
   ```
4. Submit the hackathon form: **Track 01 — AI & Agent Observability**

Repo: `https://github.com/eiza763/agentlens`

**Stop the Codespace when done** — Codespaces page → `...` → **Stop**. Free tier
is 120 core-hours/month and a 4-core machine burns 4 per hour.

---

# If it goes wrong

```bash
npm run selftest    # 47 checks, no credentials. Passes? The logic is fine.
npm run doctor      # tells you which credential is wrong
docker ps           # is SigNoz actually up
```

If SigNoz never works and time runs out, record this instead:

```bash
npm run smoke -- --compare --tasks T05,T06,T07
```

It shows the agent, the judge and the regression in the terminal, with no SigNoz.
Weaker for a SigNoz hackathon — but say so honestly in the submission rather than
implying a run that did not happen.
