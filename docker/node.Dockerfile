FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p -m 0700 /root/.ssh \
    && ssh-keyscan github.com >> /root/.ssh/known_hosts

WORKDIR /app/node
COPY node/package.json node/package-lock.json ./
RUN --mount=type=ssh npm ci --include=dev

COPY node/ ./
COPY operator-web/ /app/operator-web/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/node
ENV NODE_ENV=production
COPY --from=build /app/node /app/node
COPY --from=build /app/operator-web /app/operator-web
EXPOSE 3000
CMD ["node", "/app/node/dist/server.js"]
