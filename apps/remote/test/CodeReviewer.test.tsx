import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CodeReviewer from '../src/CodeReviewer';

const limits = {
    maxCodeBytes: 32768,
    maxCodeLines: 1000,
    maxConcurrentReviews: 1,
    rateLimitMax: 5,
    rateLimitWindowMs: 60000,
    reviewTimeoutMs: 300000,
    responseTimeoutMs: 330000,
};

let fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
});

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// Подмена fetch должна отклонять Promise при abort, как настоящий сетевой запрос.
function pendingResponse(signal?: AbortSignal | null) {
    let complete!: (response: Response) => void;
    const promise = new Promise<Response>((resolve, reject) => {
        const abort = () => reject(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        complete = (response) => {
            signal?.removeEventListener('abort', abort);
            resolve(response);
        };
        if (signal?.aborted) abort();
    });
    return { promise, complete, signal };
}

function submitButton() {
    return screen.getByRole('button', { name: /Send for Review|Reviewing/ });
}

async function enterCode(user: ReturnType<typeof userEvent.setup>, code: string) {
    await user.click(screen.getByRole('textbox', { name: 'Код для ревью' }));
    await user.paste(code);
}

async function renderReady(overrides: Partial<typeof limits> = {}) {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...limits, ...overrides }));
    const view = render(<CodeReviewer />);
    await waitFor(() => expect(submitButton()).toBeEnabled());
    return view;
}

