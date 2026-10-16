/**
 * @file Интеграционные проверки защиты review API и отмены фоновой работы.
 * HTTP-заглушка Ollama позволяет проверять реальный клиент LangChain без модели и GPU.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { gzipSync } = require('node:zlib');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { createServer } = require('../src/index');
const { loadConfig } = require('../src/config');
const { HttpError } = require('../src/errors');
const { createCodeReviewer } = require('../src/services/langchainAgent');
const { analyzeCode, createStaticAnalyzer } = require('../src/services/staticAnalyzer');

/**
 * Запускает тестовый сервер на свободном локальном порту и регистрирует его очистку.
 *
 * @param {import('node:test').TestContext} t Контекст текущего теста.
 * @param {import('node:http').Server} server Сервер backend или заглушки провайдера.
 * @returns {Promise<string>} Базовый URL после начала прослушивания порта.
 */
async function listen(t, server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Запущенный backend с настройками, используемыми текущим тестом.
 *
 * @typedef {object} ApiFixture
 * @property {string} url Базовый URL локального сервера.
 * @property {import('../src/config').ReviewConfig} config Настройки с тестовыми переопределениями.
 * @property {import('node:http').Server} server HTTP-сервер для проверок транспорта.
 */

/**
 * Создаёт изолированный экземпляр API с заменяемым сервисом review.
 *
 * @param {import('node:test').TestContext} t Контекст теста и очистки ресурсов.
 * @param {object} [options] Переопределения зависимостей backend.
 * @param {Partial<import('../src/config').ReviewConfig>} [options.config] Настройки сценария.
 * @param {import('../src/services/langchainAgent').CodeReviewer} [options.reviewService] Сервис review.
 * @returns {Promise<ApiFixture>} Готовый API без зависимости от локального .env.
 */
async function api(t, { config: overrides, reviewService = async () => 'review result' } = {}) {
    // Большинство тестов проверяет другие ограничения; квоту по умолчанию повышаем только для них.
    const config = { ...loadConfig({}), rateLimitMax: 100, ...overrides };
    const server = createServer({ config, reviewService });
    return { url: await listen(t, server), config, server };
}

/**
 * Отправляет review с корректными JSON-заголовками и ограниченным временем ожидания теста.
 *
 * @param {{url: string}} instance Адрес тестового API.
 * @param {string} [code] Код для проверки.
 * @param {RequestInit} [options] Замены тела, заголовков или сигнала для негативных сценариев.
 * @returns {Promise<Response>} HTTP-ответ backend.
 */
function post(instance, code = 'console.log("ok");', options = {}) {
    return fetch(`${instance.url}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(10_000),
        ...options,
    });
}

/**
 * Проверяет статус и единый публичный формат ошибки без дополнительных полей.
 *
 * @param {Response} response Полученный ответ API.
 * @param {number} status Ожидаемый HTTP-статус.
 * @param {RegExp} [message] Необязательная проверка текста ошибки.
 * @returns {Promise<void>} Завершение проверок и чтения тела ответа.
 */
async function expectError(response, status, message) {
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['error']);
    assert.equal(typeof body.error, 'string');
    if (message) assert.match(body.error, message);
}

test('configuration validates numbers and related budgets before startup', () => {
    const defaults = loadConfig({});
    assert.equal(defaults.host, '127.0.0.1');
    assert.equal(defaults.maxCodeBytes, 32768);
    assert.equal(defaults.rateLimitMax, 5);
    assert.equal(defaults.maxConcurrentReviews, 1);
    for (const value of ['0', '-1', '1.5', '', 'NaN', 'Infinity', '2147483648']) {
        assert.throws(() => loadConfig({ REVIEW_TIMEOUT_MS: value }), /REVIEW_TIMEOUT_MS/);
    }
    assert.throws(() => loadConfig({ PORT: '65536' }), /PORT/);
    assert.throws(() => loadConfig({ HOST: 'example.com' }), /HOST/);
    assert.throws(() => loadConfig({ ANALYSIS_TIMEOUT_MS: '300001' }), /ANALYSIS_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ HTTP_RESPONSE_TIMEOUT_MS: '300000' }), /HTTP_RESPONSE_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ MAX_CODE_BYTES: '262145' }), /MAX_CODE_BYTES/);
    assert.throws(() => loadConfig({ LLM_MAX_OUTPUT_TOKENS: '32768' }), /LLM_MAX_OUTPUT_TOKENS/);
    assert.throws(() => loadConfig({ OLLAMA_BASE_URL: 'file:///tmp/ollama' }), /OLLAMA_BASE_URL/);
    assert.throws(() => createApp({ config: loadConfig({ MAX_CODE_LINES: '0' }) }), /MAX_CODE_LINES/);
});

test('review preserves its contract and permits only the four local origins or no Origin', async (t) => {
    const instance = await api(t);
    for (const origin of [undefined, 'http://localhost:3000', 'http://127.0.0.1:3000',
        'http://localhost:3001', 'http://127.0.0.1:3001']) {
        const headers = { 'Content-Type': 'application/json' };
        if (origin !== undefined) headers.Origin = origin;
        const response = await post(instance, undefined, { headers });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { review: 'review result' });
        assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    for (const origin of ['https://evil.example', 'http://localhost:3000.evil.example',
        'null', 'https://localhost:3000', 'http://localhost:5000']) {
        await expectError(await post(instance, undefined, {
            headers: { 'Content-Type': 'application/json', Origin: origin },
        }), 403);
    }
});

test('invalid values, UTF-8 byte limits and newline variants never reach review service', async (t) => {
    let calls = 0;
    const instance = await api(t, {
        config: { maxCodeBytes: 12, maxCodeLines: 2 },
        reviewService: async () => { calls += 1; return 'ok'; },
    });
    for (const body of [{}, { code: null }, { code: 1 }, { code: {} }, { code: [] },
        { code: '' }, { code: ' \t\r\n ' }, null, []]) {
        await expectError(await post(instance, undefined, { body: JSON.stringify(body) }), 400);
    }
    for (const code of ['x'.repeat(13), 'é'.repeat(7), ' '.repeat(12) + 'x',
        'a\nb\nc', 'a\r\nb\r\nc', 'a\rb\rc', 'a\nb\n']) {
        await expectError(await post(instance, code), 413);
    }
    assert.equal(calls, 0);
    assert.equal((await post(instance, 'é'.repeat(6))).status, 200);
    assert.equal((await post(instance, 'a\r\nb')).status, 200);
    assert.equal(calls, 2);
});

test('JSON format, compression and body size are enforced before analysis', async (t) => {
    let calls = 0;
    const instance = await api(t, {
        config: { jsonBodyLimitBytes: 64 },
        reviewService: async () => { calls += 1; return 'ok'; },
    });
    for (const headers of [{}, { 'Content-Type': 'text/plain' },
        { 'Content-Type': 'application/json; charset=iso-8859-1' }]) {
        await expectError(await post(instance, undefined, { headers }), 415);
    }
    await expectError(await post(instance, undefined, { body: '{invalid' }), 400);
    await expectError(await post(instance, 'x'.repeat(64)), 413, /JSON body/);
    await expectError(await post(instance, undefined, {
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: gzipSync(JSON.stringify({ code: 'x' })),
    }), 415);
    assert.equal(calls, 0);
});

test('256 KiB JSON budget accepts escaped code at the 32 KiB source boundary', async (t) => {
    const instance = await api(t);
    // Управляющие символы экранируются в JSON: тело растёт сильнее, чем строка исходного кода.
    assert.equal((await post(instance, '\u0001'.repeat(32767) + 'x')).status, 200);
    await expectError(await post(instance, 'x'.repeat(32769)), 413);
});

test('sixth review is rate limited across origins and forged forwarded IPs', async (t) => {
    const instance = await api(t, { config: { rateLimitMax: 5 } });
    // Меняем и frontend, и подставной IP, чтобы проверить общий ключ квоты для всего процесса.
    for (let index = 0; index < 5; index += 1) {
        const response = await post(instance, undefined, { headers: {
            'Content-Type': 'application/json',
            Origin: `http://localhost:${index % 2 ? 3000 : 3001}`,
            'X-Forwarded-For': `192.0.2.${index}`,
        } });
        assert.equal(response.status, 200);
    }
    const response = await post(instance);
    await expectError(response, 429, /Too many/);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.ok(response.headers.get('ratelimit'));
});

