FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/node
COPY node/package.json node/package-lock.json ./
COPY node/vendor/zod-to-openapi ./vendor/zod-to-openapi
RUN node -e "const fs=require('fs'); const p='vendor/zod-to-openapi/package.json'; const pkg=JSON.parse(fs.readFileSync(p, 'utf8')); if (pkg.scripts) delete pkg.scripts.prepare; fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\\n');"
RUN cd vendor/zod-to-openapi \
    && npm ci --include=dev --ignore-scripts
RUN cd vendor/zod-to-openapi \
    && ./node_modules/.bin/rollup -c
RUN node -e "const fs=require('fs'); const p='vendor/zod-to-openapi/package.json'; const pkg=JSON.parse(fs.readFileSync(p, 'utf8')); delete pkg.devDependencies; fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\\n');"
RUN rm -rf vendor/zod-to-openapi/node_modules/zod
RUN npm ci --include=dev --ignore-scripts
# Prisma 7 downloads the native schema engine on the first CLI invocation.
# Fetch it while building the image and carry the cache into runtime so
# migrations do not depend on Internet access when the container starts.
RUN DATABASE_URL=postgresql://app:app@127.0.0.1:5432/vehicle_platform?schema=public \
    ./node_modules/.bin/prisma --version

COPY node/ ./
COPY operator-web/ /workspace/operator-web/
RUN npm run build \
    && rm -rf vendor/zod-to-openapi/node_modules

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/node
ENV NODE_ENV=production
COPY --from=build /workspace/node /workspace/node
COPY --from=build /workspace/operator-web /workspace/operator-web
COPY --from=build /root/.cache/prisma /root/.cache/prisma
COPY docker/node-entrypoint.sh /usr/local/bin/p4-node-entrypoint
EXPOSE 3000
ENTRYPOINT ["/bin/sh", "/usr/local/bin/p4-node-entrypoint"]
CMD ["node", "/workspace/node/dist/server.js"]
