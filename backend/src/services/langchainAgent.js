const { ChatOllama } = require('@langchain/ollama');
const { analyzeCode } = require('./staticAnalyzer');
const { loadConfig } = require('../config');
const { HttpError } = require('../errors');

/**
 * Извлекает текст из строкового ответа или сообщения LangChain с блоками содержимого.
 *
 * @param {string|import('@langchain/core/messages').BaseMessage} [response] Ответ модели.
 * @returns {string} Текст review либо пустая строка, если содержимое отсутствует.
 */
function getMessageContent(response) {
    if (typeof response === 'string') {
        return response;
    }

    if (Array.isArray(response?.content)) {
        return response.content
            .map((part) => (typeof part === 'string' ? part : part.text || ''))
            .join('')
            .trim();
    }

    return response?.content || '';
}

/**
 * Параметры одной задачи review.
 *
 * @typedef {object} ReviewOptions
 * @property {AbortSignal} [signal] Общий сигнал дедлайна или отключения HTTP-клиента.
 */

/**
 * Выполняет статический анализ и дополняет его ответом модели.
 *
 * @callback CodeReviewer
 * @param {string} code Проверенный маршрутом исходный код.
 * @param {ReviewOptions} [options] Параметры отмены задачи.
 * @returns {Promise<string>} Отчёт ESLint и текст AI review.
 */

/**
 * Создаёт исполнитель review с бюджетами из конфигурации и заменяемыми зависимостями.
 *
 * @param {Readonly<import('../config').ReviewConfig>} config Проверенные настройки backend.
 * @param {object} [dependencies] Зависимости для обычного запуска или тестов.
 * @param {typeof analyzeCode} [dependencies.analyze] Анализатор в отдельном worker.
 * @param {typeof ChatOllama} [dependencies.Model] Конструктор клиента модели.
 * @param {typeof fetch} [dependencies.fetchImpl] Реализация HTTP-запросов к Ollama.
 * @returns {CodeReviewer} Функция обработки одной задачи.
 */
function createCodeReviewer(config, { analyze = analyzeCode, Model = ChatOllama, fetchImpl = fetch } = {}) {
    return async function runCodeReview(code, { signal } = {}) {
        signal?.throwIfAborted();
        const staticAnalysis = await analyze(code, {
            signal,
            timeoutMs: config.analysisTimeoutMs,
            maxFindings: config.analysisMaxFindings,
            maxOutputBytes: config.analysisMaxOutputBytes,
            memoryMb: config.analysisMemoryMb,
        });
        // Пока выполнялся ESLint, клиент мог отключиться: такую задачу не отправляем в LLM.
        signal?.throwIfAborted();

        // Отдельный клиент на задачу не позволяет отмене одной генерации затронуть соседнюю.
        const model = new Model({
            baseUrl: config.ollamaBaseUrl,
            model: config.ollamaModel,
            temperature: 0,
            numCtx: config.llmNumCtx,
            numPredict: config.llmMaxOutputTokens,
            // Автоповтор увеличил бы стоимость и мог бы выйти за общий дедлайн задачи.
            maxRetries: 0,
            fetch: (input, init = {}) => {
                // Сохраняем отмену SDK и добавляем отмену review на уровне самого HTTP-запроса.
                // Это работает и до первого токена, когда invoke ещё не получает фрагменты ответа.
                const signals = [signal, init.signal].filter(Boolean);
                return fetchImpl(input, {
                    ...init,
                    signal: signals.length ? AbortSignal.any(signals) : undefined,
                });
            },
        });

        const prompt = [
            'You are a code reviewer.',
            'Use the static analysis output below as the primary source of lint findings.',
            'Then add a concise review summary with the most important risks and suggested fixes.',
            '',
            'Static analysis output:',
            staticAnalysis,
            '',
            'Code:',
            '```',
            code,
            '```',
        ].join('\n');

        let response;
        try {
            response = await model.invoke(prompt, { signal });
            signal?.throwIfAborted();
        } catch (error) {
            // Сохраняем причину отмены, чтобы маршрут вернул 504 при дедлайне, а не ошибку провайдера.
            if (signal?.aborted) throw signal.reason;
            throw new HttpError(502, 'Ollama request failed. Check that the model is available.', { cause: error });
        }
        const aiReview = getMessageContent(response);

        return [
            'Static analysis:',
            staticAnalysis,
            '',
            'AI review:',
            aiReview || 'No AI review content returned.',
        ].join('\n');
    };
}

/**
 * Запускает review с конфигурацией текущего окружения.
 * HTTP-приложение использует фабрику выше, чтобы проверять конфигурацию один раз при старте.
 *
 * @param {string} code Исходный код после проверки входных ограничений.
 * @param {ReviewOptions} [options] Общий сигнал отмены.
 * @returns {Promise<string>} Объединённый отчёт статического анализа и модели.
 * @throws {import('../errors').HttpError} При ошибке анализа или обращении к Ollama.
 */
async function runCodeReview(code, options) {
    return createCodeReviewer(loadConfig())(code, options);
}

module.exports = { runCodeReview, createCodeReviewer };
