# The egress probe's watcher (SMD-2210; compose.n8n-sealed.yaml): tcpdump,
# nothing else. Built on the default network, where apk can reach its mirror.
# It runs on the sealed network, where nothing can.
FROM docker.io/library/alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
RUN apk add --no-cache tcpdump
ENTRYPOINT ["tcpdump"]
