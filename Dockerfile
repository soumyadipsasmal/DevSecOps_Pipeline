FROM node:22-alpine

# Install curl for the container HEALTHCHECK
RUN apk add --no-cache curl

WORKDIR /app

COPY app/package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY app/server.js .
COPY app/db.js .

COPY frontend /frontend

# Run as a non-root user (the 'node' user already exists in this base image)
RUN chown -R node:node /app /frontend
USER node

EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3007/health || exit 1

CMD ["node", "server.js"]
