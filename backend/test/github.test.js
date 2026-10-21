/**
 * @file Проверки импорта GitHub без внешней сети: адреса, снимки деревьев,
 * ограничения файла, преобразование ошибок и отмена HTTP-операций.
 */
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { test } = require('node:test');
const express = require('express');
const { createGithubService } = require('../src/services/github');
const { createGithubRouter } = require('../src/routes/github');
const { createServer } = require('../src/index');
const { loadConfig } = require('../src/config');

// Синтетические SHA различают коммит, корневое дерево, подпапку и содержимое файла.
const commit = 'a'.repeat(40);
const root = 'b'.repeat(40);
const folder = 'c'.repeat(40);
const blob = 'd'.repeat(40);
/** @returns {AbortSignal} Новый независимый сигнал для одного вызова сервиса. */
const signal = () => new AbortController().signal;
/**
 * Создаёт ответ заглушки GitHub с заданным HTTP-статусом и заголовками.
 *
 * @param {unknown} data Сериализуемое JSON-тело.
 * @param {number} [status=200] Статус ответа GitHub.
 * @param {Record<string, string>} [headers={}] Заголовки, включая сведения о квоте.
 * @returns {Response} Ответ для подменённого fetch.
 */
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

/**
 * Создаёт настоящий сервис с контролируемым транспортом и журналом обращений.
 *
 * @param {(url: URL, options: RequestInit) => Response | Promise<Response>} handler
 * Ответ заглушки для проверяемого пути GitHub API.
 * @param {Partial<import('../src/config').ReviewConfig>} [overrides={}] Лимиты конкретного сценария.
 * @returns Сервис и список вызовов fetch для проверки адресов, заголовков и пагинации.
 */
function fixture(handler, overrides = {}) {
    const calls = [];
    const service = createGithubService({ ...loadConfig({}), ...overrides }, {
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            // Любой сценарий дополнительно проверяет фиксированный хост и отсутствие авторизации.
            assert.equal(new URL(url).origin, 'https://api.github.com');
            assert.equal(options.redirect, 'error');
            assert.equal(options.headers.Authorization, undefined);
            return handler(new URL(url), options);
        },
    });
    return { service, calls };
}

