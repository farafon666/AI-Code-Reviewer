import { describe, expect, it, vi } from 'vitest';
import { readCodeFile } from '../src/readCodeFile';

const limits = { maxCodeBytes: 32 * 1024, maxCodeLines: 1000 };

function read(file: File, overrides: Partial<typeof limits> = {}) {
    return readCodeFile(file, { ...limits, ...overrides }, new AbortController().signal);
}

describe('чтение локального исходника', () => {
    it.each(['source.js', 'view.jsx', 'module.mjs', 'module.cjs', 'SOURCE.JS', 'VIEW.JSX'])
        ('принимает %s без обязательного MIME-типа', async (name) => {
            await expect(read(new File(['const message = "Привет";'], name)))
                .resolves.toBe('const message = "Привет";');
        });

    it.each(['\n', '\r\n', '\r'])('удаляет BOM и нормализует переводы строк %j', async (newline) => {
        const source = ['// Привет', 'console.log("мир");', ''].join(newline);
        await expect(read(new File(['\uFEFF', source], 'source.js')))
            .resolves.toBe('// Привет\nconsole.log("мир");\n');
    });

    it.each(['abcdef', 'ééé', '\uFEFFééé', 'a\r\nb'])('принимает границы лимитов: %j', async (code) => {
        await expect(read(new File([code], 'source.js'), { maxCodeBytes: 6, maxCodeLines: 2 }))
            .resolves.toBe(code.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
    });

    it.each([
        ['source.ts', new File(['const x = 1;'], 'source.ts'), {}, /Выберите JavaScript-файл/],
        ['двойное расширение', new File(['x'], 'source.js.exe'), {}, /Выберите JavaScript-файл/],
        ['пустой файл', new File([], 'source.js'), {}, /Файл пуст/],
        ['пробелы и BOM', new File(['\uFEFF \t\r\n'], 'source.js'), {}, /Файл пуст/],
        ['неверный UTF-8', new File([new Uint8Array([0xc3, 0x28])], 'source.js'), {}, /кодировке UTF-8/],
        ['UTF-16', new File([new Uint8Array([0xff, 0xfe, 0x61, 0])], 'source.js'), {}, /кодировке UTF-8/],
        ['нулевые символы', new File(['const x = 1;\0'], 'source.js'), {}, /нулевые символы/],
        ['ASCII-байты', new File(['abcdefg'], 'source.js'), { maxCodeBytes: 6 }, /не более 6 байт/],
        ['UTF-8 байты', new File(['éééé'], 'source.js'), { maxCodeBytes: 6 }, /не более 6 байт/],
        ['BOM сверх лимита', new File(['\uFEFFabcdefg'], 'source.js'), { maxCodeBytes: 6 }, /не более 6 байт/],
        ['строки LF', new File(['a\nb\nc'], 'source.js'), { maxCodeLines: 2 }, /не более 2 строк/],
        ['строки CRLF', new File(['a\r\nb\r\nc'], 'source.js'), { maxCodeLines: 2 }, /не более 2 строк/],
        ['строки CR', new File(['a\rb\rc'], 'source.js'), { maxCodeLines: 2 }, /не более 2 строк/],
        ['размер до нормализации', new File(['a\r\nb'], 'source.js'), { maxCodeBytes: 3 }, /не более 3 байт/],
    ])('отклоняет: %s', async (_name, file, overrides, message) => {
        await expect(read(file, overrides)).rejects.toThrow(message);
    });

    it('не читает файл, превышающий бюджет с допуском BOM', async () => {
        const readSpy = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
        await expect(read(new File(['0123456789'], 'source.js'), { maxCodeBytes: 6 }))
            .rejects.toThrow(/не более 6 байт/);
        expect(readSpy).not.toHaveBeenCalled();
    });

    it('сообщает об ошибке чтения понятным сообщением', async () => {
        vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (this: FileReader) {
            this.dispatchEvent(new ProgressEvent('error'));
        });
        await expect(read(new File(['x'], 'source.js'))).rejects.toThrow('Не удалось прочитать файл.');
    });

    it('отменяет активный FileReader и отклоняет чтение причиной отмены', async () => {
        const controller = new AbortController();
        const abortSpy = vi.spyOn(FileReader.prototype, 'abort');
        const promise = readCodeFile(new File(['x'], 'source.js'), limits, controller.signal);
        controller.abort();
        await expect(promise).rejects.toBe(controller.signal.reason);
        expect(abortSpy).toHaveBeenCalledOnce();
    });

    it('не начинает чтение при уже отменённом сигнале', async () => {
        const controller = new AbortController();
        controller.abort();
        const readSpy = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
        await expect(readCodeFile(new File(['x'], 'source.js'), limits, controller.signal))
            .rejects.toBe(controller.signal.reason);
        expect(readSpy).not.toHaveBeenCalled();
    });
});