describe('загрузка ограничений API', () => {
    it('блокирует отправку до загрузки и показывает полученные ограничения', async () => {
        const user = userEvent.setup();
        let request!: ReturnType<typeof pendingResponse>;
        fetchMock.mockImplementationOnce((_url, init) => {
            request = pendingResponse(init?.signal);
            return request.promise;
        });
        render(<CodeReviewer />);

        expect(screen.getByText('Загрузка ограничений API…')).toBeInTheDocument();
        expect(submitButton()).toBeDisabled();
        await enterCode(user, 'console.log(1);');
        await user.click(submitButton());
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('/api/review/limits', {
            signal: expect.any(AbortSignal),
        });

        await act(async () => request.complete(jsonResponse({
            ...limits, maxCodeBytes: 2048, maxCodeLines: 10, rateLimitMax: 3,
        })));
        expect(submitButton()).toBeEnabled();
        expect(screen.getByText(/До 2 КиБ и 10 строк/)).toHaveTextContent('3 запросов за 60 с');
        expect(screen.queryByText('Загрузка ограничений API…')).not.toBeInTheDocument();
    });

    it.each([
        ['HTTP-ошибке', () => Promise.resolve(jsonResponse({ error: 'Unavailable' }, 503))],
        ['ошибке сети', () => Promise.reject(new TypeError('Failed to fetch'))],
        ['ответе не в JSON', () => Promise.resolve(new Response('<html>Unavailable</html>'))],
    ])('показывает ошибку и блокирует review при %s', async (_name, response) => {
        fetchMock.mockImplementationOnce(response);
        render(<CodeReviewer />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось получить ограничения API');
        expect(submitButton()).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Повторить' })).toBeEnabled();
    });

    it('повторно получает лимиты после ошибки и восстанавливает форму', async () => {
        const user = userEvent.setup();
        fetchMock.mockRejectedValueOnce(new TypeError('Offline'));
        fetchMock.mockResolvedValueOnce(jsonResponse(limits));
        render(<CodeReviewer />);
        await screen.findByRole('alert');

        await user.click(screen.getByRole('button', { name: 'Повторить' }));
        await waitFor(() => expect(submitButton()).toBeEnabled());
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            '/api/review/limits', '/api/review/limits',
        ]);
    });

    it('отменяет загрузку по истечении 10 секунд', async () => {
        vi.useFakeTimers();
        let request!: ReturnType<typeof pendingResponse>;
        fetchMock.mockImplementationOnce((_url, init) => {
            request = pendingResponse(init?.signal);
            return request.promise;
        });
        render(<CodeReviewer />);

        await act(async () => { await vi.advanceTimersByTimeAsync(9999); });
        expect(request.signal?.aborted).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(request.signal?.aborted).toBe(true);
        expect(screen.getByRole('alert')).toHaveTextContent('Не удалось получить ограничения API');
        expect(submitButton()).toBeDisabled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('отменяет незавершённую загрузку при размонтировании', async () => {
        let request!: ReturnType<typeof pendingResponse>;
        fetchMock.mockImplementationOnce((_url, init) => {
            request = pendingResponse(init?.signal);
            return request.promise;
        });
        const view = render(<CodeReviewer />);

        expect(request.signal?.aborted).toBe(false);
        await act(async () => view.unmount());
        expect(request.signal?.aborted).toBe(true);
    });
});

describe('валидация исходного кода', () => {
    it.each(['', '   ', '\t\n '])('не отправляет пустой ввод %j', async (code) => {
        const user = userEvent.setup();
        await renderReady();
        await enterCode(user, code);
        await user.click(submitButton());

        expect(screen.getByText('Введите код для ревью.')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['ASCII-байтов', 'abcdefg'],
        ['UTF-8 байтов', 'éééé'],
        ['строк LF', 'a\nb\nc'],
        ['строк CRLF', 'a\r\nb\r\nc'],
        ['строк CR', 'a\rb\rc'],
    ])('не отправляет код при превышении лимита %s', async (_name, code) => {
        const user = userEvent.setup();
        await renderReady({ maxCodeBytes: 6, maxCodeLines: 2 });
        await enterCode(user, code);
        await user.click(submitButton());

        expect(screen.getByText('Код должен содержать не более 6 байт UTF-8 и 2 строк.'))
            .toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['abcdef', 'ééé', 'a\nb'])('принимает код на границе лимита: %j', async (code) => {
        const user = userEvent.setup();
        await renderReady({ maxCodeBytes: 6, maxCodeLines: 2 });
        fetchMock.mockResolvedValueOnce(jsonResponse({ review: 'Boundary accepted' }));
        await enterCode(user, code);
        await user.click(submitButton());

        expect(await screen.findByText('Boundary accepted')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenLastCalledWith('/api/review', expect.objectContaining({
            body: JSON.stringify({ code }),
        }));
    });
});

describe('отправка review', () => {
    it('сохраняет исходный код, блокирует дубликат и позволяет отправить следующее review', async () => {
        const user = userEvent.setup();
        const code = '  console.log("ok");\n';
        await renderReady();
        let request!: ReturnType<typeof pendingResponse>;
        fetchMock.mockImplementationOnce((_url, init) => {
            request = pendingResponse(init?.signal);
            return request.promise;
        });
        await enterCode(user, code);
        await user.click(submitButton());

        expect(submitButton()).toBeDisabled();
        expect(submitButton()).toHaveTextContent('Reviewing...');
        expect(fetchMock).toHaveBeenLastCalledWith('/api/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
            signal: expect.any(AbortSignal),
        });
        await user.click(submitButton());
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await act(async () => request.complete(jsonResponse({ review: 'First result' })));
        expect(screen.getByText('First result')).toBeInTheDocument();
        expect(submitButton()).toBeEnabled();
        expect(screen.getByRole('textbox')).toHaveValue(code);
        expect(request.signal?.aborted).toBe(false);

        fetchMock.mockResolvedValueOnce(jsonResponse({ review: 'Second result' }));
        await user.click(submitButton());
        expect(await screen.findByText('Second result')).toBeInTheDocument();
        expect(screen.queryByText('First result')).not.toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each([
        ['ошибку API 429', () => Promise.resolve(jsonResponse({ error: 'Too many requests' }, 429)), 'Too many requests'],
        ['ошибку API 504', () => Promise.resolve(jsonResponse({ error: 'Review timed out' }, 504)), 'Review timed out'],
        ['HTML-ошибку прокси', () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })), 'Review failed: HTTP 502'],
        ['ошибку сети', () => Promise.reject(new TypeError('Failed to fetch')), 'Failed to fetch'],
        ['отсутствующий review', () => Promise.resolve(jsonResponse({})), 'API returned an invalid review response'],
        ['review неверного типа', () => Promise.resolve(jsonResponse({ review: 42 })), 'API returned an invalid review response'],
        ['успешный ответ не в JSON', () => Promise.resolve(new Response('Invalid JSON')), 'API returned an invalid review response'],
    ])('отображает %s и разрешает повторную отправку', async (_name, response, message) => {
        const user = userEvent.setup();
        await renderReady();
        fetchMock.mockImplementationOnce(response);
        await enterCode(user, 'console.log(1);');
        await user.click(submitButton());

        expect(await screen.findByText(`Error: ${message}`)).toBeInTheDocument();
        expect(submitButton()).toBeEnabled();
        expect(screen.getByRole('textbox')).toHaveValue('console.log(1);');

        fetchMock.mockResolvedValueOnce(jsonResponse({ review: 'Recovered' }));
        await user.click(submitButton());
        expect(await screen.findByText('Recovered')).toBeInTheDocument();
    });

    it('отменяет review по responseTimeoutMs из API и восстанавливает форму', async () => {
        await renderReady({ responseTimeoutMs: 1000 });
        const user = userEvent.setup();
        let request!: ReturnType<typeof pendingResponse>;
        fetchMock.mockImplementationOnce((_url, init) => {
            request = pendingResponse(init?.signal);
            return request.promise;
        });
        await enterCode(user, 'console.log(1);');
        // Вводим код с реальным временем, затем запускаем только таймер самого review.
        vi.useFakeTimers();
        fireEvent.click(submitButton());

        await act(async () => { await vi.advanceTimersByTimeAsync(999); });
        expect(request.signal?.aborted).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(request.signal?.aborted).toBe(true);
        expect(request.signal?.reason).toHaveProperty('name', 'TimeoutError');
        expect(screen.getByText('Error: Время ожидания review истекло.')).toBeInTheDocument();
        expect(submitButton()).toBeEnabled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('отменяет активное review при размонтировании', async () => {
        const user = userEvent.setup();
        const view = await renderReady();
        let request!: ReturnType<typeof pendingResponse>;
        fetchMock.mockImplementationOnce((_url, init) => {
            request = pendingResponse(init?.signal);
            return request.promise;
        });
        await enterCode(user, 'console.log(1);');
        await user.click(submitButton());

        expect(request.signal?.aborted).toBe(false);
        await act(async () => view.unmount());
        expect(request.signal?.aborted).toBe(true);
    });

    it('после успешного ответа очищает таймер и не отменяет завершённый запрос', async () => {
        await renderReady({ responseTimeoutMs: 1000 });
        const user = userEvent.setup();
        let request!: ReturnType<typeof pendingResponse>;
        fetchMock.mockImplementationOnce((_url, init) => {
            request = pendingResponse(init?.signal);
            return request.promise;
        });
        await enterCode(user, 'console.log(1);');
        vi.useFakeTimers();
        fireEvent.click(submitButton());
        await act(async () => request.complete(jsonResponse({ review: 'Completed' })));

        expect(screen.getByText('Completed')).toBeInTheDocument();
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(request.signal?.aborted).toBe(false);
    });
});
