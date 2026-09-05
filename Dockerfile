FROM node:22-alpine

WORKDIR /app

COPY app/package*.json ./

RUN npm ci --omit=dev

COPY app/server.js .
COPY app/db.js .

COPY frontend /frontend

EXPOSE 3007

CMD ["node", "server.js"]
