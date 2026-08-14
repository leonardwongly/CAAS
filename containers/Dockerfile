# syntax=docker/dockerfile:1
FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS dependencies
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.5.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/route-engine/package.json packages/route-engine/package.json
COPY packages/upstream-caas/package.json packages/upstream-caas/package.json
COPY tests/package.json tests/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm run build

FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TMPDIR=/tmp \
    WEB_ASSET_DIR=/app/apps/web/dist

RUN groupadd --system app && useradd --system --gid app --home-dir /app --no-create-home app \
    && mkdir -p /tmp \
    && chmod 1777 /tmp
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /workspace/packages/route-engine/package.json ./packages/route-engine/package.json
COPY --from=build /workspace/packages/upstream-caas/package.json ./packages/upstream-caas/package.json
# Production dependencies only: the runtime image must not carry the dev/test
# toolchain (vite, vitest, jsdom, typescript, test doubles) that built it.
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate && pnpm install --prod --frozen-lockfile
COPY --from=build /workspace/apps/api ./apps/api
COPY --from=build /workspace/apps/web/dist ./apps/web/dist
COPY --from=build /workspace/packages ./packages
RUN chown -R app:app /app

USER app
VOLUME ["/tmp"]
EXPOSE 8080
ENTRYPOINT ["node", "--experimental-strip-types", "apps/api/src/cli.ts"]
CMD ["--host", "0.0.0.0", "--port", "8080"]
