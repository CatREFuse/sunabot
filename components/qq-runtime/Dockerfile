FROM node:24-bookworm-slim AS build

WORKDIR /srv/sunabot
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.web.json postcss.config.cjs tailwind.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libreoffice python3 tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/sunabot
ENV NODE_ENV=production \
    SUNABOT_WORKSPACE=/srv/sunabot/workspace \
    SUNABOT_HOST=0.0.0.0 \
    SUNABOT_PORT=8787

COPY --from=build --chown=node:node /srv/sunabot/package.json ./package.json
COPY --from=build --chown=node:node /srv/sunabot/package-lock.json ./package-lock.json
COPY --from=build --chown=node:node /srv/sunabot/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/sunabot/dist ./dist

USER node
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
