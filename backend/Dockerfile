FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
# Lock-файл фиксирует зависимости; инструменты разработки не нужны в рабочем контейнере.
RUN npm ci --omit=dev

COPY . .

# EXPOSE описывает внутренний порт; доступ с хоста определяется публикацией портов в Compose.
EXPOSE 5000

CMD ["node", "src/index.js"]
