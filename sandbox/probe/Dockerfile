FROM docker.io/library/debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl iproute2 util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --create-home sandbox \
    && mkdir -p /sandbox/output /workspace/base /workspace/input /workspace/project \
    && printf 'base-marker\n' > /workspace/base/canary.txt \
    && printf 'input-marker\n' > /workspace/input/canary.txt \
    && printf 'project-marker\n' > /workspace/project/canary.txt \
    && chown -R 10001:10001 /home/sandbox /sandbox /workspace

COPY canary.sh /usr/local/bin/orchestrator-canary
COPY mount-canary.sh /usr/local/bin/orchestrator-mount-canary
RUN chmod 0555 /usr/local/bin/orchestrator-canary /usr/local/bin/orchestrator-mount-canary

WORKDIR /sandbox

ENV HOME=/home/sandbox

USER 10001:10001

CMD ["/bin/sh"]
