FROM node:22.19-alpine

WORKDIR /app
COPY package.json server.mjs ./

USER node
EXPOSE 8090
CMD ["node", "server.mjs"]
