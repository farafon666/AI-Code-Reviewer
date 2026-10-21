const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { createServer } = require('../backend/src/index');
const { loadConfig } = require('../backend/src/config');
const { createGithubService } = require('../backend/src/services/github');

/**
 * Запускает backend или proxy на свободном порту с очисткой соединений после теста.
 *
 * @param {import('node:test').TestContext} t Контекст регистрации очистки.
 * @param {import('node:http').Server} server Локальный HTTP-сервер.
 * @returns {Promise<string>} Базовый URL запущенного сервера.
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

for (const frontend of ['host', 'remote']) {
    test(`${frontend} dev proxy supports GitHub import followed by manual review`, async (t) => {
        // Берём реализацию и настройки proxy именно проверяемого frontend, а не отдельную тестовую конфигурацию.
        const frontendRequire = createRequire(path.join(__dirname, '../apps', frontend, 'package.json'));
        const devServerRequire = createRequire(frontendRequire.resolve('webpack-dev-server'));
        const { createProxyMiddleware } = devServerRequire('http-proxy-middleware');
        const proxyOptions = frontendRequire('./webpack.config.js').devServer.proxy['/api'];
        const commit = 'a'.repeat(40);
        const tree = 'b'.repeat(40);
        const blob = 'c'.repeat(40);
        let reviewed = 0;
        const config = loadConfig({});
        // Подменяется только транспорт GitHub: маршруты backend и преобразование ответов остаются настоящими.
        const githubService = createGithubService(config, { fetchImpl: async (url) => {
            const request = new URL(url);
            let body;
            if (request.pathname.endsWith('/git/blobs/' + blob)) return new Response('const imported = 1;');
            if (request.pathname.endsWith('/branches/main')) body = { commit: { sha: commit, commit: { tree: { sha: tree } } } };
            else if (request.pathname.endsWith('/git/trees/' + tree)) body = { truncated: false, tree: [{ path: 'file.js', type: 'blob', mode: '100644', sha: blob, size: 19 }] };
            else if (request.pathname.endsWith('/branches')) body = [{ name: 'main' }];
            else body = { private: false, default_branch: 'main' };
            return new Response(JSON.stringify(body));
        } });
        const backendUrl = await listen(t, createServer({ config, githubService, reviewService: async (code) => {
            reviewed += 1;
            assert.equal(code, 'const imported = 1;');
            return 'review of imported code';
        } }));
        const proxyUrl = await listen(t, http.createServer(createProxyMiddleware('/api', {
            ...proxyOptions, target: backendUrl, logLevel: 'silent',
        })));
        /**
         * Обращается к GitHub API через proxy и проверяет статус и запрет HTTP-кэширования.
         *
         * @param {string} operation Имя операции импорта.
         * @param {Record<string, string>} query Параметры выбранного репозитория или файла.
         * @returns JSON-тело ответа backend для последующего шага сценария.
         */
        const get = async (operation, query) => {
            const response = await fetch(`${proxyUrl}/api/github/${operation}?${new URLSearchParams(query)}`);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            return response.json();
        };
        const repo = await get('repository', { url: 'https://github.com/org/repo.git/' });
        assert.equal(repo.defaultBranch, 'main');
        assert.deepEqual((await get('branches', { owner: repo.owner, repo: repo.repo })).branches, ['main']);
        const contents = await get('tree', { owner: repo.owner, repo: repo.repo, branch: 'main' });
        assert.equal(contents.commitSha, commit);
        const file = await get('file', { owner: repo.owner, repo: repo.repo, blobSha: contents.entries[0].sha, path: 'file.js' });
        // Импорт не запускает модель: только следующий явный POST должен вызвать сервис ревью.
        assert.equal(reviewed, 0);
        const response = await fetch(`${proxyUrl}/api/review`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { review: 'review of imported code' });
        assert.equal(reviewed, 1);
    });

    test(`${frontend} dev proxy cancels disconnected reviews and preserves completed responses`, {
        timeout: 10_000,
    }, async (t) => {
        const frontendRequire = createRequire(path.join(__dirname, '../apps', frontend, 'package.json'));
        // Используем ту же реализацию прокси, которую загружает webpack-dev-server этого frontend.
        const devServerRequire = createRequire(frontendRequire.resolve('webpack-dev-server'));
        const { createProxyMiddleware } = devServerRequire('http-proxy-middleware');
        const proxyOptions = frontendRequire('./webpack.config.js').devServer.proxy['/api'];
        const started = Promise.withResolvers();
        const signals = [];
        const backend = createServer({
            config: loadConfig({}),
            reviewService: async (code, { signal }) => {
                signals.push(signal);
                if (signals.length === 2) {
                    started.resolve(signal);
                    // Тело уже получено целиком, а ответ ещё не начат: req.aborted не сработает.
                    await new Promise((resolve, reject) => {
                        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                    });
                }
                return 'completed review';
            },
        });
        const backendUrl = await listen(t, backend);
        const proxy = http.createServer(createProxyMiddleware('/api', {
            ...proxyOptions,
            target: backendUrl,
            logLevel: 'silent',
        }));
        const proxyUrl = await listen(t, proxy);
        const post = (signal) => fetch(`${proxyUrl}/api/review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'console.log("ok");' }),
            signal: signal ?? AbortSignal.timeout(5000),
        });

        const completed = await post();
        assert.equal(completed.status, 200);
        assert.deepEqual(await completed.json(), { review: 'completed review' });
        assert.equal(signals[0].aborted, false);

        const controller = new AbortController();
        t.after(() => controller.abort());
        const disconnected = assert.rejects(post(controller.signal), { name: 'AbortError' });
        const reviewSignal = await started.promise;
        const cancelled = once(reviewSignal, 'abort', { signal: AbortSignal.timeout(2000) });
        controller.abort();
        await disconnected;
        await cancelled;

        const next = await post();
        assert.equal(next.status, 200, 'отменённый review должен освободить слот');
        assert.deepEqual(await next.json(), { review: 'completed review' });
        assert.equal(signals[0].aborted, false, 'обычный ответ не должен отменять review');
        assert.equal(signals.length, 3);
    });
}
