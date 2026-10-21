/**
 * @file Проверки выбора GitHub-файла с сетевыми заглушками: навигация,
 * закреплённая версия, устаревшие ответы, ручной повтор и управление фокусом.
 */
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GitHubPicker from '../src/GitHubPicker';

const commit = 'a'.repeat(40);
const root = 'b'.repeat(40);
const folder = 'c'.repeat(40);
const blob = 'd'.repeat(40);
const params = { owner: 'org', repo: 'project', defaultBranch: 'develop' };
const limits = { maxCodeBytes: 32768, maxCodeLines: 1000 };
const rootTree = { treeSha: root, commitSha: commit, entries: [
    { name: 'src', type: 'directory', sha: folder },
    { name: 'root.js', type: 'file', sha: blob, size: 16 },
    { name: 'huge.js', type: 'file', sha: blob, size: 100000 },
] };

let fetchMock = vi.fn<typeof fetch>();
/**
 * Создаёт ответ локального API для успешной загрузки либо ошибки.
 *
 * @param value JSON-тело ответа.
 * @param status HTTP-статус ответа.
 * @param headers Дополнительные заголовки, например Retry-After.
 * @returns Ответ, который можно передать сетевой заглушке.
 */
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers });

beforeEach(() => {
    // Каждый тест получает отдельный транспорт и собственную последовательность ответов.
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
});

/**
 * Имитирует подключение репозитория через настоящие элементы формы.
 *
 * @param user Средства имитации ввода и нажатий пользователя.
 * @param hasMore Должна ли первая страница веток разрешать дополнительную загрузку.
 * @returns Завершение загрузки метаданных, корневого дерева и первой страницы веток.
 */
async function connect(user: ReturnType<typeof userEvent.setup>, hasMore = false) {
    fetchMock.mockResolvedValueOnce(json(params)).mockResolvedValueOnce(json(rootTree))
        .mockResolvedValueOnce(json({ branches: ['develop', 'feature/github'], hasMore }));
    await user.type(screen.getByRole('textbox', { name: 'Ссылка на репозиторий' }), 'https://github.com/org/project.git/');
    await user.click(screen.getByRole('button', { name: 'Открыть репозиторий' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /root\.js/ })).toBeEnabled());
}

