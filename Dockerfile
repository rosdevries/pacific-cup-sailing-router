# Optional: Railway auto-detects Node via Nixpacks, so a Dockerfile is not required.
# Provided for portability / local container runs.
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000 CACHE_DIR=/data/cache
EXPOSE 3000
CMD ["npm", "start"]
