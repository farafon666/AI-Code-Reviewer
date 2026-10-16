const { parentPort, workerData } = require('node:worker_threads');
const { ESLint } = require('eslint');

/**
 * Разбирает код из workerData и отправляет родительскому потоку ограниченный отчёт.
 * Параметры задачи проверяются вызывающим кодом; исходный код здесь не исполняется.
 *
 * @returns {Promise<void>} Завершение подготовки и отправки отчёта через parentPort.
 */
async function analyze() {
    const { code, maxFindings, maxOutputBytes } = workerData;
    const eslint = new ESLint({
        // Не загружаем конфигурацию проекта: используем только явно заданные правила анализа.
        useEslintrc: false,
        overrideConfig: {
            env: { browser: true, es2021: true, node: true },
            parserOptions: {
                ecmaFeatures: { jsx: true },
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
            rules: { 'no-unused-vars': 'warn', 'no-console': 'off', semi: ['error', 'always'] },
        },
    });
    const results = await eslint.lintText(code);
    const messages = results.flatMap((result) => result.messages);
    // Сначала ограничиваем число замечаний, затем общий размер отчёта для ответа и prompt.
    const output = messages.slice(0, maxFindings).map((message) => (
        `${message.line ?? 1}:${message.column ?? 1} ${message.severity === 2 ? 'error' : 'warning'} `
        + `${message.ruleId ?? 'parse'}: ${message.message}`
    )).join('\n') || 'No issues found';
    const marker = '\n[Static analysis output truncated]';
    const truncated = messages.length > maxFindings || Buffer.byteLength(output, 'utf8') > maxOutputBytes;
    // Пометка тоже входит в бюджет. Потоковое декодирование отбрасывает неполный символ на границе
    // UTF-8, чтобы не добавить символ замены и не превысить лимит байтов после декодирования.
    const boundedOutput = truncated
        ? new TextDecoder().decode(Buffer.from(output).subarray(
            0, maxOutputBytes - Buffer.byteLength(marker),
        ), { stream: true }) + marker
        : output;
    parentPort.postMessage({ output: boundedOutput });
}

// Родитель превращает этот сигнал в HTTP-ошибку; детали worker не попадают в ответ клиенту.
analyze().catch(() => parentPort.postMessage({ error: true }));
