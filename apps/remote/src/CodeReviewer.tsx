import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import CodeEditor, { CodeEditorHandle } from './CodeEditor';
import { codeFileAccept, readCodeFile } from './readCodeFile';
import './CodeReviewer.css';

/** Действующие ограничения GET /api/review/limits; окончательную проверку выполняет backend. */
interface ReviewLimits {
    /** Максимальный размер исходного кода в байтах UTF-8, а не в символах JavaScript. */
    maxCodeBytes: number;
    /** Максимальное число строк с учётом переводов LF, CRLF и CR. */
    maxCodeLines: number;
    /** Общее для обоих интерфейсов число одновременно выполняемых проверок. */
    maxConcurrentReviews: number;
    /** Допустимое число попыток отправки проверки за одно окно ограничения частоты. */
    rateLimitMax: number;
    /** Длительность окна ограничения частоты в миллисекундах. */
    rateLimitWindowMs: number;
    /** Общий дедлайн статического анализа и генерации ответа на backend, мс. */
    reviewTimeoutMs: number;
    /** Таймаут ожидания frontend, позволяющий получить ответ о серверном дедлайне, мс. */
    responseTimeoutMs: number;
}

/** Поддерживаемые варианты оформления общего интерфейса host и remote. */
type Theme = 'dark' | 'light';
/** Отчёт вместе со снимком кода, к которому относятся рекомендации. */
interface ReviewResult {
    /** Исходный Markdown-ответ API; используется и для отображения, и для копирования. */
    text: string;
    /** Точный текст отправленного кода для обнаружения изменений после запуска проверки. */
    source: string;
}
// В localStorage сохраняется только тема; исходный код и отчёты остаются в памяти компонента.
const themeKey = 'ai-code-reviewer-theme';
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/**
 * Читает сохранённую тему, используя тёмную при отсутствии настройки или доступа к хранилищу.
 *
 * @returns {Theme} Тема для первого отображения интерфейса.
 */
