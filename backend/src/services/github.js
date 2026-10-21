/**
 * @file Чтение публичных репозиториев GitHub: проверка адресов, ограниченная загрузка
 * ответов и подготовка одного JavaScript-файла для существующего механизма ревью.
 */
const { HttpError } = require('../errors');

const shaPattern = /^[a-f0-9]{40}$/i;
const codeExtension = /\.(js|jsx|mjs|cjs)$/i;
/** @returns {HttpError} Публичная ошибка без содержимого некорректного ответа GitHub. */
const invalidResponse = () => new HttpError(502, 'GitHub вернул некорректный ответ.');

/**
 * Проверяет строковый параметр запроса, отклоняя в том числе массивы из query string.
 *
 * @param {unknown} value Значение до проверки типа и формата.
 * @param {RegExp} pattern Допустимый формат строки.
 * @param {string} name Имя параметра для сообщения об ошибке.
 * @returns {string} Проверенная строка.
 * @throws {HttpError} Статус 400 при неподходящем значении.
 */
function parameter(value, pattern, name) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw new HttpError(400, `Некорректный параметр ${name}.`);
    }
    return value;
}

/**
 * Формирует путь GitHub API из отдельных проверенных идентификаторов.
 *
 * @param {string} owner Имя пользователя или организации.
 * @param {string} repo Имя репозитория без суффикса .git.
 * @returns {string} Путь вида /repos/owner/repo без внешнего адреса.
 * @throws {HttpError} Статус 400 при некорректных идентификаторах.
 */
function repositoryPath(owner, repo) {
    parameter(owner, /^[a-z0-9_-]{1,100}$/i, 'owner');
    parameter(repo, /^(?!\.{1,2}$)[a-z0-9_.-]{1,100}$/i, 'repo');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Разбирает ссылку на корень репозитория и удаляет необязательные / и .git.
 *
 * @param {unknown} value Ссылка, переданная пользователем.
 * @returns {{owner: string, repo: string}} Идентификаторы для построения запросов API.
 * @throws {HttpError} Статус 400 для другого хоста, протокола или вложенного пути.
 */
function parseRepositoryUrl(value) {
    let url;
    try { url = new URL(typeof value === 'string' ? value.trim() : ''); }
    catch { throw new HttpError(400, 'Введите ссылку https://github.com/owner/repo.'); }
    const segments = url.pathname.replace(/\/$/, '').split('/');
    // Проверяем хост целиком: похожие домены, учётные данные и нестандартный порт не допускаются.
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password
        || url.search || url.hash || segments.length !== 3) {
        throw new HttpError(400, 'Введите ссылку https://github.com/owner/repo.');
    }
    const owner = segments[1];
    const repo = segments[2].replace(/\.git$/, '');
    repositoryPath(owner, repo);
    return { owner, repo };
}

/**
 * Читает тело ответа частями, не доверяя заявленному Content-Length.
 *
 * @param {Response} response Ответ GitHub с доступным потоком тела.
 * @param {number} limit Максимальный фактически прочитанный объём в байтах.
 * @param {AbortSignal} signal Общий сигнал дедлайна или отключения клиента.
 * @param {HttpError} tooLarge Ошибка, возвращаемая при превышении объёма.
 * @returns {Promise<Buffer>} Полностью прочитанное тело в пределах лимита.
 * @throws {HttpError} При отсутствии потока или превышении ограничения.
 */
