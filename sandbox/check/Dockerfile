FROM docker.io/library/node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates iproute2 tar \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --create-home sandbox \
    && mkdir -p /sandbox/input /sandbox/output /workspace/base /workspace/input /workspace/project \
    && chown -R 10001:10001 /home/sandbox /sandbox /workspace/project

COPY prepare.mjs /usr/local/bin/orchestrator-prepare-check

RUN chmod 0555 /usr/local/bin/orchestrator-prepare-check \
    && chmod -R a-w /workspace/base /workspace/input

ENV HOME=/home/sandbox

WORKDIR /workspace/project
USER 10001:10001
CMD ["/bin/sh"]