test('runtime limits do not consume review quota and reflect environment settings', async (t) => {
    const instance = await api(t, { config: { maxCodeLines: 123, rateLimitMax: 1 } });
    for (let index = 0; index < 2; index += 1) {
        const response = await fetch(`${instance.url}/review/limits`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).maxCodeLines, 123);
    }
    assert.equal((await post(instance)).status, 200);
    await expectError(await post(instance), 429);
});

test('concurrent review is rejected without a queue and slot is reusable after completion', async (t) => {
    // Управляем завершением первой задачи вручную: второй POST гарантированно застанет занятый слот.
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const instance = await api(t, { reviewService: async () => {
        started.resolve();
        await release.promise;
        return 'finished';
    } });
    t.after(() => release.resolve());
    const first = post(instance);
    await started.promise;
    const second = await post(instance);
    await expectError(second, 429, /slots are busy/);
    assert.equal(second.headers.get('retry-after'), '1');
    assert.equal((await fetch(`${instance.url}/review/limits`)).status, 200);
    release.resolve();
    assert.equal((await first).status, 200);
    assert.equal((await post(instance)).status, 200);
});

test('analysis and upstream errors keep JSON errors and release their review slots', async (t) => {
    for (const status of [422, 502]) {
        let calls = 0;
        const instance = await api(t, { reviewService: async () => {
            if (++calls === 1) throw new HttpError(status, 'Expected failure');
            return 'recovered';
        } });
        await expectError(await post(instance), status);
        assert.equal((await post(instance)).status, 200);
    }
});

