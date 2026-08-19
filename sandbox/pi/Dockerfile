FROM docker.io/library/node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

ARG PI_VERSION=0.84.2
ARG CLIENT_VERSION=0.2.2

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git iproute2 procps tar util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && test "$(pi --version)" = "${PI_VERSION}" \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --create-home sandbox \
    && mkdir -p /sandbox/output /workspace/base /workspace/input /workspace/project \
    && chown -R 10001:10001 /home/sandbox /sandbox /workspace

COPY client/ /usr/local/lib/pi-orchestrator/client/
COPY start.sh /usr/local/bin/orchestrator-start-pi
COPY export.mjs /usr/local/bin/orchestrator-export-patch

RUN printf '{"client_version":"%s","pi_version":"%s"}\n' "$CLIENT_VERSION" "$PI_VERSION" > /usr/local/lib/pi-orchestrator/runtime.json \
    && chmod -R a-w /usr/local/lib/pi-orchestrator \
    && chmod 0555 /usr/local/bin/orchestrator-start-pi /usr/local/bin/orchestrator-export-patch

ENV HOME=/home/sandbox \
    PI_CODING_AGENT_DIR=/home/sandbox/.pi/agent \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0

WORKDIR /workspace/project
USER 10001:10001
CMD ["/bin/sh"]
