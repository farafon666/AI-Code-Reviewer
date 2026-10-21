const express = require('express');
const { HttpError } = require('../errors');

/**
 * Создаёт GET-маршруты импорта GitHub с общим дедлайном для каждой операции.
 *
 * @param {object} options Подменяемые зависимости маршрутизатора.
 * @param {ReturnType<import('../services/github').createGithubService>} options.githubService
 * Клиент чтения публичных репозиториев.
 * @param {number} [options.timeoutMs=15000] Дедлайн операции в мс; в тестах можно сократить.
 * @returns {import('express').Router} Маршрутизатор для подключения по пути /github.
 */
function createGithubRouter({ githubService, timeoutMs = 15_000 }) {
    const router = express.Router();
    for (const operation of ['repository', 'branches', 'tree', 'file']) {
        router.get(`/${operation}`, async (req, res, next) => {
            // Один сигнал покрывает все обращения сервиса, включая разрешение ветки и чтение тела.
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(new HttpError(504, 'GitHub не ответил за 15 секунд. Повторите попытку.')), timeoutMs);
            const onDisconnect = () => {
                // close приходит и после успеха; уже отправленный ответ не требует отмены операции.
                if (!res.writableEnded) controller.abort(new Error('Client disconnected'));
            };
            req.once('aborted', onDisconnect);
            res.once('close', onDisconnect);
            // Исходный код не должен сохраняться HTTP-кэшем браузера или промежуточного прокси.
            res.set('Cache-Control', 'no-store');
            try {
                if (req.aborted || res.destroyed) return;
                const data = await githubService[operation](req.query, controller.signal);
                controller.signal.throwIfAborted();
                if (!res.destroyed) res.json(data);
            } catch (error) {
                if (!res.destroyed) {
                    const failure = controller.signal.aborted ? controller.signal.reason : error;
                    // Тело ошибки остаётся общим { error }; срок ручного повтора передаётся заголовком.
                    if (failure.retryAfter) res.set('Retry-After', String(failure.retryAfter));
                    next(failure);
                }
            } finally {
                // Очистка нужна при любом исходе, чтобы не оставлять таймеры и обработчики сокета.
                clearTimeout(timeout);
                req.removeListener('aborted', onDisconnect);
                res.removeListener('close', onDisconnect);
            }
        });
    }
    return router;
}

module.exports = { createGithubRouter };
