FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/relay/package.json apps/relay/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build -w @agentterminal/protocol && npm run build -w @agentterminal/relay

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/apps/relay/dist ./apps/relay/dist
COPY --from=build /app/apps/relay/package.json ./apps/relay/package.json
EXPOSE 8787
CMD ["node", "apps/relay/dist/index.js"]
