FROM denoland/deno:2.3.3

# Built with integrations/ as the context — `docker build -f Dockerfile ..` from
# this directory — because index.ts imports the shared auth module from
# ../_shared/auth.ts (ob1-fork, SMD-1455) and Docker cannot COPY from outside
# the context. The image mirrors the repository layout so the import resolves.
WORKDIR /app/kubernetes-deployment

# Copy dependency manifest and cache dependencies
COPY kubernetes-deployment/deno.json ./
RUN deno install

# Copy the shared auth module and the server source
COPY _shared/auth.ts /app/_shared/auth.ts
COPY kubernetes-deployment/index.ts ./

# Run as non-root
USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