/**
 * Запускает локальный HTTP-сервер на свободном порту и регистрирует его закрытие после теста.
 *
 * @param {import('node:test').TestContext} t Контекст регистрации очистки ресурсов.
 * @param {import('node:http').Server} server Сервер backend или изолированного маршрутизатора.
 * @returns {Promise<string>} Базовый локальный URL запущенного сервера.
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

test('repository URLs are normalized and requests remain on the GitHub API', async () => {
    const { service, calls } = fixture(() => json({ private: false, default_branch: 'develop' }));
    for (const url of ['https://github.com/org/project', 'https://github.com/org/project/', 'https://github.com/org/project.git/']) {
        assert.deepEqual(await service.repository({ url }, signal()), { owner: 'org', repo: 'project', defaultBranch: 'develop' });
    }
    assert.equal(calls[0].url, 'https://api.github.com/repos/org/project');
    for (const url of ['http://github.com/org/project', 'https://github.com.evil/org/project',
        'https://user:pass@github.com/org/project', 'https://github.com/org/project/blob/main/test.js',
        'https://github.com/org/project?x=1', 'https://github.com/org/project#x', 'https://github.com/org/%2e%2e',
        'https://localhost/org/project']) {
        await assert.rejects(service.repository({ url }, signal()), { status: 400 });
    }
    assert.equal(calls.length, 3);
});

test('branches paginate and slash-containing branch names resolve to an immutable tree', async () => {
    const { service, calls } = fixture((url) => {
        if (url.searchParams.has('page')) return json(Array.from({ length: url.searchParams.get('page') === '1' ? 100 : 1 }, (_, i) => ({ name: `branch-${i}` })));
        if (url.pathname.includes('/branches/')) return json({ commit: { sha: commit, commit: { tree: { sha: root } } } });
        return json({ truncated: false, tree: [
            { path: 'src', type: 'tree', mode: '040000', sha: folder },
            { path: 'App.JSX', type: 'blob', mode: '100755', sha: blob, size: 20 },
            { path: 'link.js', type: 'blob', mode: '120000', sha: blob, size: 10 },
            { path: 'module', type: 'commit', mode: '160000', sha: blob },
            { path: 'README.md', type: 'blob', mode: '100644', sha: blob, size: 10 },
        ] });
    });
    const params = { owner: 'org', repo: 'project' };
    assert.equal((await service.branches({ ...params, page: '1' }, signal())).hasMore, true);
    assert.equal((await service.branches({ ...params, page: '2' }, signal())).hasMore, false);
    const tree = await service.tree({ ...params, branch: 'feature/github' }, signal());
    assert.equal(tree.commitSha, commit);
    assert.equal(tree.treeSha, root);
    assert.deepEqual(tree.entries.map((entry) => entry.name), ['src', 'App.JSX']);
    assert.equal(calls[2].url, 'https://api.github.com/repos/org/project/branches/feature%2Fgithub');
    assert.equal(calls[3].url, `https://api.github.com/repos/org/project/git/trees/${root}`);
    await service.tree({ ...params, treeSha: folder }, signal());
    assert.equal(calls[4].url, `https://api.github.com/repos/org/project/git/trees/${folder}`);
    assert.equal(new URL(calls[4].url).search, '', 'tree requests must be non-recursive');
});

test('a BOM is allowed and limits apply before newline normalization', async () => {
    const { service } = fixture(() => new Response(Buffer.from('\uFEFFa\r\nb')), { maxCodeBytes: 4, maxCodeLines: 2 });
    assert.deepEqual(await service.file({ owner: 'org', repo: 'project', blobSha: blob, path: 'src/test.js' }, signal()), { code: 'a\nb' });
    const limited = fixture(() => new Response('a\r\nb'), { maxCodeBytes: 3 }).service;
    await assert.rejects(limited.file({ owner: 'org', repo: 'project', blobSha: blob, path: 'test.js' }, signal()), { status: 413 });
});

test('distinguishes an empty repository from a missing branch', async () => {
    // Одинаковый 404 при чтении ветки уточняется наличием других веток в репозитории.
    for (const [branches, status] of [[[], 409], [[{ name: 'main' }], 404]]) {
        const { service } = fixture((url) => url.searchParams.has('per_page') ? json(branches) : json({}, 404));
        await assert.rejects(service.tree({ owner: 'org', repo: 'project', branch: 'main' }, signal()), { status });
    }
});

for (const extension of ['js', 'jsx', 'mjs', 'cjs', 'JS']) {
    test(`imports a .${extension} blob using the raw media type`, async () => {
        const { service, calls } = fixture(() => new Response('const answer = 42;'));
        assert.equal((await service.file({ owner: 'org', repo: 'project', blobSha: blob, path: `test.${extension}` }, signal())).code, 'const answer = 42;');
        assert.equal(calls[0].options.headers.Accept, 'application/vnd.github.raw+json');
    });
}

for (const [name, bytes, status, overrides] of [
    ['invalid UTF-8', Buffer.from([0xff]), 422],
    ['null bytes', Buffer.from('a\0b'), 422],
    ['empty file', Buffer.from(' \n'), 422],
    ['byte limit', Buffer.from('12345'), 413, { maxCodeBytes: 4 }],
    ['line limit', Buffer.from('a\rb\rc'), 413, { maxCodeLines: 2 }],
    ['multibyte limit', Buffer.from('яяя'), 413, { maxCodeBytes: 4 }],
]) {
    test(`rejects ${name}`, async () => {
        const { service } = fixture(() => new Response(bytes), overrides);
        await assert.rejects(service.file({ owner: 'org', repo: 'project', blobSha: blob, path: 'test.js' }, signal()), { status });
    });
}

test('oversized streaming bodies are cancelled without trusting Content-Length', async () => {
    let cancelled = false;
    // Тело намеренно больше заголовка и не закрывается само: сервис обязан остановить поток.
    const { service } = fixture(() => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(8)); },
        cancel() { cancelled = true; },
    }), { headers: { 'Content-Length': '1' } }), { maxCodeBytes: 4 });
    await assert.rejects(service.file({ owner: 'org', repo: 'project', blobSha: blob, path: 'test.js' }, signal()), { status: 413 });
    assert.equal(cancelled, true);
});

test('invalid input is rejected before sending requests', async () => {
    const { service, calls } = fixture(() => { throw new Error('must not fetch'); });
    const params = { owner: 'org', repo: 'project' };
    for (const query of [{ ...params }, { ...params, branch: 'main', treeSha: root }, { ...params, treeSha: 'bad' }]) {
        await assert.rejects(service.tree(query, signal()), { status: 400 });
    }
    await assert.rejects(service.branches({ ...params, page: '0' }, signal()), { status: 400 });
    await assert.rejects(service.file({ ...params, blobSha: blob, path: '../test.js' }, signal()), { status: 400 });
    await assert.rejects(service.file({ ...params, blobSha: blob, path: 'test.ts' }, signal()), { status: 422 });
    await assert.rejects(service.tree({ owner: ['org'], repo: 'project', treeSha: root }, signal()), { status: 400 });
    assert.equal(calls.length, 0);
});

for (const [name, reply, expected] of [
    ['missing or private repository', () => json({}, 404), 404],
    ['empty repository', () => json({}, 409), 409],
    ['truncated tree', () => json({ tree: [], truncated: true }), 422],
    ['malformed response', () => json({ tree: 'bad' }), 502],
    ['network error', () => { throw new Error('network'); }, 502],
    ['redirect', () => { throw new TypeError('unexpected redirect'); }, 502],
    ['server error', () => json({}, 503), 502],
]) {
    test(`reports ${name}`, async () => {
        const { service } = fixture(reply);
        await assert.rejects(service.tree({ owner: 'org', repo: 'project', treeSha: root }, signal()), { status: expected });
    });
}

test('GitHub errors keep the API envelope and primary/secondary rate limits include Retry-After', async (t) => {
    for (const [status, headers, message] of [
        [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 90) }, 'API rate limit exceeded'],
        [403, { 'Retry-After': '120' }, 'secondary rate limit'],
        [429, {}, 'rate limit'],
        [403, {}, 'You have exceeded a secondary rate limit'],
    ]) {
        const { service } = fixture(() => json({ message }, status, headers));
        const base = await listen(t, createServer({ githubService: service }));
        const response = await fetch(`${base}/github/tree?owner=org&repo=project&treeSha=${root}`);
        assert.equal(response.status, 429);
        assert.ok(Number(response.headers.get('retry-after')) >= 60);
        assert.deepEqual(Object.keys(await response.json()), ['error']);
    }
});

test('router aborts the upstream operation on timeout and client disconnection', { timeout: 5000 }, async (t) => {
    const started = [];
    const service = { repository: async (query, operationSignal) => {
        started.push(operationSignal);
        await new Promise((resolve, reject) => operationSignal.addEventListener('abort', () => reject(operationSignal.reason), { once: true }));
    } };
    const app = express();
    app.use('/github', createGithubRouter({ githubService: service, timeoutMs: 50 }));
    app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
        res.status(error.status || 500).json({ error: error.message });
    });
    const base = await listen(t, http.createServer(app));
    // Сначала сервер сам достигает дедлайна и возвращает 504.
    const timedOut = await fetch(`${base}/github/repository?url=x`);
    assert.equal(timedOut.status, 504);
    assert.equal(started[0].aborted, true);

    // Затем клиент разрывает другое соединение: отмена должна произойти раньше дедлайна.
    const controller = new AbortController();
    const disconnected = assert.rejects(fetch(`${base}/github/repository?url=y`, { signal: controller.signal }), { name: 'AbortError' });
    while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    // Подписываемся до разрыва соединения, чтобы не пропустить событие отмены сервиса.
    const aborted = once(started[1], 'abort', { signal: AbortSignal.timeout(2000) });
    controller.abort();
    await disconnected;
    await aborted;
    assert.notEqual(started[1].reason.status, 504, 'disconnect must cancel before the deadline');
});
