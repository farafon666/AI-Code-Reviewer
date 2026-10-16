const http = require('node:http');
require('dotenv').config();

const { createApp } = require('./app');
const { loadConfig } = require('./config');

/**
 * Создаёт HTTP-сервер с таймаутами транспорта, не занимая порт до вызова listen().
 *
 * @param {import('./app').AppOptions} [options] Настройки и зависимости Express-приложения.
 * @returns {import('node:http').Server} Сервер, готовый к запуску или тестированию.
 */
function createServer({ config = loadConfig(), ...options } = {}) {
    const server = http.createServer({
        // Это лимит получения запроса; дедлайн обработки review задаётся отдельно в маршруте.
        requestTimeout: config.requestBodyTimeoutMs,
        headersTimeout: Math.min(15_000, config.requestBodyTimeoutMs),
        connectionsCheckingInterval: Math.min(1000, config.requestBodyTimeoutMs),
    }, createApp({ config, ...options }));
    // Таймаут простоя сокета оставляет запас относительно общего дедлайна review.
    server.setTimeout(config.responseTimeoutMs);
    return server;
}

// Импорт фабрики в тестах не должен автоматически поднимать сервер на порту 5000.
if (require.main === module) {
    const config = loadConfig();
    createServer({ config }).listen(config.port, config.host, () => {
        console.log(`Backend running on http://${config.host}:${config.port}`);
    });
}

module.exports = { createServer };
