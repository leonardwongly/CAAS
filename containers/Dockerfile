# syntax=docker/dockerfile:1
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS dependencies
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

FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime
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
# The lockfile/workspace metadata are build-time inputs: removing them after
# the install keeps the image's dependency surface honest (vulnerability
# scanners would otherwise flag dev-toolchain ranges from the shipped
# lockfile that are not installed).
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate && pnpm install --prod --frozen-lockfile \
    && corepack disable \
    && rm -rf /root/.cache/node/corepack /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/npm /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
    && rm pnpm-lock.yaml pnpm-workspace.yaml
COPY --from=build /workspace/apps/api ./apps/api
COPY --from=build /workspace/apps/web/dist ./apps/web/dist
COPY --from=build /workspace/packages ./packages
RUN chown -R app:app /app

USER app
VOLUME ["/tmp"]
EXPOSE 8080
ENTRYPOINT ["node", "--experimental-strip-types", "apps/api/src/cli.ts"]
CMD ["--host", "0.0.0.0", "--port", "8080"]
