FROM node:26.3.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src/worker.mjs ./worker.mjs
USER nobody
WORKDIR /workspace
ENTRYPOINT ["node", "/app/worker.mjs"]
