FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p -m 0700 /root/.ssh \
    && ssh-keyscan github.com >> /root/.ssh/known_hosts

WORKDIR /workspace/node
COPY node/package.json node/package-lock.json ./
RUN --mount=type=ssh npm ci --include=dev

COPY node/ ./
COPY operator-web/ /workspace/operator-web/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/node
ENV NODE_ENV=production
COPY --from=build /workspace/node /workspace/node
COPY --from=build /workspace/operator-web /workspace/operator-web
COPY docker/node-entrypoint.sh /usr/local/bin/p4-node-entrypoint
EXPOSE 3000
ENTRYPOINT ["/bin/sh", "/usr/local/bin/p4-node-entrypoint"]
CMD ["node", "/workspace/node/dist/server.js"]
