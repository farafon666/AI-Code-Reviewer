const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { HttpError } = require('../errors');

/**
 * Ограничения и отмена одной задачи статического анализа.
 *
 * @typedef {object} AnalysisOptions
 * @property {AbortSignal} [signal] Общий сигнал отмены review.
 * @property {number} [timeoutMs=5000] Дедлайн worker в миллисекундах, включая его запуск.
 * @property {number} [maxFindings=20] Максимальное число замечаний в отчёте.
 * @property {number} [maxOutputBytes=4096] Размер отчёта UTF-8 вместе с пометкой сокращения.
 * @property {number} [memoryMb=128] Предел old-generation heap worker в МиБ.
 */

/**
 * @callback StaticAnalyzer
 * @param {string} code Исходный код для разбора без его выполнения.
 * @param {AnalysisOptions} [options] Ограничения задачи и сигнал отмены.
 * @returns {Promise<string>} Ограниченный по размеру текстовый отчёт ESLint.
 */

/**
 * Создаёт анализатор, который изолирует разбор кода от основного потока HTTP-сервера.
 * Подмена фабрики worker позволяет воспроизводимо проверять зависания и отмену в тестах.
 *
 * @param {object} [dependencies] Заменяемые зависимости анализатора.
 * @param {(data: {code: string, maxFindings: number, maxOutputBytes: number}, memoryMb: number)
 *   => import('node:worker_threads').Worker} [dependencies.workerFactory] Фабрика потока ESLint.
 * @returns {StaticAnalyzer} Анализатор с отдельным worker для каждого вызова.
 */
function createStaticAnalyzer({ workerFactory = (data, memoryMb) => new Worker(
    path.join(__dirname, 'staticAnalyzerWorker.js'),
    { workerData: data, resourceLimits: { maxOldGenerationSizeMb: memoryMb } },
) } = {}) {
    return async function analyzeCode(code, {
        signal, timeoutMs = 5000, maxFindings = 20, maxOutputBytes = 4096, memoryMb = 128,
    } = {}) {
        signal?.throwIfAborted();
        const worker = workerFactory({ code, maxFindings, maxOutputBytes }, memoryMb);
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                finish(new HttpError(422, 'Static analysis timed out. Simplify the code and try again.'));
            }, timeoutMs);
            const onAbort = () => finish(signal.reason);

            /**
             * Завершает задачу ровно один раз, даже если таймер и событие worker пришли рядом.
             *
             * @param {unknown} error Причина отказа; null при успешном завершении.
             * @param {string} [output] Текст отчёта при успехе.
             * @returns {void}
             */
            function finish(error, output) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                // Promise завершается после остановки потока: до этого слот review остаётся занят.
                worker.terminate().then(() => {
                    if (error) reject(error);
                    else resolve(output);
                }, reject);
            }

            worker.once('message', (message) => {
                if (message.error) finish(new HttpError(422, 'Static analysis could not process this code'));
                else finish(null, message.output);
            });
            worker.once('error', () => finish(new HttpError(422, 'Static analysis worker failed')));
            // Даже штатный exit без сообщения считается ошибкой, иначе Promise зависнет до таймера.
            worker.once('exit', () => {
                if (!settled) finish(new HttpError(422, 'Static analysis worker exited without a result'));
            });
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    };
}

const analyzeCode = createStaticAnalyzer();
module.exports = { analyzeCode, createStaticAnalyzer };
