const express = require('express');
const { loadConfig } = require('./config');
const { HttpError } = require('./errors');
const { createReviewRouter } = require('./routes/review');
const { createCodeReviewer } = require('./services/langchainAgent');
const { createGithubRouter } = require('./routes/github');
const { createGithubService } = require('./services/github');

// Сравниваем Origin целиком: похожий домен или другой протокол не должны пройти проверку.
const allowedOrigins = new Set([
    'http://localhost:3000', 'http://127.0.0.1:3000',
    'http://localhost:3001', 'http://127.0.0.1:3001',
]);

/**
 * Зависимости HTTP-приложения, которые можно заменить в интеграционных тестах.
 *
 * @typedef {object} AppOptions
 * @property {Readonly<import('./config').ReviewConfig>} [config] Проверенные настройки сервера.
 * @property {import('./services/langchainAgent').CodeReviewer} [reviewService] Исполнитель review.
 * @property {ReturnType<typeof createGithubService>} [githubService] Клиент публичного GitHub.
 */

/**
 * Создаёт Express-приложение с проверкой Origin и единым JSON-форматом ошибок.
 * Прослушивание порта запускается отдельно, поэтому тесты могут использовать свободный порт.
 *
 * @param {AppOptions} [options] Настройки и зависимости приложения.
 * @returns {import('express').Express} Готовое HTTP-приложение.
 */
function createApp({ config = loadConfig(), reviewService = createCodeReviewer(config),
    githubService = createGithubService(config) } = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        // Локальные CLI обычно не отправляют Origin; браузерный запрос проверяем до разбора JSON.
        const origin = req.get('Origin');
        if (origin !== undefined && !allowedOrigins.has(origin)) {
            return next(new HttpError(403, 'Origin is not allowed'));
        }
        next();
    });
    app.use('/review', createReviewRouter({ config, reviewService }));
    // Импорт использует ту же проверку Origin, но не расходует квоту ревью и не занимает слот модели.
    app.use('/github', createGithubRouter({ githubService }));
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    // Обработчик стоит после маршрутов: сюда попадают и ошибки сервиса, и ошибки JSON-парсера.
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (res.destroyed) return;

        if (error instanceof HttpError) {
            return res.status(error.status).json({ error: error.message });
        }
        const parserErrors = {
            'entity.too.large': [413, 'JSON body is too large'],
            'entity.parse.failed': [400, 'Invalid JSON body'],
            'encoding.unsupported': [415, 'Compressed request bodies are not supported'],
            'charset.unsupported': [415, 'Unsupported JSON charset'],
            'request.aborted': [400, 'Request body was aborted'],
            'request.size.invalid': [400, 'Invalid request body size'],
        };
        // Неизвестные ошибки не раскрывают клиенту stack trace, prompt или ответы провайдера.
        const [status, message] = parserErrors[error.type] ?? [500, 'Internal server error'];
        if (status === 500) console.error('Review request failed:', error.name);
        res.status(status).json({ error: message });
    });
    return app;
}

module.exports = { createApp };
