# Server + web in one image: Fastify serves the API and WebSocket; the built web app is served
# as static files from the same origin, so the client needs no configuration.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/assistant.db STATIC_DIR=/app/web/dist
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/protocol/package.json packages/protocol/
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/package.json web/
COPY --from=build /app/web/dist web/dist
RUN npm ci --omit=dev --no-audit --no-fund --workspace server --workspace packages/protocol && mkdir -p /data
EXPOSE 8787
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8787/health || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/dist/main.js"]
