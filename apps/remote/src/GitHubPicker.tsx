import React, { useEffect, useRef, useState } from 'react';
import { CodeFileLimits } from './readCodeFile';
import './GitHubPicker.css';

/** Источник импортированного кода; сохраняется вместе с редактором и снимком отчёта. */
export interface GitHubSource {
    /** Имя пользователя или организации GitHub. */
    owner: string;
    /** Имя репозитория без .git. */
    repo: string;
    /** Название ветки для отображения пользователю. */
    branch: string;
    /** Путь файла относительно корня репозитория. */
    path: string;
    /** Полный SHA выбранного коммита, фиксирующий версию файла. */
    commitSha: string;
    /** Ссылка на файл по commitSha, сохраняющая смысл после обновления ветки. */
    url: string;
    /** Проверенный текст после импорта для обнаружения последующих правок в редакторе. */
    originalCode: string;
}

/** Метаданные репозитория для первоначального выбора основной ветки. */
interface Repository { owner: string; repo: string; defaultBranch: string }
/** Элемент папки: sha обозначает дерево для directory и содержимое blob для file; size задан в байтах. */
interface Entry { name: string; sha: string; type: 'directory' | 'file'; size?: number }
/** Список одной папки; commitSha возвращается при первоначальном разрешении ветки в корневое дерево. */
interface Tree { treeSha: string; commitSha?: string; entries: Entry[] }
/** Шаг пути навигации; пустое name обозначает корень репозитория. */
interface Folder { name: string; tree: Tree }
/** Страница названий веток с признаком возможности запросить продолжение. */
interface Branches { branches: string[]; hasMore: boolean }

/** Ошибка загрузки с необязательным абсолютным сроком разрешённого повтора. */
class GitHubError extends Error {
    /**
     * @param message Сообщение для отображения в диалоге.
     * @param retryAt Время Unix в мс; 0 означает отсутствие блокировки повторных запросов.
     */
    constructor(message: string, readonly retryAt = 0) { super(message); }
}

/**
 * Выполняет GET к локальному GitHub API с отменой и обработкой Retry-After.
 * Таймаут клиента оставляет запас для серверного дедлайна в 15 секунд.
 *
 * @param operation Имя операции backend: repository, branches, tree или file.
 * @param params Строковые query-параметры, кодируемые через URLSearchParams.
 * @param signal Сигнал смены выбора или закрытия диалога.
 * @returns Разобранный ответ; его поля проверяет обработчик конкретной операции.
 * @throws {GitHubError} При ошибке API, сети, формата ответа или клиентском таймауте.
 */
async function get<T>(operation: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), 20_000);
    // Закрытие диалога и клиентский таймаут независимо прекращают ожидание и чтение JSON.
    const combined = AbortSignal.any([signal, timeoutController.signal]);
    try {
        const response = await fetch(`/api/github/${operation}?${new URLSearchParams(params)}`, { signal: combined });
        const data = await response.json().catch(() => null);
        // Отмена могла произойти после получения заголовков, уже во время чтения тела ответа.
        combined.throwIfAborted();
        if (!response.ok) {
            const retry = response.headers.get('Retry-After');
            const seconds = retry ? Number(retry) : NaN;
            // Поддерживаем обе формы Retry-After: задержку в секундах и абсолютную HTTP-дату.
            const deadline = Number.isFinite(seconds) ? Date.now() + Math.max(1, seconds) * 1000 : Date.parse(retry || '');
            throw new GitHubError(typeof data?.error === 'string' ? data.error : `Ошибка загрузки GitHub (HTTP ${response.status}).`,
                response.status === 429 ? (Number.isFinite(deadline) && deadline > Date.now() ? deadline : Date.now() + 60_000) : 0);
        }
        if (!data || typeof data !== 'object') throw new GitHubError('Сервер вернул некорректный ответ GitHub.');
        return data as T;
    } catch (error) {
        // Отмена пользователем не превращается в сообщение о недоступности сервиса.
        signal.throwIfAborted();
        if (timeoutController.signal.aborted) throw new GitHubError('Время ожидания GitHub истекло. Повторите попытку.');
        if (error instanceof GitHubError) throw error;
        throw new GitHubError('Не удалось связаться с сервером. Повторите попытку.');
    } finally { clearTimeout(timeout); }
}

/**
 * Показывает источник и определяет, отличается ли отображаемый код от импортированного.
 *
 * @param props Данные редактора либо сохранённого результата ревью.
 * @param props.source Метаданные файла и его исходный текст после импорта.
 * @param props.code Текст, для которого отображается подпись источника.
 * @returns Подпись со ссылкой на выбранный коммит и отметкой о правках.
 */
