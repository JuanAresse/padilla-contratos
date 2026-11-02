FROM node:22-bookworm-slim
WORKDIR /portfolio/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY app /portfolio/app
ENV HOST=0.0.0.0 PORT=3000 OCR_WARMUP=false
CMD ["node", "src/server.mjs"]
