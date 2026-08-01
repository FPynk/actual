FROM node:22.18.0-bookworm-slim AS build

WORKDIR /workspace

COPY . .
RUN corepack enable && yarn install --immutable && yarn workspace @actual-app/api build && yarn workspace @actual-app/finance-companion build && yarn workspaces focus @actual-app/finance-companion --production

FROM node:22.18.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --gid 10001 finance-companion && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin finance-companion

COPY --from=build --chown=10001:10001 /workspace/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /workspace/packages/api ./packages/api
COPY --from=build --chown=10001:10001 /workspace/packages/finance-companion/dist ./packages/finance-companion/dist
COPY --from=build --chown=10001:10001 /workspace/packages/finance-companion/migrations ./packages/finance-companion/migrations
COPY --from=build --chown=10001:10001 /workspace/packages/finance-companion/package.json ./packages/finance-companion/package.json

RUN mkdir /actual-api /data /integrity-anchor /tmp && touch /actual-api/.volume-owner /data/.volume-owner /integrity-anchor/.volume-owner && chown -R finance-companion:finance-companion /actual-api /data /integrity-anchor /tmp && chmod 0700 /actual-api /data /integrity-anchor && chmod 1770 /tmp

USER 10001:10001
WORKDIR /app/packages/finance-companion

CMD ["node", "dist/service/cli.js", "start"]
