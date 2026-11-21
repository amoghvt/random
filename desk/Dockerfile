# syntax=docker/dockerfile:1.7
# Build context is this directory (desk/). One image runs the API, the worker loop and serves the web export.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# Manifests only, so dependency layers are reused until a package.json or the lockfile changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/engines/package.json packages/engines/
COPY packages/feeds/package.json packages/feeds/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Static web export. The build stops here, loudly, if apps/web is missing or its build writes no export.
FROM manifests AS web
RUN pnpm install --frozen-lockfile
COPY . .
RUN test -f apps/web/package.json || { echo "apps/web is missing: the image needs the @desk/web package" >&2; exit 1; }
RUN pnpm --filter @desk/web build \
 && { test -f apps/web/out/index.html || { echo "@desk/web build wrote no apps/web/out/index.html" >&2; exit 1; }; }

# Production dependencies of the API and the workspace packages it imports (tsx runs the TypeScript directly).
FROM manifests AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@desk/api..."

FROM base AS runtime
ENV NODE_ENV=production PORT=8080
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages ./packages
COPY --from=prod-deps /app/apps/api ./apps/api
COPY package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json profile.yaml ./
COPY accounts ./accounts
COPY data ./data
COPY packages ./packages
COPY apps/api ./apps/api
COPY --from=web /app/apps/web/out ./apps/web/out
USER node
WORKDIR /app/apps/api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Same as `tsx src/main.ts`, without the wrapper process: node is PID 1 and receives SIGTERM itself.
CMD ["node", "--import", "tsx", "src/main.ts"]