async function readBounded(response, limit, signal, tooLarge) {
    const reader = response.body?.getReader();
    if (!reader) throw invalidResponse();
    const chunks = [];
    let size = 0;
    let completed = false;
    try {
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) { completed = true; break; }
            size += value.byteLength;
            if (size > limit) throw tooLarge;
            chunks.push(Buffer.from(value));
        }
        signal.throwIfAborted();
        return Buffer.concat(chunks, size);
    } finally {
        // При отказе прекращаем скачивание остатка; ошибка отмены не должна скрыть исходную причину.
        if (!completed) await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/**
 * Проверяет текстовый JavaScript-файл по тем же правилам, что и локальный импорт.
 *
 * @param {Buffer} bytes Байты файла, включая необязательный UTF-8 BOM.
 * @param {string} path Путь файла с поддерживаемым расширением.
 * @param {Readonly<import('../config').ReviewConfig>} config Действующие лимиты кода.
 * @returns {string} Проверенный код без BOM, с переводами строк LF.
 * @throws {HttpError} Статус 413 для лимитов или 422 для неподходящего содержимого.
 */
function decodeCode(bytes, path, config) {
    if (!codeExtension.test(path)) throw new HttpError(422, 'Выберите JavaScript-файл: .js, .jsx, .mjs или .cjs.');
    let code;
    // TextDecoder удаляет UTF-8 BOM; fatal запрещает молча заменять повреждённые символы.
    try { code = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new HttpError(422, 'Файл должен быть в кодировке UTF-8.'); }
    if (code.includes('\0')) throw new HttpError(422, 'Файл содержит нулевые символы.');
    if (!code.trim()) throw new HttpError(422, 'Файл пуст или содержит только пробельные символы.');
    // Размер и строки проверяются до замены CRLF/CR, чтобы нормализация не позволяла обойти лимит.
    if (Buffer.byteLength(code, 'utf8') > config.maxCodeBytes) {
        throw new HttpError(413, `Файл должен содержать не более ${config.maxCodeBytes} байт UTF-8 без BOM.`);
    }
    if (code.split(/\r\n|\r|\n/).length > config.maxCodeLines) {
        throw new HttpError(413, `Файл должен содержать не более ${config.maxCodeLines} строк.`);
    }
    return code.replace(/\r\n|\r/g, '\n');
}

/**
 * Создаёт клиент чтения публичного GitHub без токена и без запуска проверки кода.
 *
 * @param {Readonly<import('../config').ReviewConfig>} config Ограничения импортируемого кода.
 * @param {object} [dependencies] Подменяемые зависимости для изолированных тестов.
 * @param {typeof fetch} [dependencies.fetchImpl] HTTP-клиент вместо глобального fetch.
 * @returns Сервис с операциями repository, branches, tree и file.
 */
function createGithubService(config, { fetchImpl = fetch } = {}) {
    /**
     * Выполняет запрос к фиксированному хосту и переводит ошибки GitHub в ошибки приложения.
     *
     * @param {string} path Проверенный путь API с необязательными query-параметрами.
     * @param {AbortSignal} signal Сигнал всей операции, включая чтение тела ответа.
     * @param {boolean} [raw=false] Вернуть байты blob вместо разобранного JSON.
     * @returns Байты файла либо разобранный JSON, структуру которого проверяет вызывающий метод.
     * @throws {HttpError} При сетевой ошибке, отказе GitHub или превышении объёма ответа.
     */
    async function request(path, signal, raw = false) {
        signal.throwIfAborted();
        let response;
        try {
            response = await fetchImpl(`https://api.github.com${path}`, {
                signal,
                // Перенаправление не должно увести запрос с фиксированного api.github.com.
                redirect: 'error',
                headers: {
                    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2026-03-10',
                    'User-Agent': 'AI-Code-Reviewer',
                },
            });
            if (!response.ok) {
                let message = '';
                try {
                    const body = await readBounded(response, 64 * 1024, signal, invalidResponse());
                    message = JSON.parse(body.toString('utf8')).message || '';
                } catch { signal.throwIfAborted(); }
                // GitHub сообщает об основной и дополнительной квоте через 403 или 429.
                if (response.status === 429 || (response.status === 403
                    && (response.headers.get('x-ratelimit-remaining') === '0'
                        || response.headers.has('retry-after') || /rate limit|abuse/i.test(message)))) {
                    const retry = Number(response.headers.get('retry-after'));
                    const reset = Number(response.headers.get('x-ratelimit-reset'));
                    const error = new HttpError(429, 'Достигнут лимит запросов GitHub. Повторите позже.');
                    // Retry-After задаёт задержку, а x-ratelimit-reset — абсолютное время в секундах Unix.
                    error.retryAfter = Math.max(1, Math.ceil(retry > 0 ? retry : reset > 0 ? reset - Date.now() / 1000 : 60));
                    throw error;
                }
                if (response.status === 404) throw new HttpError(404, 'Репозиторий, ветка или файл недоступны. Поддерживаются только публичные репозитории.');
                if (response.status === 409) throw new HttpError(409, 'Репозиторий или ветка не содержит файлов.');
                if (response.status === 403) throw new HttpError(403, 'GitHub запретил доступ к ресурсу.');
                throw new HttpError(502, 'Не удалось получить данные от GitHub.');
            }
            // Три дополнительных байта нужны только для возможного BOM; JSON списков ограничен отдельно.
            const limit = raw ? config.maxCodeBytes + 3 : 4 * 1024 * 1024;
            const tooLarge = raw ? new HttpError(413, 'Файл превышает допустимый размер.')
                : new HttpError(422, 'Список GitHub слишком большой для открытия.');
            const bytes = await readBounded(response, limit, signal, tooLarge);
            return raw ? bytes : JSON.parse(bytes.toString('utf8'));
        } catch (error) {
            // Сохраняем причину отмены, чтобы дедлайн вернулся как 504, а не как сетевая ошибка 502.
            if (signal.aborted) throw signal.reason;
            if (error instanceof HttpError) throw error;
            throw new HttpError(502, 'Не удалось связаться с GitHub. Повторите попытку.', { cause: error });
        }
    }

    return {
        /**
         * Получает основную ветку публичного репозитория по пользовательской ссылке.
         *
         * @param {{url: unknown}} query Параметры запроса с исходной ссылкой.
         * @param {AbortSignal} signal Общий сигнал отмены операции.
         * @returns {Promise<{owner: string, repo: string, defaultBranch: string}>} Метаданные для диалога.
         */
        async repository({ url }, signal) {
            const { owner, repo } = parseRepositoryUrl(url);
            const data = await request(repositoryPath(owner, repo), signal);
            if (data?.private !== false || typeof data?.default_branch !== 'string') throw invalidResponse();
            return { owner, repo, defaultBranch: data.default_branch };
        },
        /**
         * Возвращает одну страницу названий веток без автоматического обхода остальных страниц.
         *
         * @param {{owner: string, repo: string, page?: string}} query Репозиторий и номер страницы от 1.
         * @param {AbortSignal} signal Общий сигнал отмены операции.
         * @returns {Promise<{branches: string[], hasMore: boolean}>} Названия и возможность продолжить загрузку.
         */
        async branches({ owner, repo, page = '1' }, signal) {
            const base = repositoryPath(owner, repo);
            parameter(page, /^[1-9]\d{0,5}$/, 'page');
            const data = await request(`${base}/branches?per_page=100&page=${page}`, signal);
            if (!Array.isArray(data) || data.some((branch) => typeof branch?.name !== 'string')) throw invalidResponse();
            // Полная страница допускает следующую; если ветки закончились ровно на границе, та будет пустой.
            return { branches: data.map(({ name }) => name), hasMore: data.length === 100 };
        },
        /**
         * Получает корневое дерево ветки либо содержимое папки по неизменяемому SHA дерева.
         *
         * @param {{owner: string, repo: string, branch?: string, treeSha?: string}} query
         * Репозиторий и ровно один способ выбора дерева: branch или treeSha.
         * @param {AbortSignal} signal Сигнал, общий для разрешения ветки и чтения дерева.
         * @returns {Promise<{treeSha: string, commitSha?: string, entries: Array<{name: string, sha: string, type: string, size?: number}>}>}
         * Содержимое папки; commitSha присутствует только при выборе корня через branch.
         */
        async tree({ owner, repo, branch, treeSha }, signal) {
            const base = repositoryPath(owner, repo);
            if ((branch === undefined) === (treeSha === undefined)) throw new HttpError(400, 'Укажите branch или treeSha.');
            let commitSha;
            let sha = treeSha;
            if (branch !== undefined) {
                parameter(branch, /^[^\0\r\n]{1,1024}$/, 'branch');
                let data;
                try { data = await request(`${base}/branches/${encodeURIComponent(branch)}`, signal); }
                catch (error) {
                    // У пустого репозитория default_branch задан, но сама ветка ещё не существует.
                    if (error.status !== 404) throw error;
                    const available = await request(`${base}/branches?per_page=1`, signal);
                    if (Array.isArray(available) && available.length === 0) {
                        throw new HttpError(409, 'Репозиторий или ветка не содержит файлов.');
                    }
                    throw error;
                }
                // После разрешения ветки читаем по SHA: новые коммиты не меняют выбранный снимок.
                commitSha = data?.commit?.sha;
                sha = data?.commit?.commit?.tree?.sha;
                if (!shaPattern.test(commitSha || '') || !shaPattern.test(sha || '')) throw invalidResponse();
            } else parameter(sha, shaPattern, 'treeSha');
            // Без recursive GitHub возвращает только одну папку; подпапки читаются при открытии.
            const data = await request(`${base}/git/trees/${sha}`, signal);
            if (!Array.isArray(data?.tree) || typeof data?.truncated !== 'boolean') throw invalidResponse();
            if (data.truncated) throw new HttpError(422, 'GitHub вернул неполный список. Эту папку открыть нельзя.');
            const entries = [];
            for (const item of data.tree) {
                if (!item || typeof item !== 'object') throw invalidResponse();
                // Git хранит ссылки и подмодули отдельными режимами; разрешаем лишь папки и обычные файлы.
                const directory = item.type === 'tree' && item.mode === '040000';
                const file = item.type === 'blob' && ['100644', '100755'].includes(item.mode);
                if (!directory && !file) continue;
                if (typeof item.path !== 'string' || !item.path || item.path.includes('/') || item.path.includes('\0') || !shaPattern.test(item.sha || '')
                    || (file && (!Number.isSafeInteger(item.size) || item.size < 0))) throw invalidResponse();
                if (file && !codeExtension.test(item.path)) continue;
                entries.push({ name: item.path, sha: item.sha, type: directory ? 'directory' : 'file',
                    ...(file ? { size: item.size } : {}) });
            }
            return { treeSha: sha, ...(commitSha ? { commitSha } : {}), entries };
        },
        /**
         * Загружает blob выбранного файла и возвращает код, пригодный для редактора.
         *
         * @param {{owner: string, repo: string, blobSha: string, path: string}} query
         * Репозиторий, SHA содержимого и относительный путь для проверки расширения.
         * @param {AbortSignal} signal Общий сигнал отмены загрузки.
         * @returns {Promise<{code: string}>} Проверенный код с переводами строк LF.
         */
        async file({ owner, repo, blobSha, path }, signal) {
            const base = repositoryPath(owner, repo);
            parameter(blobSha, shaPattern, 'blobSha');
            if (typeof path !== 'string' || !path || path.length > 4096 || path.startsWith('/')
                || path.split('/').some((part) => !part || part === '.' || part === '..') || /[\0\r\n]/.test(path)) {
                throw new HttpError(400, 'Некорректный путь файла.');
            }
            if (!codeExtension.test(path)) throw new HttpError(422, 'Выберите JavaScript-файл: .js, .jsx, .mjs или .cjs.');
            const bytes = await request(`${base}/git/blobs/${blobSha}`, signal, true);
            return { code: decodeCode(bytes, path, config) };
        },
    };
}

module.exports = { createGithubService };