describe('GitHub picker', () => {
    it('opens a nested file from the pinned commit, caches folders and disables oversized files', async () => {
        const user = userEvent.setup();
        const onOpen = vi.fn(() => true);
        const onClose = vi.fn();
        render(<GitHubPicker limits={limits} onOpen={onOpen} onClose={onClose} />);
        await connect(user);
        expect(screen.getByRole('combobox', { name: 'Ветка' })).toHaveValue('develop');
        expect(screen.getByRole('button', { name: /huge.js/ })).toBeDisabled();
        fetchMock.mockResolvedValueOnce(json({ treeSha: folder, entries: [{ name: 'App.JSX', sha: blob, type: 'file', size: 8 }] }));
        await user.click(screen.getByRole('button', { name: 'Папка: src' }));
        await screen.findByRole('button', { name: /App.JSX/ });
        expect(String(fetchMock.mock.calls[3][0])).toContain(`treeSha=${folder}`);
        await user.click(within(screen.getByRole('navigation', { name: 'Путь в репозитории' })).getByRole('button', { name: 'org/project' }));
        await user.click(screen.getByRole('button', { name: 'Папка: src' }));
        expect(fetchMock).toHaveBeenCalledTimes(4);
        fetchMock.mockResolvedValueOnce(json({ code: 'let x=1;' }));
        await user.click(screen.getByRole('button', { name: /App.JSX/ }));
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'org', repo: 'project', branch: 'develop', path: 'src/App.JSX', commitSha: commit,
            originalCode: 'let x=1;', url: `https://github.com/org/project/blob/${commit}/src/App.JSX`,
        }));
        expect(onClose).toHaveBeenCalledOnce();
        const request = new URL(String(fetchMock.mock.calls[4][0]), 'http://localhost');
        expect(request.searchParams.get('blobSha')).toBe(blob);
        expect(request.searchParams.get('path')).toBe('src/App.JSX');
    });

    it('paginates branches and ignores a superseded branch response even if fetch ignores abort', async () => {
        const user = userEvent.setup();
        render(<GitHubPicker limits={limits} onOpen={() => true} onClose={() => {}} />);
        await connect(user, true);
        fetchMock.mockResolvedValueOnce(json({ branches: ['release'], hasMore: false }));
        await user.click(screen.getByRole('button', { name: 'Ещё' }));
        expect(await screen.findByRole('option', { name: 'release' })).toBeInTheDocument();
        expect(String(fetchMock.mock.calls[3][0])).toContain('page=2');
        expect(screen.queryByRole('button', { name: 'Ещё' })).not.toBeInTheDocument();

        // Транспорт намеренно игнорирует abort: защита от старого ответа проверяется на уровне компонента.
        let complete!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
        await user.selectOptions(screen.getByRole('combobox'), 'feature/github');
        const pendingSignal = fetchMock.mock.calls[4][1]?.signal;
        fetchMock.mockResolvedValueOnce(json({ treeSha: root, commitSha: 'e'.repeat(40), entries: [] }));
        await user.selectOptions(screen.getByRole('combobox'), 'release');
        expect(pendingSignal?.aborted).toBe(true);
        await screen.findByText(/нет доступных JavaScript/);
        await act(async () => complete(json(rootTree)));
        expect(screen.getByRole('combobox')).toHaveValue('release');
        expect(screen.queryByRole('button', { name: /root.js/ })).not.toBeInTheDocument();
        expect(screen.getByText('Версия: eeeeeee')).toBeInTheDocument();
    });

    it('keeps the dialog open on failed import or rejected replacement and retries only manually', async () => {
        const user = userEvent.setup();
        const onOpen = vi.fn(() => false);
        const onClose = vi.fn();
        render(<GitHubPicker limits={limits} onOpen={onOpen} onClose={onClose} />);
        await connect(user);
        fetchMock.mockResolvedValueOnce(json({ error: 'Файл должен быть в кодировке UTF-8.' }, 422));
        await user.click(screen.getByRole('button', { name: /root.js/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent('UTF-8');
        expect(onOpen).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(4);
        fetchMock.mockResolvedValueOnce(json({ code: 'const ok = 1;' }));
        await user.click(screen.getByRole('button', { name: 'Повторить' }));
        expect(onOpen).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('honors Retry-After without blocking closing the dialog', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<GitHubPicker limits={limits} onOpen={() => true} onClose={onClose} />);
        await connect(user);
        fetchMock.mockResolvedValueOnce(json({ error: 'Лимит GitHub' }, 429, { 'Retry-After': '1' }));
        await user.click(screen.getByRole('button', { name: /root.js/ }));
        expect(screen.getByText('Повторить через 1 с')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Повторить' })).toBeDisabled();
        const count = fetchMock.mock.calls.length;
        // Истечение ожидания только разблокирует кнопку; нового fetch без нажатия быть не должно.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Повторить' })).toBeEnabled(), { timeout: 2500 });
        expect(fetchMock).toHaveBeenCalledTimes(count);
        await user.click(screen.getByRole('button', { name: 'Закрыть' }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('traps focus, closes with Escape, restores focus and cancels loading', async () => {
        const user = userEvent.setup();
        /** @returns Минимальный родитель, проверяющий открытие и размонтирование диалога. */
        function Harness() {
            const [open, setOpen] = React.useState(false);
            return <><button onClick={() => setOpen(true)}>GitHub</button>
                {open && <GitHubPicker limits={limits} onOpen={() => true} onClose={() => setOpen(false)} />}</>;
        }
        render(<Harness />);
        const trigger = screen.getByRole('button', { name: 'GitHub' });
        await user.click(trigger);
        const input = screen.getByRole('textbox', { name: 'Ссылка на репозиторий' });
        expect(input).toHaveFocus();
        await user.tab(); // До ввода ссылки доступны только поле и кнопка закрытия.
        expect(screen.getByRole('button', { name: 'Закрыть' })).toHaveFocus();
        await user.tab({ shift: true });
        expect(input).toHaveFocus();
        await user.type(input, 'https://github.com/org/project');
        fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }));
        await user.click(screen.getByRole('button', { name: 'Открыть репозиторий' }));
        const pendingSignal = fetchMock.mock.calls[0][1]?.signal;
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(pendingSignal?.aborted).toBe(true);
        expect(trigger).toHaveFocus();
    });

    it('editing the repository URL cancels requests and discards a late response', async () => {
        const user = userEvent.setup();
        render(<GitHubPicker limits={limits} onOpen={() => true} onClose={() => {}} />);
        let complete!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
        const input = screen.getByRole('textbox', { name: 'Ссылка на репозиторий' });
        await user.type(input, 'https://github.com/org/project');
        await user.click(screen.getByRole('button', { name: 'Открыть репозиторий' }));
        const pendingSignal = fetchMock.mock.calls[0][1]?.signal;
        await user.clear(input);
        expect(pendingSignal?.aborted).toBe(true);
        await act(async () => complete(json(params)));
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
