# Сайт-прайс + админка. Зависимостей нет — только Node.
FROM node:22-alpine

WORKDIR /app
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# прайс, аватарки и секрет сессий живут в томе — переживают пересборку образа
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
