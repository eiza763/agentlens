#!/usr/bin/env bash
# Bring up a self-hosted SigNoz inside the devcontainer and point AgentLens at it.
#
# This exists because SigNoz Cloud signup can be gated on a company email address,
# and installing Docker locally needs admin rights. A Codespace has Docker already
# and needs neither.
#
# SigNoz deleted its docker-compose manifests and deprecated deploy/install.sh.
# Self-hosting is now declarative: `foundryctl cast` reads casting.yaml, generates
# compose files under pours/, and starts the stack. Cloning the SigNoz repo is not
# part of the process at all any more.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASTING_FILE="${REPO_ROOT}/casting.yaml"

# foundryctl generates a pours/ directory in its working directory. Keep that
# outside the repo so it never shows up as untracked noise in `git status`.
POUR_DIR="${HOME}/signoz-foundry"

echo "==> Installing foundryctl"
if command -v foundryctl >/dev/null 2>&1; then
  echo "    already installed: $(command -v foundryctl)"
else
  curl -fsSL https://signoz.io/foundry.sh | bash
fi

# The installer drops the binary in ~/.local/bin, which is not always on PATH
# yet in a fresh non-login shell.
export PATH="${HOME}/.local/bin:${PATH}"

if ! command -v foundryctl >/dev/null 2>&1; then
  echo "!! foundryctl is not on PATH after install."
  echo "   Look for it under ~/.local/bin and add that directory to PATH."
  exit 1
fi

echo "==> Starting SigNoz (this pulls several GB on first run; give it a few minutes)"
mkdir -p "${POUR_DIR}"
cp "${CASTING_FILE}" "${POUR_DIR}/casting.yaml"
cd "${POUR_DIR}"
foundryctl cast -f casting.yaml
cd "${REPO_ROOT}"

echo "==> Writing .env for the self-hosted endpoints"
if [ ! -f .env ]; then
  cp .env.example .env
fi

# Self-hosted needs no ingestion key; AgentLens omits the header when it is blank.
# SIGNOZ_API_KEY is deliberately NOT reset here: reads do need it, only you can
# mint it (see the banner below), and blanking it would wipe it on a re-run.
python3 - <<'PY'
import re, pathlib
p = pathlib.Path(".env")
text = p.read_text()
text = re.sub(r"^OTEL_EXPORTER_OTLP_ENDPOINT=.*$", "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318", text, flags=re.M)
text = re.sub(r"^SIGNOZ_API_URL=.*$", "SIGNOZ_API_URL=http://localhost:8080", text, flags=re.M)
text = re.sub(r"^SIGNOZ_INGESTION_KEY=.*$", "SIGNOZ_INGESTION_KEY=", text, flags=re.M)
p.write_text(text)
print("   .env updated")
PY

cat <<'EOF'

==============================================================
 SigNoz is starting up in the background.

 Next (full walkthrough is in RUNBOOK.md):
   1. Open the SigNoz UI on forwarded port 8080 (Ports tab) and create
      the first admin user. Any email works - this is your own instance.
   2. Mint a read key at:  /settings/service-accounts
      New Service Account -> Keys tab -> Add Key. The "signoz-viewer"
      role is enough: AgentLens only reads through the query API and
      writes its scores back as OTLP telemetry.
      (Current SigNoz builds have no "API Keys" page.)
   3. Put both keys in .env:
        GROQ_API_KEY=gsk_...  (free, no card: console.groq.com)
        SIGNOZ_API_KEY=<the key from step 2>
   4. Then:

        npm run doctor
        npm run demo

 First startup pulls several GB and ClickHouse takes 2-3 minutes
 to accept writes. If `npm run doctor` fails on the SigNoz checks,
 wait a minute and run it again.
==============================================================

EOF
