/** Ошибка с HTTP-статусом и сообщением, которое можно вернуть клиенту в поле error. */
class HttpError extends Error {
    /**
     * @param {number} status HTTP-статус ответа.
     * @param {string} message Публичное сообщение без внутренних деталей и исходного кода.
     * @param {{cause?: unknown}} [options] Исходная ошибка для диагностики внутри приложения.
     */
    constructor(status, message, options) {
        super(message, options);
        this.name = 'HttpError';
        this.status = status;
    }
}

module.exports = { HttpError };
