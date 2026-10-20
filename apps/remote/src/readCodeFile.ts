/** Ограничения исходного кода из GET /api/review/limits. */
export interface CodeFileLimits {
    maxCodeBytes: number;
    maxCodeLines: number;
}

export const codeFileAccept = '.js,.jsx,.mjs,.cjs';

/** Читает один локальный исходник, проверяя его до замены документа в редакторе. */
export async function readCodeFile(file: File, limits: CodeFileLimits, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!/\.(js|jsx|mjs|cjs)$/i.test(file.name)) {
        throw new Error('Выберите JavaScript-файл: .js, .jsx, .mjs или .cjs.');
    }
    const sizeError = `Файл должен содержать не более ${limits.maxCodeBytes} байт UTF-8 без BOM.`;
    // Три дополнительных байта разрешены только для необязательного UTF-8 BOM.
    if (file.size > limits.maxCodeBytes + 3) throw new Error(sizeError);

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const cleanup = () => {
            reader.onload = reader.onerror = reader.onabort = null;
            signal.removeEventListener('abort', cancel);
        };
        const fail = (error: unknown) => { cleanup(); reject(error); };
        const cancel = () => {
            cleanup();
            reader.abort();
            reject(signal.reason);
        };
        reader.onload = () => {
            try {
                let code: string;
                try {
                    if (!reader.result || typeof reader.result === 'string') throw new Error();
                    code = new TextDecoder('utf-8', { fatal: true }).decode(reader.result);
                } catch {
                    throw new Error('Не удалось прочитать UTF-8. Сохраните файл в кодировке UTF-8 и откройте снова.');
                }
                if (code.includes('\0')) throw new Error('Файл содержит нулевые символы. Выберите текстовый JavaScript-файл.');
                if (!code.trim()) throw new Error('Файл пуст или содержит только пробельные символы.');
                if (new TextEncoder().encode(code).length > limits.maxCodeBytes) throw new Error(sizeError);
                if (code.split(/\r\n|\r|\n/).length > limits.maxCodeLines) {
                    throw new Error(`Файл должен содержать не более ${limits.maxCodeLines} строк.`);
                }
                cleanup();
                resolve(code.replace(/\r\n|\r/g, '\n'));
            } catch (error) { fail(error); }
        };
        reader.onerror = () => fail(new Error('Не удалось прочитать файл. Попробуйте выбрать его снова.'));
        reader.onabort = () => fail(new DOMException('Чтение файла отменено.', 'AbortError'));
        signal.addEventListener('abort', cancel, { once: true });
        try { reader.readAsArrayBuffer(file); }
        catch { fail(new Error('Не удалось прочитать файл. Попробуйте выбрать его снова.')); }
    });
}
