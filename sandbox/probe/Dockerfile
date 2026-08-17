FROM docker.io/library/debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl iproute2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --create-home sandbox

WORKDIR /sandbox
RUN chown 10001:10001 /sandbox

USER 10001:10001

CMD ["/bin/sh"]
