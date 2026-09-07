FROM node:20-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/sdk ./packages/sdk
COPY services/node-relayer ./services/node-relayer
RUN pnpm install --frozen-lockfile --filter @agrifeed/node-relayer... \
    && pnpm --filter @agrifeed/sdk build \
    && pnpm --filter @agrifeed/node-relayer build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /repo/pnpm-workspace.yaml /repo/package.json /repo/pnpm-lock.yaml ./
COPY --from=build /repo/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /repo/services/node-relayer/package.json ./services/node-relayer/package.json
COPY --from=build /repo/services/node-relayer/dist ./services/node-relayer/dist
RUN pnpm install --frozen-lockfile --prod --filter @agrifeed/node-relayer...

# NODE_RELAYER_SECRET_KEY must be injected at runtime (e.g. as a Docker
# secret or platform env var), never baked into the image.
CMD ["node", "services/node-relayer/dist/index.js"]
