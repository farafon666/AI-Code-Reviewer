/**
 * Проверенные настройки сервера и бюджетов review.
 *
 * @typedef {object} ReviewConfig
 * @property {string} host Адрес прослушивания; вне контейнера используется loopback.
 * @property {number} port TCP-порт backend.
 * @property {number} jsonBodyLimitBytes Максимальный размер JSON-тела в байтах.
 * @property {number} maxCodeBytes Максимальный размер исходной строки в UTF-8.
 * @property {number} maxCodeLines Максимальное количество строк исходного кода.
 * @property {number} rateLimitMax Количество попыток review за одно окно.
 * @property {number} rateLimitWindowMs Продолжительность окна rate limit в миллисекундах.
 * @property {number} maxConcurrentReviews Количество одновременно выполняемых review.
 * @property {number} reviewTimeoutMs Общий дедлайн анализа и LLM в миллисекундах.
 * @property {number} analysisTimeoutMs Дедлайн worker ESLint в миллисекундах.
 * @property {number} analysisMaxFindings Максимальное количество замечаний в отчёте ESLint.
 * @property {number} analysisMaxOutputBytes Размер отчёта в UTF-8, включая пометку сокращения.
 * @property {number} analysisMemoryMb Ограничение old-generation heap worker в МиБ.
 * @property {number} llmNumCtx Размер контекста модели в токенах.
 * @property {number} llmMaxOutputTokens Максимальное количество генерируемых токенов.
 * @property {number} requestBodyTimeoutMs Время получения HTTP-запроса в миллисекундах.
 * @property {number} responseTimeoutMs Таймаут ожидания frontend и простоя сокета backend, мс.
 * @property {string} ollamaBaseUrl Адрес HTTP API Ollama.
 * @property {string} ollamaModel Имя заранее загруженной модели.
 */

/**
 * Читает целочисленный env-параметр, отклоняя дроби, пустые строки и значения вне диапазона.
 *
 * @param {Record<string, string|undefined>} env Источник переменных окружения.
 * @param {string} name Имя параметра для чтения и сообщения об ошибке.
 * @param {number} fallback Значение, используемое только при отсутствии переменной.
 * @param {number} [minimum=1] Минимальное допустимое значение.
 * @returns {number} Проверенное целое число.
 * @throws {Error} Если значение не соответствует ограничениям.
 */
function positiveInteger(env, name, fallback, minimum = 1) {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    // Верхняя граница исключает переполнение таймеров Node.js при чтении таймаутов из env.
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)
        || value < minimum || value > 2_147_483_647) {
        throw new Error(`${name} must be an integer between ${minimum} and 2147483647`);
    }
    return value;
}

/**
 * Собирает неизменяемую конфигурацию и проверяет связанные лимиты до запуска сервера.
 * Отдельный источник env позволяет тестам не зависеть от локального файла .env.
 *
 * @param {Record<string, string|undefined>} [env=process.env] Переменные окружения.
 * @returns {Readonly<ReviewConfig>} Проверенные настройки с локальными значениями по умолчанию.
 * @throws {Error} Если параметр некорректен или бюджеты противоречат друг другу.
 */
function loadConfig(env = process.env) {
    const config = {
        host: env.HOST ?? '127.0.0.1',
        port: positiveInteger(env, 'PORT', 5000),
        jsonBodyLimitBytes: positiveInteger(env, 'JSON_BODY_LIMIT_BYTES', 256 * 1024),
        maxCodeBytes: positiveInteger(env, 'MAX_CODE_BYTES', 32 * 1024),
        maxCodeLines: positiveInteger(env, 'MAX_CODE_LINES', 1000),
        rateLimitMax: positiveInteger(env, 'REVIEW_RATE_LIMIT_MAX', 5),
        rateLimitWindowMs: positiveInteger(env, 'REVIEW_RATE_LIMIT_WINDOW_MS', 60_000),
        maxConcurrentReviews: positiveInteger(env, 'MAX_CONCURRENT_REVIEWS', 1),
        reviewTimeoutMs: positiveInteger(env, 'REVIEW_TIMEOUT_MS', 300_000),
        analysisTimeoutMs: positiveInteger(env, 'ANALYSIS_TIMEOUT_MS', 5000),
        analysisMaxFindings: positiveInteger(env, 'ANALYSIS_MAX_FINDINGS', 20),
        analysisMaxOutputBytes: positiveInteger(env, 'ANALYSIS_MAX_OUTPUT_BYTES', 4096, 64),
        analysisMemoryMb: positiveInteger(env, 'ANALYSIS_MEMORY_MB', 128, 32),
        llmNumCtx: positiveInteger(env, 'LLM_NUM_CTX', 32_768),
        llmMaxOutputTokens: positiveInteger(env, 'LLM_MAX_OUTPUT_TOKENS', 2048),
        requestBodyTimeoutMs: positiveInteger(env, 'HTTP_REQUEST_TIMEOUT_MS', 30_000),
        responseTimeoutMs: positiveInteger(env, 'HTTP_RESPONSE_TIMEOUT_MS', 330_000),
        ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
        ollamaModel: env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b',
    };

    // В Compose адрес 0.0.0.0 нужен для доступа из соседних контейнеров; порт на хост не публикуется.
    if (!['127.0.0.1', '::1', '0.0.0.0'].includes(config.host)) {
        throw new Error('HOST must be 127.0.0.1, ::1, or 0.0.0.0 (containers only)');
    }
    if (config.port > 65_535) throw new Error('PORT must not exceed 65535');
    if (config.analysisTimeoutMs > config.reviewTimeoutMs) {
        throw new Error('ANALYSIS_TIMEOUT_MS must not exceed REVIEW_TIMEOUT_MS');
    }
    // Клиент должен дождаться ответа backend даже после медленной передачи тела запроса.
    if (config.responseTimeoutMs < config.reviewTimeoutMs + config.requestBodyTimeoutMs) {
        throw new Error('HTTP_RESPONSE_TIMEOUT_MS must cover REVIEW_TIMEOUT_MS + HTTP_REQUEST_TIMEOUT_MS');
    }
    if (config.maxCodeBytes > config.jsonBodyLimitBytes) {
        throw new Error('MAX_CODE_BYTES must not exceed JSON_BODY_LIMIT_BYTES');
    }
    // В контексте должно оставаться место для входного prompt, помимо генерируемого ответа.
    if (config.llmMaxOutputTokens >= config.llmNumCtx) {
        throw new Error('LLM_MAX_OUTPUT_TOKENS must be smaller than LLM_NUM_CTX');
    }
    const url = new URL(config.ollamaBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !config.ollamaModel.trim()) {
        throw new Error('OLLAMA_BASE_URL must use HTTP(S) and OLLAMA_MODEL must not be empty');
    }
    return Object.freeze(config);
}

module.exports = { loadConfig };
