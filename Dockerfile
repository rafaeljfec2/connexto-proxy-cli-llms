# syntax=docker/dockerfile:1

ARG NODE_VERSION=24.22.1

FROM node:${NODE_VERSION}-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable \
  && corepack prepare pnpm@11.12.0 --activate \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build

WORKDIR /app

ENV CI=true
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api apps/api
COPY packages packages
COPY tsconfig.json ./

RUN pnpm install --frozen-lockfile --prod --filter @agent-runtime-gateway/api...

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini git \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 gateway \
  && useradd --system --uid 1001 --gid gateway --home-dir /app gateway \
  && mkdir -p /var/lib/connexto-proxy/sessions \
  && chown -R gateway:gateway /var/lib/connexto-proxy

WORKDIR /app

COPY --from=build --chown=gateway:gateway /app /app

USER gateway

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/server.ts"]
