#!/usr/bin/env bash
# Bring up a self-hosted SigNoz inside the devcontainer and point AgentLens at it.
#
# This exists because SigNoz Cloud signup can be gated on a company email address,
# and installing Docker locally needs admin rights. A Codespace has Docker already
# and needs neither.
set -euo pipefail

SIGNOZ_DIR="${HOME}/signoz"

echo "==> Cloning SigNoz"
if [ ! -d "${SIGNOZ_DIR}" ]; then
  git clone --depth 1 -b main https://github.com/SigNoz/signoz.git "${SIGNOZ_DIR}"
fi

echo "==> Starting SigNoz (this pulls several GB on first run; give it a few minutes)"
cd "${SIGNOZ_DIR}/deploy"
# The compose file has moved between SigNoz releases; try the known locations.
COMPOSE_FILE=""
for candidate in \
  "docker/docker-compose.yaml" \
  "docker/clickhouse-setup/docker-compose.yaml" \
  "docker-compose.yaml"
do
  if [ -f "${candidate}" ]; then
    COMPOSE_FILE="${candidate}"
    break
  fi
done

if [ -z "${COMPOSE_FILE}" ]; then
  echo "!! Could not find a SigNoz compose file under $(pwd)."
  echo "   Look for one manually and run: docker compose -f <file> up -d"
  exit 1
fi

echo "==> Using ${COMPOSE_FILE}"
docker compose -f "${COMPOSE_FILE}" up -d

cd - >/dev/null

echo "==> Writing .env for the self-hosted endpoints"
if [ ! -f .env ]; then
  cp .env.example .env
fi

# Self-hosted needs no ingestion key and no API key; AgentLens omits both headers
# when they are blank.
python3 - <<'PY'
import re, pathlib
p = pathlib.Path(".env")
text = p.read_text()
text = re.sub(r"^OTEL_EXPORTER_OTLP_ENDPOINT=.*$", "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318", text, flags=re.M)
text = re.sub(r"^SIGNOZ_API_URL=.*$", "SIGNOZ_API_URL=http://localhost:8080", text, flags=re.M)
text = re.sub(r"^SIGNOZ_INGESTION_KEY=.*$", "SIGNOZ_INGESTION_KEY=", text, flags=re.M)
text = re.sub(r"^SIGNOZ_API_KEY=.*$", "SIGNOZ_API_KEY=", text, flags=re.M)
p.write_text(text)
print("   .env updated")
PY

cat <<'EOF'

==============================================================
 SigNoz is starting up in the background.

 Next (full walkthrough is in RUNBOOK.md):
   1. Open the SigNoz UI on forwarded port 8080 (Ports tab) and create
      the first admin user. Any email works - this is your own instance.
   2. In SigNoz: Settings -> API Keys -> create a key. Reads are
      authenticated even locally, so this one IS required.
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