test('slow unfinished request bodies time out before review is invoked', { timeout: 5000 }, async (t) => {
    let calls = 0;
    const instance = await api(t, {
        config: { requestBodyTimeoutMs: 100 },
        reviewService: async () => { calls += 1; return 'unexpected'; },
    });
    const socket = net.connect(instance.server.address().port, '127.0.0.1');
    t.after(() => socket.destroy());
    socket.setEncoding('utf8');
    let received = '';
    socket.on('data', (chunk) => { received += chunk; });
    const closed = once(socket, 'close');
    await once(socket, 'connect');
    // Обещаем тело длиннее переданного и оставляем соединение открытым до серверного таймаута.
    socket.write('POST /review HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n'
        + 'Content-Length: 1000\r\nConnection: close\r\n\r\n{"code":"');
    await closed;
    assert.match(received, /HTTP\/1\.1 408/);
    assert.equal(calls, 0);
});

/**
 * Формирует одну NDJSON-строку потокового протокола Ollama.
 *
 * @param {string} content Текст фрагмента ответа модели.
 * @param {boolean} [done=false] Признак завершения генерации.
 * @returns {string} JSON-фрагмент с завершающим переводом строки.
 */
function ollamaChunk(content, done = false) {
    return JSON.stringify({
        model: 'test-model', created_at: new Date().toISOString(),
        message: { role: 'assistant', content }, done,
    }) + '\n';
}

/**
 * Поднимает HTTP-заглушку Ollama и backend с настоящим клиентом ChatOllama.
 * Первый запрос зависает на выбранном этапе, последующие завершаются для проверки освобождения слота.
 *
 * @param {import('node:test').TestContext} t Контекст теста и остановки серверов.
 * @param {'success'|'before-headers'|'before-first-token'|'mid-stream'} mode Сценарий первого ответа.
 * @returns {Promise<ApiFixture & {requests: object[], started: Promise<unknown>, cancelled: Promise<unknown>}>}
 * API, записанные запросы и сигналы начала обработки и закрытия соединения.
 */
async function ollamaFixture(t, mode) {
    const started = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push(JSON.parse(body));
            if (requests.length === 1 && mode !== 'success') {
                // Событие close подтверждает, что отмена дошла до HTTP-соединения с провайдером.
                res.once('close', () => cancelled.resolve());
                if (mode !== 'before-headers') {
                    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
                    res.flushHeaders();
                    if (mode === 'mid-stream') res.write(ollamaChunk('partial '));
                }
            } else {
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
                res.end(ollamaChunk('Review complete', true));
            }
            started.resolve();
        });
    });
    const url = await listen(t, server);
    const config = { ...loadConfig({}), ollamaBaseUrl: url, reviewTimeoutMs: 500, rateLimitMax: 100 };
    // Здесь проверяем сеть и LLM; настоящий ESLint отдельно проверяется ниже с реальным worker.
    const reviewService = createCodeReviewer(config, { analyze: async () => 'No issues found' });
    const instance = await api(t, { config, reviewService });
    return { ...instance, requests, started: started.promise, cancelled: cancelled.promise };
}

