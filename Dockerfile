# Build stage: install deps and compile the monorepo.
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Runtime stage: API server. node_modules is copied as-is so pnpm's
# workspace symlinks (packages/* → node_modules) stay intact.
FROM node:20-slim AS api
ENV NODE_ENV=production
ENV PORT=8787
RUN corepack enable
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
EXPOSE 8787
CMD ["node", "apps/api/dist/index.js"]
