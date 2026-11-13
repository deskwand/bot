# Build context is the repository root: docker build -f container/Dockerfile .
FROM node:26-bookworm-slim AS build

ARG VERSION=dev
WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:container -- --version "$VERSION"

# The install picks the binary matching the build platform; buildx builds each
# target architecture in its own build stage.
RUN mkdir -p /out \
 && cp node_modules/@cloudflare/workerd-linux-*/bin/workerd /out/workerd

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home deskwand \
 && mkdir -p /app /data \
 && chown deskwand:deskwand /app /data

COPY --from=build /out/workerd /usr/local/bin/workerd
COPY --from=build --chown=deskwand:deskwand /src/dist/container/ /app/

USER deskwand
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
