import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CodeReviewer from '../src/CodeReviewer';

// Базовый ответ API; отдельные сценарии переопределяют только проверяемые ограничения.
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
    // Настройка темы и сетевые ответы не должны зависеть от предыдущего сценария.
    localStorage.clear();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
});

/**
 * Создаёт ответ fetch с JSON-телом для успешных запросов и серверных ошибок.
 *
 * @param {unknown} body Тело ответа до сериализации.
 * @param {number} [status=200] HTTP-статус для проверяемого сценария.
 * @returns {Response} Ответ с корректным заголовком Content-Type.
 */
function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Создаёт управляемый сетевой запрос, который можно завершить ответом или отменить сигналом.
 *
 * Подмена отклоняет Promise при abort, как настоящий fetch; иначе тесты отмены проверяли бы
 * только состояние сигнала, но не восстановление интерфейса после отклонения запроса.
 *
 * @param {AbortSignal | null} [signal] Сигнал отмены из параметров вызова fetch.
 * @returns Управляемый Promise, функция завершения и сигнал для проверки причины отмены.
 */
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

/**
 * Находит одну кнопку запуска при обычном состоянии, ожидании ответа или ограничении частоты.
 *
 * @returns {HTMLElement} Кнопка отправки формы с текущим доступным названием.
 */
function submitButton() {
    return screen.getByRole('button', { name: /Проверить код|Проверяем…|Повторить через/ });
}

/**
 * Получает настоящий экземпляр CodeMirror через доступное поле ввода в отрисованном интерфейсе.
 *
 * @returns {EditorView} Редактор для проверки документа и отправки транзакций.
 * @throws {Error} Если React-компонент ещё не создал экземпляр CodeMirror.
 */
function editorView() {
    const view = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Код для ревью' }));
    if (!view) throw new Error('CodeMirror was not mounted');
    return view;
}

/**
 * Фокусирует редактор и заменяет его содержимое настоящей транзакцией CodeMirror.
 *
 * @param user Средства имитации действий пользователя из userEvent.setup().
 * @param {string} code Полный исходный код для текущего сценария.
 * @returns {Promise<void>} Завершение транзакции и связанных обновлений React.
 */
async function enterCode(user: ReturnType<typeof userEvent.setup>, code: string) {
    await user.click(screen.getByRole('textbox', { name: 'Код для ревью' }));
    // jsdom не полностью поддерживает редактирование contenteditable; транзакция сохраняет связь с React.
    await act(async () => {
        const view = editorView();
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
    });
}