function initialTheme(): Theme {
    try { return localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
}

/**
 * Преобразует Retry-After из числа секунд или HTTP-даты в момент разрешённой повторной отправки.
 *
 * @param {string | null} value Значение заголовка ответа с HTTP-статусом 429.
 * @returns {number} Время в миллисекундах Unix либо 0 для отсутствующей, неверной или прошедшей даты.
 */
function retryDeadline(value: string | null): number {
    if (!value?.trim()) return 0;
    const seconds = Number(value);
    const deadline = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(value);
    return Number.isFinite(deadline) && deadline > Date.now() ? deadline : 0;
}

/**
 * Подбирает русскоязычное сообщение и действие пользователя по HTTP-статусу ошибки.
 *
 * @param {number} status Статус неуспешного ответа API или прокси.
 * @returns {string} Пояснение для основного блока ошибки; ответ сервера показывается отдельно.
 */
function responseError(status: number): string {
    if (status === 429) return 'Сервис занят или превышена частота запросов. Повторите проверку позже.';
    if (status === 504) return 'Проверка заняла слишком много времени. Попробуйте ещё раз или уменьшите фрагмент кода.';
    if (status === 502 || status === 503) return 'Сервис проверки недоступен. Проверьте, что backend и локальная модель запущены, и повторите попытку.';
    if (status === 413) return 'Код превышает ограничения сервера. Уменьшите фрагмент и повторите проверку.';
    return `Не удалось выполнить проверку (HTTP ${status}). Повторите попытку.`;
}

/**
 * Форматирует длительность проверки как минуты и секунды, ограничивая отрицательное время нулём.
 *
 * @param {number} milliseconds Время, прошедшее с начала запроса, в миллисекундах.
 * @returns {string} Значение вида «00:07»; минуты не сбрасываются после часа ожидания.
 */
function duration(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/**
 * Отображает общую рабочую область для редактирования кода и просмотра последнего отчёта.
 *
 * Компонент получает серверные лимиты, выполняет одну проверку за раз и сохраняет предыдущий
 * результат при ожидании, отмене или ошибке нового запроса.
 *
 * @returns {React.ReactElement} Форма проверки с темами, редактором, отчётом и состояниями запросов.
 */
const CodeReviewer: React.FC = () => {
    const [theme, setTheme] = useState<Theme>(initialTheme);
    const [code, setCode] = useState('');
    const [fileName, setFileName] = useState('');
    const [importing, setImporting] = useState(false);
    const [importError, setImportError] = useState('');
    const [result, setResult] = useState<ReviewResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [limits, setLimits] = useState<ReviewLimits | null>(null);
    const [limitsError, setLimitsError] = useState('');
    const [limitsAttempt, setLimitsAttempt] = useState(0);
    const [error, setError] = useState('');
    const [errorDetail, setErrorDetail] = useState('');
    const [notice, setNotice] = useState('');
    const [emptySubmitted, setEmptySubmitted] = useState(false);
    const [copyStatus, setCopyStatus] = useState('');
    const [startedAt, setStartedAt] = useState(0);
    const [now, setNow] = useState(Date.now);
    const [retryUntil, setRetryUntil] = useState(0);
    // Ссылка блокирует дубликаты сразу, ещё до применения асинхронного обновления loading в React.
    const reviewController = useRef<AbortController | null>(null);
    const importController = useRef<AbortController | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const codeEditor = useRef<CodeEditorHandle>(null);
    // Обработчик чтения должен видеть и правки, сделанные после выбора файла.
    const currentCode = useRef('');
    // Запрос и запись в буфер обмена могут завершиться уже после ухода пользователя со страницы.
    const mounted = useRef(true);

    // Повторяем серверный подсчёт UTF-8 и переводов строк для раннего предупреждения о лимитах.
    const codeBytes = new TextEncoder().encode(code).length;
    const codeLines = code ? code.split(/\r\n|\r|\n/).length : 0;
    const overLimit = Boolean(limits && (codeBytes > limits.maxCodeBytes || codeLines > limits.maxCodeLines));
    const validationError = overLimit && limits
        ? `Код должен содержать не более ${limits.maxCodeBytes} байт UTF-8 и ${limits.maxCodeLines} строк.`
        : emptySubmitted && !code.trim() ? 'Введите код для ревью.' : '';
    const retrySeconds = Math.max(0, Math.ceil((retryUntil - now) / 1000));

    useEffect(() => {
        try { localStorage.setItem(themeKey, theme); } catch { /* Без доступа к хранилищу тема действует до закрытия страницы. */ }
    }, [theme]);

    // Читаем лимиты при открытии и ручном повторе: изменения настроек backend не требуют пересборки UI.
    useEffect(() => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        let active = true;
        setLimitsError('');
        fetch('/api/review/limits', { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data: ReviewLimits = await response.json();
                const fields: (keyof ReviewLimits)[] = [
                    'maxCodeBytes', 'maxCodeLines', 'maxConcurrentReviews', 'rateLimitMax',
                    'rateLimitWindowMs', 'reviewTimeoutMs', 'responseTimeoutMs',
                ];
                // TypeScript не проверяет JSON во время выполнения, поэтому валидируем числовые поля.
                if (!data || fields.some((key) => !Number.isFinite(data[key]) || data[key] <= 0)) {
                    throw new Error('Invalid limits');
                }
                // Ответ предыдущей попытки не должен менять состояние после повтора или размонтирования.
                if (active) setLimits(data);
            })
            .catch(() => {
                if (active) setLimitsError('Не удалось получить ограничения API. Проверьте доступность backend.');
            })
            .finally(() => clearTimeout(timeout));
        return () => { active = false; clearTimeout(timeout); controller.abort(); };
    }, [limitsAttempt]);

    // Закрытие запроса при уходе со страницы позволяет backend отменить соответствующую задачу.
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            reviewController.current?.abort();
            importController.current?.abort();
        };
    }, []);

    // Один таймер обновляет часы проверки и ожидание Retry-After; повторный POST сам не запускается.
    useEffect(() => {
        if (!loading && !retryUntil) return;
        const interval = setInterval(() => {
            const time = Date.now();
            setNow(time);
            if (retryUntil && time >= retryUntil) setRetryUntil(0);
        }, 1000);
        return () => clearInterval(interval);
    }, [loading, retryUntil]);

    /**
     * Проверяет ввод и отправляет снимок кода с таймаутом из серверных настроек.
     *
     * Редактор остаётся доступен во время запроса, а прежний отчёт заменяется только успешным ответом.
     *
     * @returns {Promise<void>} Завершение запроса и освобождения состояния ожидания.
     */
    const submitReview = async () => {
        if (!limits || reviewController.current || importController.current || retryUntil > Date.now()) return;
        setEmptySubmitted(true);
        if (!code.trim() || overLimit) return;
        // Ответ связывается с этим снимком, даже если пользователь продолжит редактировать код.
        const source = code;
        const controller = new AbortController();
        reviewController.current = controller;
        setLoading(true);
        setError('');
        setErrorDetail('');
        setNotice('');
        setCopyStatus('');
        setStartedAt(Date.now());
        setNow(Date.now());
        // Причина TimeoutError отличает истечение срока ожидания от ручной отмены.
        const timeout = setTimeout(() => controller.abort(
            new DOMException('Время ожидания проверки истекло. Попробуйте ещё раз.', 'TimeoutError'),
        ), limits.responseTimeoutMs);
        try {
            const response = await fetch('/api/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: source }),
                signal: controller.signal,
            });
            // Прокси может вернуть HTML вместо JSON; HTTP-ошибку всё равно нужно показать пользователю.
            const data = await response.json().catch(() => null);
            // Не принимаем результат, если отмена произошла уже во время чтения тела ответа.
            controller.signal.throwIfAborted();
            if (!mounted.current) return;
            if (!response.ok) {
                if (response.status === 429) {
                    // Заголовок используется и при занятом слоте, и при исчерпании общей квоты запросов.
                    setNow(Date.now());
                    setRetryUntil(retryDeadline(response.headers.get('Retry-After')));
                }
                setError(responseError(response.status));
                setErrorDetail(typeof data?.error === 'string' ? data.error : '');
                return;
            }
            if (typeof data?.review !== 'string' || !data.review.trim()) {
                setError('Сервер вернул некорректный результат. Повторите проверку.');
                return;
            }
            setCopyStatus('');
            setResult({ text: data.review, source });
        } catch {
            if (!mounted.current) return;
            if (controller.signal.aborted) {
                if (controller.signal.reason?.name === 'TimeoutError') setError(controller.signal.reason.message);
                else setNotice('Проверка отменена.');
            } else {
                setError('Не удалось связаться с сервером. Проверьте подключение и повторите попытку.');
            }
        } finally {
            // Любой исход освобождает таймаут и защиту от дубликатов, включая отмену и сетевую ошибку.
            clearTimeout(timeout);
            reviewController.current = null;
            if (mounted.current) setLoading(false);
        }
    };

    /** Открывает проверенный файл после подтверждения замены актуального текста редактора. */
    const openFile = async (file: File) => {
        if (!limits || reviewController.current || importController.current) return;
        const controller = new AbortController();
        importController.current = controller;
        setImporting(true);
        setImportError('');
        try {
            const source = await readCodeFile(file, limits, controller.signal);
            if (!mounted.current || controller.signal.aborted) return;
            if (currentCode.current.length && !window.confirm('Открыть файл и заменить текущий код в редакторе?')) return;
            currentCode.current = source;
            setCode(source);
            setFileName(file.name);
            setEmptySubmitted(false);
            codeEditor.current?.focus();
        } catch (error) {
            if (mounted.current && !controller.signal.aborted) {
                setImportError(error instanceof Error ? error.message : 'Не удалось прочитать файл. Попробуйте снова.');
            }
        } finally {
            importController.current = null;
            if (mounted.current) setImporting(false);
        }
    };

    /**
     * Копирует исходный Markdown отчёта и сообщает об успехе либо необходимости ручного копирования.
     *
     * @returns {Promise<void>} Завершение попытки записи в буфер обмена браузера.
     */
    const copyReview = async () => {
        if (!result) return;
        try {
            await navigator.clipboard.writeText(result.text);
            if (mounted.current) setCopyStatus('Отчёт скопирован.');
        } catch {
            if (mounted.current) setCopyStatus('Не удалось скопировать. Выделите и скопируйте текст отчёта вручную.');
        }
    };

    return (
        <main className="reviewer-app" data-theme={theme}>
            <div className="reviewer-shell">
                <header className="reviewer-header">
                    <div className="reviewer-brand">
                        <span className="reviewer-logo" aria-hidden="true">{'</>'}</span>
                        <div>
                            <h1>AI Code Reviewer</h1>
                            <p>Проверка кода с помощью локальной модели</p>
                        </div>
                    </div>
                    <button className="reviewer-button reviewer-theme-toggle" type="button"
                        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                        <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
                        {theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
                    </button>
                </header>

                <form onSubmit={(event) => { event.preventDefault(); void submitReview(); }}>
                    <div className="reviewer-workspace">
                        <section className="reviewer-panel reviewer-source" aria-labelledby="reviewer-source-title">
                            <div className="reviewer-panel-heading">
                                <h2 id="reviewer-source-title">Исходный код</h2>
                                <div className="reviewer-source-actions">
                                    <span className="reviewer-language">JavaScript</span>
                                    <button className="reviewer-button reviewer-button-small" type="button"
                                        disabled={!limits || importing || loading} onClick={() => fileInput.current?.click()}>
                                        {importing ? 'Чтение файла…' : 'Открыть файл'}
                                    </button>
                                    <input ref={fileInput} type="file" accept={codeFileAccept} hidden
                                        aria-label="Файл для ревью" disabled={!limits || importing || loading}
                                        onChange={(event) => {
                                            const file = event.currentTarget.files?.[0];
                                            event.currentTarget.value = '';
                                            if (file) void openFile(file);
                                        }} />
                                </div>
                            </div>
                            <p className="reviewer-file-info" id="reviewer-file-info" role="status">
                                {fileName ? `Источник: ${fileName}` : 'Один файл: .js, .jsx, .mjs, .cjs · UTF-8'}
                            </p>
                            <CodeEditor ref={codeEditor} value={code} invalid={Boolean(validationError)} onSubmit={() => { void submitReview(); }}
                                onChange={(value) => { currentCode.current = value; setCode(value); setEmptySubmitted(false); }} />
                            <div className={`reviewer-code-count${overLimit ? ' reviewer-invalid' : ''}`} id="reviewer-code-count">
                                <span>{codeLines}{limits ? ` / ${limits.maxCodeLines}` : ''} строк</span>
                                <span title={`${codeBytes} байт UTF-8`}>{numberFormat.format(codeBytes / 1024)}{limits ? ` / ${numberFormat.format(limits.maxCodeBytes / 1024)}` : ''} КиБ UTF-8</span>
                            </div>
                            <div id="reviewer-code-error" className="reviewer-validation" role={validationError ? 'alert' : undefined}>
                                {validationError}
                            </div>
                            <div id="reviewer-file-error" className="reviewer-validation" role={importError ? 'alert' : undefined}>
                                {importError}
                            </div>
                        </section>

                        {/* Порядок DOM ведёт от ввода к запуску и отчёту; Grid меняет только расположение блоков. */}
                        <div className="reviewer-controls">
                            <div className="reviewer-toolbar">
                                <div className="reviewer-actions">
                                    <button className="reviewer-button reviewer-button-primary" type="submit"
                                        disabled={loading || importing || !limits || overLimit || retrySeconds > 0}>
                                        {loading && <span className="reviewer-spinner" aria-hidden="true" />}
                                        {loading ? 'Проверяем…' : retrySeconds ? `Повторить через ${retrySeconds} с` : 'Проверить код'}
                                    </button>
                                    {loading ? (
                                        <button className="reviewer-button" type="button"
                                            onClick={() => reviewController.current?.abort()}>Отменить</button>
                                    ) : <kbd className="reviewer-shortcut">Ctrl+Enter</kbd>}
                                </div>
                                <div className="reviewer-run-status">
                                    <span role="status">{loading ? 'Проверяем код…' : notice || (error
                                        ? result ? 'Предыдущий отчёт сохранён' : ''
                                        : result ? 'Проверка завершена' : '')}</span>
                                    {/* Часы находятся вне role="status", чтобы не озвучивать каждую секунду ожидания. */}
                                    {loading && <span className="reviewer-elapsed" aria-label="Прошло времени">{duration(now - startedAt)}</span>}
                                </div>
                            </div>
                            {error && <div className="reviewer-alert" role="alert">
                                <p>{error}</p>
                                {errorDetail && <details><summary>Ответ сервера</summary><p>{errorDetail}</p></details>}
                            </div>}
                        </div>

                        <section className="reviewer-panel reviewer-results" aria-labelledby="reviewer-result-title">
                            <div className="reviewer-panel-heading">
                                <h2 id="reviewer-result-title">Результат ревью</h2>
                                <button className="reviewer-button reviewer-button-small" type="button" disabled={!result}
                                    onClick={() => { void copyReview(); }}>Копировать</button>
                            </div>
                            {result ? (
                                <>
                                    {/* Сравнение со снимком не даёт принять старый отчёт за проверку текущего текста. */}
                                    {result.source !== code && <p className="reviewer-stale">Для предыдущей версии кода</p>}
                                    <div className="reviewer-report" role="region" aria-label="Отчёт проверки" tabIndex={0}>
                                        {/* Ответ модели не исполняет HTML и не инициирует загрузку внешних изображений. */}
                                        <Markdown remarkPlugins={[remarkBreaks]} skipHtml components={{
                                            a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
                                            img: ({ alt }) => <span>{alt || 'Изображение'}</span>,
                                        }}>{result.text}</Markdown>
                                    </div>
                                </>
                            ) : (
                                <div className="reviewer-empty">
                                    <span className="reviewer-empty-mark" aria-hidden="true">{'{ }'}</span>
                                    <h3>Здесь появятся результаты проверки</h3>
                                    <p>Вставьте код слева или откройте файл и нажмите «Проверить код».<br />Вы получите статический анализ и рекомендации модели.</p>
                                </div>
                            )}
                            <p className="reviewer-copy-status" role="status">{copyStatus}</p>
                        </section>
                    </div>

                    <footer className="reviewer-footer">
                        <span>JavaScript · Статический анализ + AI</span>
                        {!limits && !limitsError && <span role="status">Загрузка ограничений API…</span>}
                        {limits && <details className="reviewer-limits">
                            <summary>Ограничения проверки</summary>
                            <p>До {numberFormat.format(limits.maxCodeBytes / 1024)} КиБ и {limits.maxCodeLines} строк.
                                {' '}{limits.rateLimitMax} запросов за {limits.rateLimitWindowMs / 1000} с;
                                {' '}одновременно: {limits.maxConcurrentReviews};
                                {' '}до {limits.reviewTimeoutMs / 1000} с на проверку.</p>
                        </details>}
                    </footer>
                    {limitsError && <div className="reviewer-alert" role="alert">
                        <p>{limitsError}</p>
                        <button className="reviewer-button" type="button"
                            onClick={() => setLimitsAttempt((value) => value + 1)}>Повторить</button>
                    </div>}
                </form>
            </div>
        </main>
    );
};

export default CodeReviewer;
