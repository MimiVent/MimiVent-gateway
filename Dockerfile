FROM node:22.22.2-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs ./server.mjs
COPY auth_store.mjs ./auth_store.mjs
COPY app_setup.mjs ./app_setup.mjs
COPY print-app-config.mjs ./print-app-config.mjs
USER node
EXPOSE 8444 18080
CMD ["node", "server.mjs"]