/**
 * Отрисовывает форму с доступным API и дожидается разрешения на отправку проверки.
 *
 * @param overrides Изменения базовых лимитов, например для проверки границы размера ввода.
 * @returns Результат render после загрузки ограничений, включая функцию размонтирования.
 */
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
        expect(submitButton()).toHaveTextContent('Проверяем…');
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
        expect(editorView().state.doc.toString()).toBe(code);
        expect(request.signal?.aborted).toBe(false);

        fetchMock.mockResolvedValueOnce(jsonResponse({ review: 'Second result' }));
        await user.click(submitButton());
        expect(await screen.findByText('Second result')).toBeInTheDocument();
        expect(screen.queryByText('First result')).not.toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each([
        ['ошибку API 429', () => Promise.resolve(jsonResponse({ error: 'Too many requests' }, 429)), /Сервис занят/],
        ['ошибку API 504', () => Promise.resolve(jsonResponse({ error: 'Review timed out' }, 504)), /Проверка заняла слишком много времени/],
        ['HTML-ошибку прокси', () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })), /Сервис проверки недоступен/],
        ['ошибку сети', () => Promise.reject(new TypeError('Failed to fetch')), /Не удалось связаться с сервером/],
        ['отсутствующий review', () => Promise.resolve(jsonResponse({})), /Сервер вернул некорректный результат/],
        ['review неверного типа', () => Promise.resolve(jsonResponse({ review: 42 })), /Сервер вернул некорректный результат/],
        ['успешный ответ не в JSON', () => Promise.resolve(new Response('Invalid JSON')), /Сервер вернул некорректный результат/],
        ['пустой review', () => Promise.resolve(jsonResponse({ review: '  ' })), /Сервер вернул некорректный результат/],
    ])('отображает %s и разрешает повторную отправку', async (_name, response, message) => {
        const user = userEvent.setup();
        await renderReady();
        fetchMock.mockImplementationOnce(response);
        await enterCode(user, 'console.log(1);');
        await user.click(submitButton());

        expect(await screen.findByRole('alert')).toHaveTextContent(message);
        expect(submitButton()).toBeEnabled();
        expect(editorView().state.doc.toString()).toBe('console.log(1);');

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
        expect(screen.getByRole('alert')).toHaveTextContent('Время ожидания проверки истекло.');
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

describe('редактор и темы', () => {
    it('начинает с тёмной темы и сохраняет выбранную светлую тему после открытия', async () => {
        const user = userEvent.setup();
        const view = await renderReady();
        expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'dark');
        await user.click(screen.getByRole('button', { name: 'Светлая тема' }));
        expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'light');
        expect(localStorage.getItem('ai-code-reviewer-theme')).toBe('light');
        view.unmount();
        await renderReady();
        expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'light');
        await user.click(screen.getByRole('button', { name: 'Тёмная тема' }));
        expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'dark');
    });

    it('работает при недоступном localStorage', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked'); });
        const user = userEvent.setup();
        await renderReady();
        await user.click(screen.getByRole('button', { name: 'Светлая тема' }));
        expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'light');
    });

    it('принимает вставку с отступами и отправляет код по Ctrl+Enter без добавления строки', async () => {
        const user = userEvent.setup();
        await renderReady();
        const code = 'function sum(a, b) {\n  return a + b;\n}';
        await user.click(screen.getByRole('textbox', { name: 'Код для ревью' }));
        await user.paste(code);
        expect(editorView().state.doc.toString()).toBe(code);
        fetchMock.mockResolvedValueOnce(jsonResponse({ review: 'Keyboard result' }));
        await user.keyboard('{Control>}{Enter}{/Control}');
        expect(await screen.findByText('Keyboard result')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenLastCalledWith('/api/review', expect.objectContaining({
            body: JSON.stringify({ code }),
        }));
        expect(editorView().state.doc.toString()).toBe(code);
    });

    it('сразу показывает превышение UTF-8 лимита и снимает ошибку после исправления', async () => {
        const user = userEvent.setup();
        await renderReady({ maxCodeBytes: 6, maxCodeLines: 2 });
        await enterCode(user, 'яяяя');
        expect(screen.getByRole('alert')).toHaveTextContent('не более 6 байт UTF-8');
        expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
        expect(submitButton()).toBeDisabled();
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await enterCode(user, 'яяя');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false');
        expect(submitButton()).toBeEnabled();
        expect(screen.getByText('1 / 2 строк')).toBeInTheDocument();
    });

    it('не отправляет запрос с клавиатуры до получения лимитов', async () => {
        fetchMock.mockImplementationOnce((_url, init) => pendingResponse(init?.signal).promise);
        const user = userEvent.setup();
        render(<CodeReviewer />);
        await enterCode(user, 'console.log(1);');
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('снимок исходного кода и отмена', () => {
    it('связывает ответ с отправленным кодом, даже если редактор изменён во время проверки', async () => {
        const user = userEvent.setup();
        await renderReady();
        await enterCode(user, 'const first = 1;');
        let request!: ReturnType<typeof pendingResponse>;
        fetchMock.mockImplementationOnce((_url, init) => {
            request = pendingResponse(init?.signal);
            return request.promise;
        });
        await user.click(submitButton());
        await enterCode(user, 'const second = 2;');
        await act(async () => request.complete(jsonResponse({ review: 'Original source result' })));
        expect(screen.getByText('Original source result')).toBeInTheDocument();
        expect(screen.getByText('Для предыдущей версии кода')).toBeInTheDocument();
        await enterCode(user, 'const first = 1;');
        expect(screen.queryByText('Для предыдущей версии кода')).not.toBeInTheDocument();
    });

    it('сохраняет предыдущий отчёт во время новой проверки, после отмены и ошибки', async () => {
        const user = userEvent.setup();
        await renderReady();
        await enterCode(user, 'const first = 1;');
        fetchMock.mockResolvedValueOnce(jsonResponse({ review: 'Saved report' }));
        await user.click(submitButton());
        await screen.findByText('Saved report');
        let request!: ReturnType<typeof pendingResponse>;
        fetchMock.mockImplementationOnce((_url, init) => {
            request = pendingResponse(init?.signal);
            return request.promise;
        });
        await user.click(submitButton());
        expect(screen.getByText('Saved report')).toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        await user.click(screen.getByRole('button', { name: 'Отменить' }));
        expect(request.signal?.aborted).toBe(true);
        expect(await screen.findByText('Проверка отменена.')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByText('Saved report')).toBeInTheDocument();
        expect(submitButton()).toBeEnabled();
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Failure' }, 502));
        await user.click(submitButton());
        await screen.findByRole('alert');
        expect(screen.getByText('Saved report')).toBeInTheDocument();
    });

    it('показывает прошедшее время и останавливает таймер при отмене', async () => {
        const user = userEvent.setup();
        await renderReady();
        await enterCode(user, 'console.log(1);');
        fetchMock.mockImplementationOnce((_url, init) => pendingResponse(init?.signal).promise);
        vi.useFakeTimers();
        fireEvent.click(submitButton());
        await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
        expect(screen.getByLabelText('Прошло времени')).toHaveTextContent('00:02');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Отменить' })); });
        expect(screen.queryByLabelText('Прошло времени')).not.toBeInTheDocument();
        expect(screen.getByText('Проверка отменена.')).toBeInTheDocument();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('ограничение частоты', () => {
    it.each(['seconds', 'date'])('учитывает Retry-After (%s), блокирует Ctrl+Enter и не повторяет запрос автоматически', async (kind) => {
        const user = userEvent.setup();
        await renderReady();
        await enterCode(user, 'console.log(1);');
        vi.useFakeTimers();
        // Абсолютная HTTP-дата и число секунд отсчитываются от одного момента без долей секунды.
        vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
        const response = jsonResponse({ error: 'Busy' }, 429);
        response.headers.set('Retry-After', kind === 'seconds' ? '2' : new Date(Date.now() + 2000).toUTCString());
        fetchMock.mockResolvedValueOnce(response);
        await act(async () => { fireEvent.click(submitButton()); });
        expect(submitButton()).toHaveTextContent('Повторить через 2 с');
        expect(submitButton()).toBeDisabled();
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(submitButton()).toHaveTextContent('Повторить через 1 с');
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(submitButton()).toBeEnabled();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        fetchMock.mockResolvedValueOnce(jsonResponse({ review: 'Retry result' }));
        await act(async () => { fireEvent.click(submitButton()); });
        expect(screen.getByText('Retry result')).toBeInTheDocument();
    });

    it.each(['invalid', '-1', '0', 'Thu, 01 Jan 1970 00:00:00 GMT'])('не блокирует форму навсегда при Retry-After: %s', async (header) => {
        const user = userEvent.setup();
        await renderReady();
        await enterCode(user, 'console.log(1);');
        const response = jsonResponse({ error: 'Busy' }, 429);
        response.headers.set('Retry-After', header);
        fetchMock.mockResolvedValueOnce(response);
        await user.click(submitButton());
        expect(await screen.findByRole('alert')).toHaveTextContent('Сервис занят');
        expect(submitButton()).toBeEnabled();
    });
});

describe('оформление и копирование отчёта', () => {
    const report = '## Анализ\n\n- Первый пункт\n- Второй пункт\n\nПервая строка\nВторая строка\n\n```js\nconst value = 1;\n```';

    it('показывает диагностику ESLint буквально, сохраняя Markdown рекомендаций', async () => {
        const user = userEvent.setup();
        const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
        await renderReady();
        await enterCode(user, 'const __foo__ = 1; const foo = 2; console.log(foo);');
        const diagnostics = [
            "1:7 warning no-unused-vars: '__foo__' is assigned a value but never used.",
            '2:1 error parse: Unexpected token <Widget> & ```',
        ];
        const fullReport = [
            'Static analysis:', '',
            ...diagnostics.map((line) => `    ${line}`),
            '', 'AI review:', '## Рекомендации', '', '- Используйте `foo`.',
        ].join('\n');
        fetchMock.mockResolvedValueOnce(jsonResponse({ review: fullReport }));
        await user.click(submitButton());

        expect(await screen.findByRole('heading', { name: 'Рекомендации', level: 2 })).toBeInTheDocument();
        const region = screen.getByRole('region', { name: 'Отчёт проверки' });
        expect(region.querySelector('pre code')?.textContent).toBe(diagnostics.join('\n') + '\n');
        expect(region.querySelector('li code')).toHaveTextContent('foo');
        await user.click(screen.getByRole('button', { name: 'Копировать' }));
        expect(copy).toHaveBeenCalledWith(fullReport);
    });

    it('показывает Markdown и копирует исходный текст отчёта', async () => {
        const user = userEvent.setup();
        // userEvent.setup() подготавливает Clipboard API, поэтому перехватываем writeText после него.
        const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
        await renderReady();
        expect(screen.getByRole('button', { name: 'Копировать' })).toBeDisabled();
        expect(screen.getByText('Здесь появятся результаты проверки')).toBeInTheDocument();
        await enterCode(user, 'const value = 1;');
        fetchMock.mockResolvedValueOnce(jsonResponse({ review: report }));
        await user.click(submitButton());
        expect(await screen.findByRole('heading', { name: 'Анализ', level: 2 })).toBeInTheDocument();
        const region = screen.getByRole('region', { name: 'Отчёт проверки' });
        expect(region.querySelectorAll('li')).toHaveLength(2);
        expect(region.querySelector('br')).toBeInTheDocument();
        expect(region.querySelector('pre code')).toHaveTextContent('const value = 1;');
        await user.click(screen.getByRole('button', { name: 'Копировать' }));
        expect(copy).toHaveBeenCalledWith(report);
        expect(screen.getByText('Отчёт скопирован.')).toBeInTheDocument();
    });

    it('предлагает ручное копирование, если Clipboard API недоступен', async () => {
        const user = userEvent.setup();
        vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Permission denied'));
        await renderReady();
        await enterCode(user, 'const value = 1;');
        fetchMock.mockResolvedValueOnce(jsonResponse({ review: report }));
        await user.click(submitButton());
        await screen.findByRole('heading', { name: 'Анализ' });
        await user.click(screen.getByRole('button', { name: 'Копировать' }));
        expect(screen.getByText(/Не удалось скопировать/)).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Отчёт проверки' })).toBeInTheDocument();
    });

    it('не исполняет HTML и не загружает внешние изображения из ответа модели', async () => {
        const user = userEvent.setup();
        await renderReady();
        await enterCode(user, 'const value = 1;');
        // Намеренно небезопасные строки остаются данными: проверяем результат Markdown-рендеринга в DOM.
        fetchMock.mockResolvedValueOnce(jsonResponse({ review: [
            'Безопасный отчёт', '<script>window.injected = true;</script>',
            '<img src="x" onerror="alert(1)">', '![Схема](https://example.com/image.png)',
            '[Ссылка](javascript:alert(1))',
        ].join('\n\n') }));
        await user.click(submitButton());
        await screen.findByText('Безопасный отчёт');
        const region = screen.getByRole('region', { name: 'Отчёт проверки' });
        expect(region.querySelector('script, img')).not.toBeInTheDocument();
        expect(region.querySelector('a')).not.toHaveAttribute('href', 'javascript:alert(1)');
        expect(screen.getByText('Схема')).toBeInTheDocument();
    });
});
