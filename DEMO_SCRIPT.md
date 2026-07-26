# Demo recording script

Target: **90 seconds**. Judges watch dozens of these; a tight 90 seconds beats a
rambling five minutes.

---

## The token-saving trick

Generating agent runs costs LLM tokens. **Reading them back does not.**

- `npm run agent` / `npm run eval` / `npm run demo` — cost tokens
- `npm run gate`, browsing SigNoz dashboards, viewing traces — **free, unlimited**

So: **generate data once, then record as many takes as you like.** Do not re-run
the agent between takes.

---

## Phase 1 — generate the data (do this BEFORE recording)

In the Codespace, once SigNoz is up and `.env` is filled in:

```bash
# Baseline: the good deploy
npm run agent -- --variant baseline --repeat 2 --tasks T05,T06,T07
sleep 25
npm run eval -- --lookback 15 --variant baseline

# The regression
npm run agent -- --variant regressed --repeat 2 --tasks T05,T06,T07
sleep 25
npm run eval -- --lookback 15 --variant regressed
```

Roughly 12 agent runs + 12 judge calls, about 70k tokens. Well inside a daily
free allowance.

**Confirm before you start recording:**

```bash
npm run gate -- --variant baseline    # should exit 0
npm run gate -- --variant regressed   # should exit 1
```

If the regressed gate does not fail, the data is not there yet — wait 30s for
ingestion and re-check. Do not start recording until both behave.

---

## Phase 2 — set up SigNoz for the shot

Open your dashboard and arrange **two panels, one directly above the other**:

1. **Groundedness by variant**
2. **Agent latency p95 by variant**

Both grouped by `agentlens.variant`, both over the same time window. Set the
window to the last 30 minutes so both variants are visible.

This single frame is the whole argument. Get it right before you press record.

---

## Phase 3 — record

### Recording on Windows

**Xbox Game Bar** is built in, no install:

- `Win + G` opens it, `Win + Alt + R` starts and stops recording
- Records the **active window** — click the browser or terminal first
- Output lands in `Videos\Captures`

It will not record File Explorer or the desktop, only app windows. If you need
full-screen or multi-window, use [OBS Studio](https://obsproject.com) instead.

In a Codespace, the terminal is inside the browser, so recording the browser
window captures both SigNoz and the terminal.

---

### Scene 1 — the problem (0:00–0:20)

**Show:** the two stacked panels in SigNoz.

> "This is a customer support AI agent, traced with OpenTelemetry into SigNoz.
> Two deploys, an hour apart. Look at the bottom panel first — latency is
> completely flat. No errors, every request returned 200 OK.
> Now the top panel. Groundedness fell off a cliff."

Point the cursor at the drop. Do not rush this — it is the whole point.

---

### Scene 2 — what broke (0:20–0:45)

**Show:** the Failure modes table, then click into a failing evaluation span.

> "Groundedness is the fraction of the agent's factual claims that a tool result
> actually supports. It dropped because someone shipped this prompt change —
> 'be maximally helpful and confident, always give a concrete answer.' No syntax
> error. No failing test. It just makes the agent invent policies.
>
> Every failing evaluation links straight back to the conversation that caused
> it. Here the agent told a customer 'we don't offer a price-match guarantee' —
> that policy does not exist in the knowledge base. The judge caught the exact
> sentence."

---

### Scene 3 — how it works (0:45–1:05)

**Show:** the span tree of one agent run — `invoke_agent` with `chat` and
`execute_tool` children.

> "Every LLM call and every tool call is a span, using OpenTelemetry's GenAI
> semantic conventions. And this is the part that matters: the evaluator never
> touches the agent. It queries finished traces out of SigNoz, rebuilds each run
> from its spans, grades it, and writes the scores back in as metrics.
>
> Because it only reads telemetry, it can grade any traced agent in any language
> — including runs that happened yesterday."

---

### Scene 4 — the payoff (1:05–1:30)

**Show:** the terminal. Run both gates live — they cost nothing, so retake freely.

```bash
npm run gate -- --variant regressed
```

> "And because quality is a signal, CI can block on it."

Let the failure print, then show the exit code:

```bash
echo $?     # 1
npm run gate -- --variant baseline
echo $?     # 0
```

> "Bad deploy blocked. A hallucination is a 200 OK — latency and error rate can
> never see it. This can."

**End there.** Do not add a summary.

---

## If you run out of time or tokens

Record Scene 1 alone. Twenty seconds of groundedness collapsing while latency
stays flat communicates more than five minutes of code walkthrough.

If SigNoz never comes up, record `npm run smoke -- --compare --tasks T05,T06,T07`
in the terminal instead. It shows the agent, the judge and the regression — but
be honest in your submission that the SigNoz screenshots are missing, rather than
implying a run that did not happen.

---

## After recording

1. Upload to YouTube as **unlisted**, or use [Loom](https://loom.com).
2. Put the link at the very top of the README, above everything else.
3. Take two still screenshots as backup — the stacked panels, and the failure
   modes table. Some judges skim images and never play video.

---

## Things that undercut a demo

- Reading the README aloud instead of showing the product
- Starting with architecture. Start with the broken behaviour.
- Apologising for what is unfinished. State what works.
- Explaining tokens or model choice. Nobody scoring this cares.
- Silent dead air while a command runs. Cut it, or talk over it.
