# Runbook: running AgentLens in a GitHub Codespace

Step-by-step for a machine with **no Docker, no admin rights, and no SigNoz Cloud
account**. Everything runs inside a Codespace.

Total time: roughly 20 minutes, most of it waiting for images to pull.

---

## Step 0 — Get a free LLM API key

Do this first so you are not blocked later. **No payment method required.**

1. Go to **https://console.groq.com** and sign in with Google or GitHub.
2. **API Keys → Create API Key**. Copy it — it is shown once.

That is the whole step. Groq's free tier needs no card, and its function calling
is reliable — which matters, because both the agent and the judge depend on it.

**Alternative free option:** Google Gemini at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). If you use it,
set `LLM_PROVIDER=gemini` and `GEMINI_API_KEY=...` instead in Step 5.

> Free tiers rate-limit. If a run stops with a `429`, wait a minute and rerun —
> the client already retries a few times, and traces from completed runs are not
> lost.

Keep the key on your clipboard.

---

## Step 1 — Launch the Codespace

Open:

```
https://github.com/codespaces/new?repo=eiza763/agentlens
```

- **Branch:** `main`
- **Machine type:** **4-core / 8GB** — do not pick 2-core. ClickHouse (SigNoz's
  database) will be killed by the out-of-memory reaper on 2-core.

Click **Create codespace**.

VS Code opens in your browser. The bottom panel shows the container building.
This takes **5–10 minutes** on first run: it installs Node dependencies, clones
SigNoz, and pulls several GB of Docker images.

**Wait for the terminal to print the `====` banner** that ends with
`npm run doctor`. That means setup finished.

> If the terminal closes or you lose the output, re-run setup by hand:
> ```bash
> bash .devcontainer/setup-signoz.sh
> ```

---

## Step 2 — Confirm SigNoz containers are running

In the Codespace terminal:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

You want several containers `Up` — including a ClickHouse one, a query-service,
and an OTel collector. Names vary between SigNoz releases.

If the list is empty or containers are restarting:

```bash
cd ~/signoz/deploy
docker compose -f docker/docker-compose.yaml logs --tail 50
cd -
```

ClickHouse needs **2–3 minutes** after startup before it accepts writes. Empty
dashboards during that window are normal.

---

## Step 3 — Open the SigNoz UI and create your admin user

1. Click the **Ports** tab in the VS Code bottom panel.
2. Find port **8080** and click the **globe icon** (Open in Browser).
3. SigNoz asks you to create the first account.

**Use any email and password you like.** This is your own private instance —
there is no signup gate, no verification email, and nobody else can reach it.
Write the password down; you will need it in the next step.

> If port 8080 is not listed, wait a moment and refresh the Ports tab. You can
> add it manually with **Forward a Port → 8080**.

---

## Step 4 — Create a SigNoz API key

AgentLens needs this to *read* traces back. The ingestion side needs no key, but
reads are authenticated.

1. In the SigNoz UI: **Settings** (gear icon) → **API Keys**.
2. **Create a new key**, give it any name, choose the **Admin** or **Editor**
   role, and copy the value.

> If your SigNoz build shows **Service Accounts** instead of **API Keys**, create
> a service account, open its **Keys** tab, and generate a key there. Either
> produces the same kind of token.

---

## Step 5 — Fill in `.env`

`.env` already exists — `setup-signoz.sh` created it and pointed it at localhost.
You only need to add two values.

Open it from the VS Code file explorer (click `.env` in the left sidebar), or use
nano in the terminal:

```bash
nano .env
```

Set these lines:

```ini
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...                # from Step 0
SIGNOZ_API_KEY=...                  # from Step 4
```

Leave these exactly as the setup script wrote them:

```ini
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
SIGNOZ_API_URL=http://localhost:8080
SIGNOZ_INGESTION_KEY=
```

In nano: save with **Ctrl+O**, **Enter**, then exit with **Ctrl+X**.

---

## Step 6 — Verify with `doctor`

```bash
npm run doctor
```

You want three `OK` lines. Each credential is checked separately so a failure
points at exactly one thing:

