ARG NODE_VERSION=24.18.0
ARG NODE_IMAGE=docker.io/library/node:24.18.0-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5
ARG NAPCAT_IMAGE=docker.io/mlikiowa/napcat-docker:v4.15.0@sha256:cde89d766604e570517e9ce66304d4222210479d2209ec04e5d58890dea087f7

FROM ${NODE_IMAGE} AS build
ARG NODE_VERSION
RUN test "$(/usr/local/bin/node -p 'process.versions.node')" = "$NODE_VERSION"

WORKDIR /srv/sunabot
COPY package.json package-lock.json ./
RUN npm ci
COPY AGENTS.md tsconfig.json tsconfig.web.json postcss.config.cjs tailwind.config.ts ./
COPY src ./src
COPY apps/api ./apps/api
COPY services ./services
COPY adapters ./adapters
COPY packages ./packages
COPY apps/admin-web ./apps/admin-web
COPY tooling/quality ./tooling/quality
COPY tooling/shared ./tooling/shared
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS node-runtime
FROM ${NAPCAT_IMAGE} AS napcat-root

# Start from the pinned NapCat/QQ root filesystem without inheriting its two
# VOLUME declarations. The final image therefore has no hidden anonymous
# volumes and Compose owns the single workspace mount.
FROM scratch AS runtime
COPY --from=napcat-root / /
COPY --from=node-runtime /usr/local /usr/local

ARG SUNABOT_RELEASE_VERSION=0.1.0
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production \
    SUNABOT_RELEASE_VERSION=${SUNABOT_RELEASE_VERSION} \
    SUNABOT_WORKSPACE=/srv/sunabot/workspace \
    SUNABOT_HOST=0.0.0.0 \
    SUNABOT_PORT=8787 \
    HOME=/app \
    XDG_CONFIG_HOME=/app/.config \
    XDG_CACHE_HOME=/app/.cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends --fix-broken \
    && apt-get install -y --no-install-recommends \
        bubblewrap=0.6.1-1ubuntu0.1 \
        fonts-noto-cjk=1:20220127+repack1-1 \
        libreoffice=1:7.3.7-0ubuntu0.22.04.11 \
        tini=0.19.0-1 \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=1000:1000 deploy/runtime-contract.json /srv/sunabot/deploy/runtime-contract.json

RUN napcat_config="$(/usr/local/bin/node -e 'const fs=require("node:fs");const contract=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const value=contract.paths[process.argv[2]];if(typeof value!=="string"||value.startsWith("/")||value.split(/[\\/]/).includes(".."))throw new Error("invalid runtime path");process.stdout.write(value)' /srv/sunabot/deploy/runtime-contract.json napcatConfig)" \
    && napcat_state="$(/usr/local/bin/node -e 'const fs=require("node:fs");const contract=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const value=contract.paths[process.argv[2]];if(typeof value!=="string"||value.startsWith("/")||value.split(/[\\/]/).includes(".."))throw new Error("invalid runtime path");process.stdout.write(value)' /srv/sunabot/deploy/runtime-contract.json napcatState)" \
    && napcat_qr="$(/usr/local/bin/node -e 'const fs=require("node:fs");const contract=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const value=contract.paths[process.argv[2]];if(typeof value!=="string"||value.startsWith("/")||value.split(/[\\/]/).includes(".."))throw new Error("invalid runtime path");process.stdout.write(value)' /srv/sunabot/deploy/runtime-contract.json napcatQrCode)" \
    && test "$(dirname "$napcat_qr")" = "$napcat_state" \
    && rm -rf /app/napcat /app/.config/QQ \
    && mkdir -p \
        /app/napcat \
        /app/napcat-default-config \
        /app/.cache/fontconfig \
        /app/.cache/mesa_shader_cache \
        /app/.cache/mesa_shader_cache_db \
        /app/.config \
        /srv/sunabot/workspace \
    && unzip -q /app/NapCat.Shell.zip -d /app/napcat \
    && cp -a /app/napcat/config/. /app/napcat-default-config/ \
    && rm -rf /app/napcat/config \
    && ln -s "$SUNABOT_WORKSPACE/$napcat_config" /app/napcat/config \
    && rm -rf /app/napcat/cache \
    && ln -s "$SUNABOT_WORKSPACE/$napcat_state" /app/napcat/cache \
    && ln -s "$SUNABOT_WORKSPACE/$napcat_state/qq" /app/.config/QQ \
    && chown -R 1000:1000 \
        /app/napcat \
        /app/napcat-default-config \
        /app/.cache \
        /app/.config \
        /srv/sunabot \
    && chown -h 1000:1000 /app/napcat/config /app/napcat/cache /app/.config/QQ

WORKDIR /srv/sunabot
COPY --from=build --chown=1000:1000 /srv/sunabot/package.json ./package.json
COPY --from=build --chown=1000:1000 /srv/sunabot/package-lock.json ./package-lock.json
COPY --from=build --chown=1000:1000 /srv/sunabot/AGENTS.md ./AGENTS.md
COPY --from=build --chown=1000:1000 /srv/sunabot/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /srv/sunabot/dist ./dist
COPY --from=build --chown=1000:1000 /srv/sunabot/apps/admin-web/dist ./apps/admin-web/dist
COPY --chown=1000:1000 deploy/docker/supervisor.mjs ./deploy/docker/supervisor.mjs
COPY --chown=1000:1000 deploy/docker/healthcheck.mjs ./deploy/docker/healthcheck.mjs
COPY --chown=1000:1000 packages/platform/napcatRuntimeLayout.mjs ./packages/platform/napcatRuntimeLayout.mjs
COPY --chown=1000:1000 components/component.lock.json ./components/component.lock.json

LABEL org.opencontainers.image.title="sunabot-qq-runtime" \
      org.opencontainers.image.version="${SUNABOT_RELEASE_VERSION}" \
      org.opencontainers.image.description="Sunabot and NapCat supervised in one local QQ runtime"

USER 1000:1000
EXPOSE 8787 6099
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=6 \
  CMD ["/usr/local/bin/node", "/srv/sunabot/deploy/docker/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "/srv/sunabot/deploy/docker/supervisor.mjs"]