test('real ChatOllama request receives context and output budgets', async (t) => {
    const instance = await ollamaFixture(t, 'success');
    const response = await post(instance);
    assert.equal(response.status, 200);
    assert.match((await response.json()).review, /AI review:\nReview complete/);
    assert.equal(instance.requests[0].options.num_ctx, 32768);
    assert.equal(instance.requests[0].options.num_predict, 2048);
    assert.match(instance.requests[0].messages[0].content, /Static analysis output:/);
});

for (const mode of ['before-headers', 'before-first-token', 'mid-stream']) {
    test(`deadline closes actual Ollama HTTP connection ${mode} and frees the slot`, { timeout: 10_000 }, async (t) => {
        const instance = await ollamaFixture(t, mode);
        await expectError(await post(instance), 504, /timed out/);
        await instance.cancelled;
        const next = await post(instance);
        assert.equal(next.status, 200);
        assert.match((await next.json()).review, /Review complete/);
    });
}

test('client disconnect cancels actual Ollama HTTP request and frees the slot', { timeout: 10_000 }, async (t) => {
    const instance = await ollamaFixture(t, 'before-headers');
    const controller = new AbortController();
    const rejected = assert.rejects(post(instance, undefined, { signal: controller.signal }));
    await instance.started;
    controller.abort();
    await rejected;
    await instance.cancelled;
    assert.equal((await post(instance)).status, 200);
});

test('Ollama failures return 502 without retries', async (t) => {
    let calls = 0;
    const url = await listen(t, http.createServer((req, res) => {
        calls += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unavailable' }));
    }));
    const config = { ...loadConfig({}), ollamaBaseUrl: url };
    const instance = await api(t, {
        config, reviewService: createCodeReviewer(config, { analyze: async () => 'No issues found' }),
    });
    await expectError(await post(instance), 502);
    assert.equal(calls, 1);
});

test('ESLint findings are bounded by count and valid UTF-8 bytes with truncation marked', async () => {
    const manyFindings = Array.from({ length: 30 }, (_, index) => `const unused${index} = ${index};`).join('\n');
    const counted = await analyzeCode(manyFindings);
    assert.equal(counted.split('\n').filter((line) => line.includes('no-unused-vars')).length, 20);
    assert.match(counted, /truncated/);
    const bounded = await analyzeCode(`const ${'я'.repeat(500)} = 1;`, { maxOutputBytes: 128 });
    assert.ok(Buffer.byteLength(bounded, 'utf8') <= 128);
    assert.match(bounded, /truncated/);
    assert.ok(!bounded.includes('\ufffd'));
    assert.equal(await analyzeCode('console.log("ok");'), 'No issues found');
});

test('a blocked analysis worker is terminated while the API remains responsive', { timeout: 10_000 }, async (t) => {
    let worker;
    const analyze = createStaticAnalyzer({ workerFactory: () => {
        // Искусственная бесконечная работа нужна для воспроизводимой проверки остановки потока.
        worker = new Worker('while (true) {}', { eval: true });
        return worker;
    } });
    let calls = 0;
    const instance = await api(t, { reviewService: async (code, { signal }) => {
        if (++calls === 1) return analyze(code, { signal, timeoutMs: 200 });
        return 'recovered';
    } });
    const first = post(instance);
    const response = await fetch(`${instance.url}/review/limits`);
    assert.equal(response.status, 200);
    await expectError(await first, 422, /Static analysis timed out/);
    assert.equal(worker.threadId, -1);
    assert.equal((await post(instance)).status, 200);
});

test('cancelling analysis waits until the worker is terminated', async () => {
    let worker;
    const analyze = createStaticAnalyzer({ workerFactory: () => {
        worker = new Worker('while (true) {}', { eval: true });
        return worker;
    } });
    const controller = new AbortController();
    const pending = analyze('code', { signal: controller.signal });
    const reason = new Error('cancelled');
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(worker.threadId, -1);
});