| Failure | Meaning | Fix |
|---|---|---|
| `key rejected (401/403)` | LLM key wrong or revoked | Re-copy from the provider console |
| `model "..." not found` | Model name invalid for this provider | Set `AGENT_MODEL` to one the provider lists |
| `rate limited (429)` | Free-tier quota | Wait a minute, rerun |
| `WARNING: no tool_calls` | Model lacks function calling | Switch model — the project needs it |
| `SIGNOZ_API_URL ... 404` | Query service not up yet | Wait 60s, rerun |
| `SIGNOZ_API_KEY ... rejected (401/403)` | Key wrong or lacks a role | Recreate it (Step 4) |
| `OTEL_... connection refused` | Collector still starting | Wait 60s, rerun |

The LLM check deliberately makes a **real tool-calling request** rather than a
simple ping, because function calling is what the agent and judge actually
depend on and free-tier models vary in supporting it. Better to fail here than
three minutes into a demo.

**A SigNoz failure on the first attempt is expected.** ClickHouse and the query
service take a few minutes to become ready. Rerun before assuming anything is
broken.

---

## Step 7 — Import the dashboard

1. SigNoz UI → **Dashboards** → **+ New dashboard** → **Import JSON**.
2. Paste the contents of [`signoz/dashboard.json`](signoz/dashboard.json).

If your SigNoz version rejects the schema, **do not fight it.** Open
[`signoz/PANELS.md`](signoz/PANELS.md) and build the two panels that matter by
hand — each takes about twenty seconds in the query builder:

- **Groundedness by variant** (panel 2)
- **Agent latency p95 by variant** (panel 9)

Those two side by side *are* the demo. The rest are supporting detail.

---

## Step 8 — Run the demo

```bash
npm run demo
```

Five steps, roughly 3–4 minutes:

| Step | What it does |
|---|---|
| 1 | Runs the **baseline** agent over 8 tasks → traces to SigNoz |
| 2 | Waits 20s, then **queries SigNoz** and grades each run |
| 3 | Runs the **regressed** agent — grounding rules deleted from the prompt |
| 4 | Grades again, same pipeline, no code changed |
| 5 | Prints the before/after comparison |

Expect baseline to score high and regressed to collapse on groundedness,
especially on the trap tasks `T05`–`T07`.

> Seeing `No agent runs found in SigNoz`? Ingestion is lagging. Run
> `npm run eval -- --lookback 60` a minute later — the traces are not lost.
> `AGENTLENS_DEBUG=1 npm run eval` prints the raw query response.

---

## Step 9 — Close the loop

```bash
npm run gate -- --variant regressed    # exits 1 — build blocked
npm run gate -- --variant baseline     # exits 0 — quality fine
```

Check the exit code:

```bash
npm run gate -- --variant regressed; echo "exit code: $?"
```

---

## Step 10 — Record the demo

The single most important frame for judging: in SigNoz, put **Groundedness by
variant** directly above **Agent latency p95 by variant**.

Groundedness falls off a cliff between the two deploys. Latency stays flat.

Say this out loud while showing it:

> "Both deploys returned 200 OK on every request. Same latency, same error rate,
> same token count. Traditional monitoring cannot tell these two apart. The only
> reason we can see the second one is broken is that the agent's quality is
> telemetry."

Then show `npm run gate` exiting 1, and finish on the **Failure modes** panel —
it names the problem in plain language: `hallucinated_policy`, six times.

---

## Cost and quotas

- **Codespaces:** free personal accounts include 120 core-hours/month. A 4-core
  machine burns 4 core-hours per wall-clock hour, so ~30 hours of use. **Stop the
  Codespace when you finish** — Codespaces page → `...` → Stop.
- **LLM:** a full `npm run demo` is 16 agent runs + 16 judge calls. On Groq's or
  Gemini's free tier that costs nothing; you may hit a rate limit and need to
  rerun, which is safe.

---

## If you get truly stuck

Run these three and share the output:

```bash
npm run selftest        # 40 offline checks; no credentials needed
npm run doctor          # which credential is wrong
docker ps               # is SigNoz actually up
```

`npm run selftest` passing tells you the project logic is fine and the problem is
environmental — which narrows it down fast.
