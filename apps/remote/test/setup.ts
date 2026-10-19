import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom не вычисляет геометрию страницы, но CodeMirror обращается к Range для измерения выделения.
// Эти заглушки позволяют тестировать поведение; размеры и адаптивность проверяются в браузере.
/**
 * Возвращает пустой список прямоугольников выделения без попытки вычислить реальную вёрстку.
 *
 * @returns {DOMRectList} Пустой совместимый список с методом item(), ожидаемым CodeMirror.
 */
Range.prototype.getClientRects = () => Object.assign([], { item: () => null });

/**
 * Предоставляет нулевой прямоугольник для измерений каретки в среде без расчёта вёрстки.
 *
 * @returns {DOMRect} Прямоугольник с нулевыми координатами и размерами.
 */
Range.prototype.getBoundingClientRect = () => new DOMRect();

afterEach(() => {
    // Сначала размонтируем компоненты, чтобы их эффекты очистили таймеры до восстановления реального времени.
    cleanup();
    vi.useRealTimers();
});
