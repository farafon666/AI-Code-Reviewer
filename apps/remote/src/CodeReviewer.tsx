import React, { useEffect, useRef, useState } from 'react';

/** Действующие ограничения backend, получаемые через GET /api/review/limits. */
interface ReviewLimits {
    /** Размер исходной строки в UTF-8, а не число UTF-16 символов JavaScript. */
    maxCodeBytes: number;
    maxCodeLines: number;
    maxConcurrentReviews: number;
    rateLimitMax: number;
    rateLimitWindowMs: number;
    /** Общий дедлайн выполнения анализа и генерации на backend, мс. */
    reviewTimeoutMs: number;
    /** Более длинное ожидание frontend, позволяющее получить ошибку дедлайна от backend, мс. */
    responseTimeoutMs: number;
}

/**
 * Форма локального review с актуальными серверными лимитами и отменой сетевого ожидания.
 *
 * @returns {React.ReactElement} Поле кода, ограничения API и результат последнего запроса.
 */
const CodeReviewer: React.FC = () => {
    const [code, setCode] = useState('');
    const [review, setReview] = useState('');
    const [loading, setLoading] = useState(false);
    const [limits, setLimits] = useState<ReviewLimits | null>(null);
    const [limitsError, setLimitsError] = useState('');
    const [limitsAttempt, setLimitsAttempt] = useState(0);
    const reviewController = useRef<AbortController | null>(null);

    // Читаем лимиты при открытии и ручной повторной попытке: изменения env не требуют пересборки UI.
    useEffect(() => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        let active = true;
        setLimitsError('');
        fetch('/api/review/limits', { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data: ReviewLimits = await response.json();
                // Старый запрос не обновляет состояние после размонтирования или новой попытки.
                if (active) setLimits(data);
            })
            .catch(() => {
                if (active) setLimitsError('Не удалось получить ограничения API. Проверьте доступность backend.');
            })
            .finally(() => clearTimeout(timeout));
        return () => {
            active = false;
            clearTimeout(timeout);
            controller.abort();
        };
    }, [limitsAttempt]);

    // Уход со страницы закрывает запрос; backend получает отключение клиента и отменяет задачу.
    useEffect(() => () => reviewController.current?.abort(), []);

    /**
     * Проверяет размер ввода и отправляет одну задачу с таймаутом из настроек backend.
     *
     * @param {React.FormEvent} e Событие отправки формы.
     * @returns {Promise<void>} Завершение запроса и обновления состояния формы.
     */
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!limits || loading) return;
        if (!code.trim()) {
            setReview('Введите код для ревью.');
            return;
        }
        // Повторяем серверный подсчёт UTF-8 и переводов строк для ранней обратной связи пользователю.
        // Backend остаётся источником проверки, даже если клиентскую валидацию обошли.
        if (new TextEncoder().encode(code).length > limits.maxCodeBytes
            || code.split(/\r\n|\r|\n/).length > limits.maxCodeLines) {
            setReview(`Код должен содержать не более ${limits.maxCodeBytes} байт UTF-8 и ${limits.maxCodeLines} строк.`);
            return;
        }
        setLoading(true);
        setReview('');
        const controller = new AbortController();
        reviewController.current = controller;
        const timeout = setTimeout(() => controller.abort(
            new DOMException('Время ожидания review истекло.', 'TimeoutError'),
        ), limits.responseTimeoutMs);
        try {
            const response = await fetch('/api/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
                signal: controller.signal,
            });
            // Прокси может вернуть не JSON; в таком случае показываем хотя бы HTTP-статус ошибки.
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error || `Review failed: HTTP ${response.status}`);
            if (typeof data?.review !== 'string') throw new Error('API returned an invalid review response');
            setReview(data.review);
        } catch (error) {
            setReview('Error: ' + (error as Error).message);
        } finally {
            clearTimeout(timeout);
            reviewController.current = null;
            setLoading(false);
        }
    };

    return (
        <div style={{ border: '1px solid #ccc', padding: '15px', marginTop: '10px' }}>
            <h3>AI Code Reviewer</h3>
            {limits && (
                <p>
                    До {limits.maxCodeBytes / 1024} КиБ и {limits.maxCodeLines} строк.
                    {' '}{limits.rateLimitMax} запросов за {limits.rateLimitWindowMs / 1000} с;
                    {' '}одновременно: {limits.maxConcurrentReviews};
                    {' '}до {limits.reviewTimeoutMs / 1000} с на review.
                </p>
            )}
            {!limits && !limitsError && <p>Загрузка ограничений API…</p>}
            {limitsError && (
                <p role="alert">
                    {limitsError}{' '}
                    <button type="button" onClick={() => setLimitsAttempt((value) => value + 1)}>
                        Повторить
                    </button>
                </p>
            )}
            <form onSubmit={handleSubmit}>
                <textarea
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    rows={10}
                    cols={60}
                    placeholder="Вставьте код для ревью"
                    aria-label="Код для ревью"
                />
                <br />
                <button type="submit" disabled={loading || !limits}>
                    {loading ? 'Reviewing...' : 'Send for Review'}
                </button>
            </form>
            {review && (
                <div style={{ marginTop: '15px' }}>
                    <h4>Результат:</h4>
                    <pre style={{ whiteSpace: 'pre-wrap' }}>{review}</pre>
                </div>
            )}
        </div>
    );
};

export default CodeReviewer;
