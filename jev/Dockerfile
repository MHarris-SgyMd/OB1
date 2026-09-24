# The typed-decision tier (SMD-2050): jev/serve.ts on Bun, onnxruntime-node
# on the CPU. Built from the REPO ROOT, like the server's image, because the
# service imports server-portable/jev-contract.ts — the one definition of the
# wire contract, shared with the client.
#
# Debian slim, not the alpine the server runs on: onnxruntime-node ships
# glibc binaries (linux x64 and arm64) and has no musl build.
#
# No weights in the image. The model is referenced, not vendored: serve.ts
# fetches the pinned files into JEV_MODEL_DIR (a volume) on first start and
# verifies every file's sha256 on every start (jev/fetch-model.ts).
FROM oven/bun:1.4.0-slim AS deps
WORKDIR /app/jev
COPY jev/package.json jev/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0-slim
WORKDIR /app/jev
ENV NODE_ENV=production JEV_HOST=0.0.0.0 JEV_PORT=8020 JEV_MODEL_DIR=/models
COPY --from=deps /app/jev/node_modules ./node_modules
COPY jev/*.ts jev/package.json ./
COPY server-portable/jev-contract.ts /app/server-portable/jev-contract.ts
# The volume mounts here; a directory the image owns gives a fresh named volume
# the same owner, so the unprivileged user can write the fetched files.
RUN mkdir -p /models && chown bun:bun /models
USER bun
EXPOSE 8020
ENTRYPOINT ["bun", "serve.ts"]

# Healthy once the model is loaded: serve.ts listens only after it is. The
# first start fetches 606 MB, hence the long start period. The slim image has
# neither wget nor curl; Bun's fetch is the probe.
HEALTHCHECK --interval=10s --timeout=3s --start-period=600s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.JEV_PORT || 8020) + '/health'); process.exit(r.ok ? 0 : 1)"