export function GitHubSourceInfo({ source, code }: { source: GitHubSource; code: string }) {
    return <>
        Источник: <a href={source.url} target="_blank" rel="noreferrer noopener">
            {source.owner}/{source.repo} · {source.branch} · {source.path} @{source.commitSha.slice(0, 7)}
        </a>
        {code !== source.originalCode && <span> · Изменён в редакторе</span>}
    </>;
}

/**
 * Отображает диалог выбора одного файла из снимка публичного репозитория.
 * Кэш папок и незавершённые запросы существуют только до закрытия диалога.
 *
 * @param props Настройки импорта и обработчики родительского редактора.
 * @param props.limits Действующие серверные лимиты для предварительной проверки размера.
 * @param props.onOpen Принимает проверенный файл; false сохраняет диалог при отказе от замены кода.
 * @param props.onClose Закрывает диалог после импорта или действия пользователя.
 * @returns Диалог с выбором ветки, навигацией по папкам и состояниями загрузки.
 */
export default function GitHubPicker({ limits, onOpen, onClose }: {
    limits: CodeFileLimits;
    onOpen: (source: GitHubSource) => boolean;
    onClose: () => void;
}) {
    const [url, setUrl] = useState('');
    const [repository, setRepository] = useState<Repository | null>(null);
    const [branches, setBranches] = useState<string[]>([]);
    const [branch, setBranch] = useState('');
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [folders, setFolders] = useState<Folder[]>([]);
    const [commitSha, setCommitSha] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [retryAt, setRetryAt] = useState(0);
    const [now, setNow] = useState(Date.now);
    const dialog = useRef<HTMLDivElement>(null);
    const urlInput = useRef<HTMLInputElement>(null);
    // Ссылка позволяет сразу отменить предыдущую операцию, не ожидая обновления состояния React.
    const active = useRef<AbortController | null>(null);
    // Содержимое дерева определяется SHA, поэтому кэш остаётся корректным при смене названия ветки.
    const cache = useRef(new Map<string, Tree>());
    // Сохраняется действие для ручного повтора, а не автоматически запускающийся запрос.
    const retry = useRef<() => void>(() => {});
    const close = useRef(onClose);
    const current = folders[folders.length - 1];
    const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));

    // Обработчик Escape видит актуальный onClose без переустановки слушателей и сброса фокуса.
    useEffect(() => { close.current = onClose; }, [onClose]);

    // Удерживаем фокус внутри окна; размонтирование отменяет загрузку и возвращает прежний фокус.
    useEffect(() => {
        const previousFocus = document.activeElement;
        urlInput.current?.focus();
        const focusInside = (event: FocusEvent) => {
            if (event.target instanceof Node && !dialog.current?.contains(event.target)) urlInput.current?.focus();
        };
        // Блокировка нажатой кнопки может перевести фокус на body; Escape должен работать и тогда.
        const dismiss = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
        };
        document.addEventListener('focusin', focusInside);
        document.addEventListener('keydown', dismiss, true);
        return () => {
            active.current?.abort();
            document.removeEventListener('focusin', focusInside);
            document.removeEventListener('keydown', dismiss, true);
            if (previousFocus instanceof HTMLElement) previousFocus.focus();
        };
    }, []);

    // Таймер обновляет только обратный отсчёт; запрос после истечения срока сам не отправляется.
    useEffect(() => {
        if (!retryAt) return;
        const timer = setInterval(() => {
            setNow(Date.now());
            if (Date.now() >= retryAt) setRetryAt(0);
        }, 1000);
        return () => clearInterval(timer);
    }, [retryAt]);

    /**
     * Запускает одну операцию выбора, отменяя предыдущую и сохраняя действие для ручного повтора.
     *
     * @param task Операция, которая использует переданный сигнал во всех сетевых запросах.
     * @param retryAction Повтор того же пользовательского действия с нужными параметрами.
     * @returns Завершение обработки успеха, ошибки или отмены.
     */
    async function run(task: (signal: AbortSignal) => Promise<void>, retryAction: () => void) {
        if (retryAt > Date.now()) return;
        active.current?.abort();
        const controller = new AbortController();
        active.current = controller;
        retry.current = retryAction;
        setBusy(true);
        setError('');
        try { await task(controller.signal); }
        catch (failure) {
            if (!controller.signal.aborted) {
                setError(failure instanceof Error ? failure.message : 'Не удалось загрузить данные GitHub.');
                if (failure instanceof GitHubError && failure.retryAt) {
                    setNow(Date.now());
                    setRetryAt(failure.retryAt);
                }
            }
        } finally {
            // Завершение старого запроса не должно снять busy у уже запущенной новой операции.
            if (active.current === controller) {
                active.current = null;
                if (!controller.signal.aborted) setBusy(false);
            }
        }
    }

    /**
     * Открывает основную ветку по введённой ссылке и загружает первую страницу остальных веток.
     * Данные предыдущего репозитория сбрасываются, чтобы их нельзя было открыть под новым адресом.
     *
     * @returns {void} Операция выполняется через общий обработчик run.
     */
    function connect() {
        void run(async (signal) => {
            setRepository(null);
            setFolders([]);
            cache.current.clear();
            const repo = await get<Repository>('repository', { url }, signal);
            if (typeof repo.owner !== 'string' || typeof repo.repo !== 'string' || typeof repo.defaultBranch !== 'string') {
                throw new GitHubError('Сервер вернул некорректный репозиторий.');
            }
            const params = { owner: repo.owner, repo: repo.repo };
            const tree = await get<Tree>('tree', { ...params, branch: repo.defaultBranch }, signal);
            if (!tree.commitSha || !Array.isArray(tree.entries)) throw new GitHubError('Сервер вернул некорректное дерево.');
            // Основная ветка доступна, даже если загрузка списка остальных веток завершится ошибкой.
            setRepository(repo);
            setBranch(repo.defaultBranch);
            setCommitSha(tree.commitSha);
            setBranches([repo.defaultBranch]);
            setPage(0);
            setHasMore(true);
            setFolders([{ name: '', tree }]);
            cache.current.set(tree.treeSha, tree);
            const data = await get<Branches>('branches', { ...params, page: '1' }, signal);
            if (!Array.isArray(data.branches) || data.branches.some((name) => typeof name !== 'string') || typeof data.hasMore !== 'boolean') {
                throw new GitHubError('Сервер вернул некорректный список веток.');
            }
            // Основная ветка уже добавлена вручную и может повториться в первой странице API.
            setBranches([...new Set([repo.defaultBranch, ...data.branches])]);
            setPage(1);
            setHasMore(data.hasMore);
        }, connect);
    }

    /**
     * Добавляет следующую страницу веток, сохраняя текущий выбор и удаляя повторные названия.
     *
     * @returns {void} Загрузка запускается только явным действием пользователя.
     */
    function moreBranches() {
        if (!repository) return;
        void run(async (signal) => {
            const data = await get<Branches>('branches', { owner: repository.owner, repo: repository.repo, page: String(page + 1) }, signal);
            if (!Array.isArray(data.branches) || data.branches.some((name) => typeof name !== 'string') || typeof data.hasMore !== 'boolean') {
                throw new GitHubError('Сервер вернул некорректный список веток.');
            }
            setBranches((previous) => [...new Set([...previous, ...data.branches])]);
            setPage(page + 1);
            setHasMore(data.hasMore);
        }, moreBranches);
    }

    /**
     * Разрешает выбранную ветку в новый снимок и начинает навигацию с корневой папки.
     *
     * @param name Название ветки, включая допустимые символы /.
     * @returns {void} Предыдущая загрузка отменяется обработчиком run.
     */
    function changeBranch(name: string) {
        if (!repository) return;
        setBranch(name);
        // Пока новая версия не получена, файлы и SHA прежней ветки недоступны для выбора.
        setFolders([]);
        setCommitSha('');
        void run(async (signal) => {
            const tree = await get<Tree>('tree', { owner: repository.owner, repo: repository.repo, branch: name }, signal);
            if (!tree.commitSha || !Array.isArray(tree.entries)) throw new GitHubError('Сервер вернул некорректное дерево.');
            setCommitSha(tree.commitSha);
            setFolders([{ name: '', tree }]);
            cache.current.set(tree.treeSha, tree);
        }, () => changeBranch(name));
    }

    /**
     * Открывает подпапку по SHA, используя кэш при повторном переходе в то же дерево.
     *
     * @param entry Папка из текущего списка, содержащая SHA её дерева.
     * @returns {void} Новый шаг пути добавляется только после успешного чтения.
     */
    function openDirectory(entry: Entry) {
        if (!repository) return;
        void run(async (signal) => {
            const tree = cache.current.get(entry.sha) ?? await get<Tree>('tree', {
                owner: repository.owner, repo: repository.repo, treeSha: entry.sha,
            }, signal);
            signal.throwIfAborted();
            if (!Array.isArray(tree.entries)) throw new GitHubError('Сервер вернул некорректное дерево.');
            cache.current.set(entry.sha, tree);
            setFolders([...folders, { name: entry.name, tree }]);
        }, () => openDirectory(entry));
    }

    /**
     * Загружает файл и передаёт его родителю для подтверждения замены содержимого редактора.
     *
     * @param entry Обычный JavaScript-файл из текущего дерева.
     * @returns {void} Диалог закрывается, только если onOpen подтвердил импорт.
     */
    function openFile(entry: Entry) {
        if (!repository || !commitSha) return;
        // Корневой шаг имеет пустое имя; относительный путь собирается из вложенных папок и файла.
        const path = [...folders.slice(1).map((folder) => folder.name), entry.name].join('/');
        void run(async (signal) => {
            const data = await get<{ code: string }>('file', { owner: repository.owner, repo: repository.repo, blobSha: entry.sha, path }, signal);
            if (typeof data.code !== 'string' || !data.code.trim()) throw new GitHubError('Сервер вернул некорректное содержимое файла.');
            // Ссылка использует commitSha снимка; имя ветки могло уже перейти на другой коммит.
            const fileUrl = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/blob/${commitSha}/${path.split('/').map(encodeURIComponent).join('/')}`;
            if (onOpen({ ...repository, branch, path, commitSha, url: fileUrl, originalCode: data.code })) onClose();
        }, () => openFile(entry));
    }

    return <div className="reviewer-modal-backdrop">
        <div className="reviewer-github-dialog" role="dialog" aria-modal="true" aria-labelledby="github-title" ref={dialog}
            onKeyDown={(event) => {
                // Замыкаем Tab и Shift+Tab на доступных элементах, исключая заблокированные кнопки.
                if (event.key !== 'Tab') return;
                const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]');
                if (!controls?.length) return;
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }}>
            <div className="reviewer-github-heading">
                <h2 id="github-title">Открыть из GitHub</h2>
                <button type="button" className="reviewer-button reviewer-button-small" onClick={onClose}>Закрыть</button>
            </div>
            <p>Публичный репозиторий · Один JavaScript-файл · UTF-8</p>
            <form onSubmit={(event) => { event.preventDefault(); connect(); }}>
                <label htmlFor="github-url">Ссылка на репозиторий</label>
                <div className="reviewer-github-connect">
                    <input id="github-url" ref={urlInput} value={url} placeholder="https://github.com/owner/repo" autoComplete="off"
                        onChange={(event) => {
                            // Даже незавершённый ввод нового адреса делает старую загрузку неактуальной.
                            active.current?.abort();
                            setBusy(false);
                            setUrl(event.target.value);
                            setRepository(null);
                            setFolders([]);
                            setError('');
                            cache.current.clear();
                        }} />
                    <button type="submit" className="reviewer-button" disabled={!url.trim() || busy || remaining > 0}>Открыть репозиторий</button>
                </div>
            </form>
            {repository && <>
                <div className="reviewer-github-branches">
                    <label htmlFor="github-branch">Ветка</label>
                    <select id="github-branch" value={branch} disabled={remaining > 0} onChange={(event) => changeBranch(event.target.value)}>
                        {branches.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                    {hasMore && <button type="button" className="reviewer-button reviewer-button-small"
                        disabled={busy || remaining > 0} onClick={moreBranches}>{page ? 'Ещё' : 'Загрузить ветки'}</button>}
                </div>
                {commitSha && <p className="reviewer-github-commit">Версия: {commitSha.slice(0, 7)}</p>}
                {current && <>
                    <nav aria-label="Путь в репозитории" className="reviewer-github-path">
                        {folders.map((folder, index) => <button type="button" key={`${index}-${folder.tree.treeSha}`}
                            className="reviewer-button reviewer-button-small" disabled={busy || index === folders.length - 1}
                            onClick={() => { setFolders(folders.slice(0, index + 1)); setError(''); }}>
                            {index === 0 ? `${repository.owner}/${repository.repo}` : folder.name}
                        </button>)}
                    </nav>
                    <ul className="reviewer-github-files" aria-label="Файлы репозитория" aria-busy={busy}>
                        {[...current.tree.entries].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1).map((entry) => {
                            // Размер GitHub включает возможный BOM; окончательную проверку выполняет сервер.
                            const tooLarge = entry.type === 'file' && (entry.size ?? 0) > limits.maxCodeBytes + 3;
                            return <li key={entry.name}>
                                <button type="button" className="reviewer-button" disabled={busy || remaining > 0 || tooLarge}
                                    onClick={() => entry.type === 'directory' ? openDirectory(entry) : openFile(entry)}>
                                    <span>{entry.type === 'directory' ? 'Папка: ' : ''}{entry.name}</span>
                                    {entry.type === 'file' && <span className="reviewer-github-size">
                                        {new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format((entry.size ?? 0) / 1024)} КиБ
                                        {tooLarge && ' · Превышен лимит размера'}
                                    </span>}
                                </button>
                            </li>;
                        })}
                    </ul>
                    {!current.tree.entries.length && <p>В этой папке нет доступных JavaScript-файлов и подпапок.</p>}
                </>}
            </>}
            <p role="status">{busy ? 'Загрузка GitHub…' : remaining > 0 ? `Повторить через ${remaining} с` : ''}</p>
            {error && <div className="reviewer-alert" role="alert">
                <p>{error}</p>
                <button type="button" className="reviewer-button" disabled={busy || remaining > 0} onClick={() => retry.current()}>Повторить</button>
            </div>}
        </div>
    </div>;
}
