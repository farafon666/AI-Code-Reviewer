const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { createServer } = require('../backend/src/index');
const { loadConfig } = require('../backend/src/config');

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
