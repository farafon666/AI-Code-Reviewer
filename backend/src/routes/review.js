const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { HttpError } = require('../errors');

/**
 * Создаёт маршруты review с общей квотой запросов и ограниченным числом активных задач.
 *
 * @param {object} options Зависимости маршрутизатора.
 * @param {Readonly<import('../config').ReviewConfig>} options.config Лимиты обработки.
 * @param {import('../services/langchainAgent').CodeReviewer} options.reviewService Исполнитель review.
 * @returns {import('express').Router} Маршрутизатор для подключения по пути /review.
 */
function createReviewRouter({ config, reviewService }) {
    const router = express.Router();
    let activeReviews = 0;
    const limiter = rateLimit({
        windowMs: config.rateLimitWindowMs,
        limit: config.rateLimitMax,
        // Один ключ для всех IP: смена frontend или заголовка X-Forwarded-For не обходит квоту.
        keyGenerator: () => 'local-review',
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res) => res.status(429).json({
            error: 'Too many review requests. Try again later.',
        }),
    });

    // Оба frontend получают действующие env-лимиты; этот GET не расходует квоту POST-запросов.
    router.get('/limits', (req, res) => {
        res.set('Cache-Control', 'no-store').json({
            maxCodeBytes: config.maxCodeBytes,
            maxCodeLines: config.maxCodeLines,
            maxConcurrentReviews: config.maxConcurrentReviews,
            rateLimitMax: config.rateLimitMax,
            rateLimitWindowMs: config.rateLimitWindowMs,
            reviewTimeoutMs: config.reviewTimeoutMs,
            responseTimeoutMs: config.responseTimeoutMs,
        });
    });

    // Сначала ограничиваем частоту и формат, затем тратим ресурсы на разбор JSON и анализ кода.
    router.post('/', limiter, (req, res, next) => {
        if (!req.is('application/json')) {
            return next(new HttpError(415, 'Content-Type must be application/json'));
        }
        if (req.get('Content-Encoding') && req.get('Content-Encoding').toLowerCase() !== 'identity') {
            return next(new HttpError(415, 'Compressed request bodies are not supported'));
        }
        next();
    }, express.json({ limit: config.jsonBodyLimitBytes, inflate: false }), async (req, res, next) => {
        if (req.aborted || res.destroyed) return;
        const code = req.body?.code;
        if (typeof code !== 'string' || !code.trim()) {
            return next(new HttpError(400, 'Code must be a non-empty string'));
        }
        // Длина строки в JS не равна размеру UTF-8; измеряем исходный код без обрезки пробелов.
        if (Buffer.byteLength(code, 'utf8') > config.maxCodeBytes) {
            return next(new HttpError(413, `Code must not exceed ${config.maxCodeBytes} UTF-8 bytes`));
        }
        if (code.split(/\r\n|\r|\n/).length > config.maxCodeLines) {
            return next(new HttpError(413, `Code must not exceed ${config.maxCodeLines} lines`));
        }
        if (activeReviews >= config.maxConcurrentReviews) {
            return res.set('Retry-After', '1').status(429).json({
                error: 'All review slots are busy. Try again later.',
            });
        }

        // Занимаем слот до первого await, чтобы параллельный обработчик сразу увидел занятость.
        activeReviews += 1;
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort(new HttpError(504, 'Review timed out'));
        }, config.reviewTimeoutMs);
        // close возникает и после успешного ответа; в этом случае отменять уже ничего не нужно.
        const onDisconnect = () => {
            if (!res.writableEnded) controller.abort(new Error('Client disconnected'));
        };
        req.once('aborted', onDisconnect);
        res.once('close', onDisconnect);

        try {
            const review = await reviewService(code, { signal: controller.signal });
            controller.signal.throwIfAborted();
            if (!res.destroyed) res.json({ review });
        } catch (error) {
            if (!res.destroyed) next(controller.signal.aborted ? controller.signal.reason : error);
        } finally {
            // Освобождаем слот после завершения сервиса, включая его обработку отмены.
            clearTimeout(timeout);
            req.removeListener('aborted', onDisconnect);
            res.removeListener('close', onDisconnect);
            activeReviews -= 1;
        }
    });
    return router;
}

module.exports = { createReviewRouter };
