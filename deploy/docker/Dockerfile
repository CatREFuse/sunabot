ARG NODE_VERSION=24.18.0
ARG NODE_IMAGE=docker.io/library/node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

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
COPY tooling/runtime ./tooling/runtime
COPY tooling/shared ./tooling/shared
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG NODE_VERSION
ARG SUNABOT_RELEASE_VERSION=0.1.3
ARG CODEX_CLI_VERSION=0.139.0
ARG BUBBLEWRAP_VERSION=0.8.0-2+deb12u1
ARG FONTS_NOTO_CJK_VERSION=1:20220127+repack1-1
ARG TINI_VERSION=0.19.0-1+b3

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    NODE_ENV=production \
    SUNABOT_RELEASE_VERSION=${SUNABOT_RELEASE_VERSION} \
    SUNABOT_WORKSPACE=/srv/sunabot/workspace \
    SUNABOT_HOST=0.0.0.0 \
    SUNABOT_PORT=8787 \
    SUNABOT_ONEBOT_HOST=0.0.0.0 \
    SUNABOT_ONEBOT_PORT=8788

RUN test "$(/usr/local/bin/node -p 'process.versions.node')" = "$NODE_VERSION" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap="${BUBBLEWRAP_VERSION}" \
        fonts-noto-cjk="${FONTS_NOTO_CJK_VERSION}" \
        tini="${TINI_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /srv/sunabot/workspace \
    && chown -R 1000:1000 /srv/sunabot
RUN test -x /usr/bin/bwrap
RUN npm install --global --omit=dev --no-audit --no-fund "@openai/codex@${CODEX_CLI_VERSION}" \
    && test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}"

WORKDIR /srv/sunabot
COPY --from=build --chown=1000:1000 /srv/sunabot/package.json ./package.json
COPY --from=build --chown=1000:1000 /srv/sunabot/package-lock.json ./package-lock.json
COPY --from=build --chown=1000:1000 /srv/sunabot/AGENTS.md ./AGENTS.md
COPY --from=build --chown=1000:1000 /srv/sunabot/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /srv/sunabot/dist ./dist
COPY --from=build --chown=1000:1000 /srv/sunabot/apps/admin-web/dist ./apps/admin-web/dist
COPY --chown=1000:1000 codex-skills/workbench-config ./codex-skills/workbench-config
COPY --chown=1000:1000 deploy/runtime-contract.json ./deploy/runtime-contract.json
COPY --chown=1000:1000 deploy/docker/healthcheck.mjs ./deploy/docker/healthcheck.mjs
COPY --chown=1000:1000 components/component.lock.json ./components/component.lock.json
COPY --chmod=0555 deploy/docker/mcp-test-server.mjs /usr/local/bin/sunabot-mcp-test-server
COPY --chmod=0444 deploy/docker/mcp-executables.json /opt/sunabot/mcp/executables.json

RUN /usr/local/bin/node -e 'const fs=require("node:fs"),crypto=require("node:crypto");const value=JSON.parse(fs.readFileSync("/opt/sunabot/mcp/executables.json","utf8"));if(value.schemaVersion!==1||!Array.isArray(value.executables)||value.executables.length<1||value.executables.length>128||new Set(value.executables.map((item)=>item.path)).size!==value.executables.length)process.exit(1);for(const item of value.executables){if(!item||typeof item.path!=="string"||!item.path.startsWith("/")||!item.sha256?.match(/^[a-f0-9]{64}$/)||(fs.statSync(item.path).mode&0o111)===0||crypto.createHash("sha256").update(fs.readFileSync(item.path)).digest("hex")!==item.sha256)process.exit(1)}'

LABEL org.opencontainers.image.title="sunabot-core" \
      org.opencontainers.image.version="${SUNABOT_RELEASE_VERSION}" \
      org.opencontainers.image.description="Sunabot Core application runtime"

USER 1000:1000
EXPOSE 8787 8788
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=6 \
  CMD ["/usr/local/bin/node", "/srv/sunabot/deploy/docker/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "/srv/sunabot/dist/apps/api/main.js"]
