import React, { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { tags } from '@lezer/highlight';

// Классы связывают токены синтаксиса с CSS-переменными обеих тем без пересоздания редактора.
const highlighting = HighlightStyle.define([
    { tag: tags.keyword, class: 'reviewer-syntax-keyword' },
    { tag: [tags.string, tags.regexp], class: 'reviewer-syntax-string' },
    { tag: [tags.number, tags.bool, tags.null], class: 'reviewer-syntax-number' },
    { tag: tags.comment, class: 'reviewer-syntax-comment' },
    { tag: tags.function(tags.variableName), class: 'reviewer-syntax-function' },
]);

/** Параметры редактора, содержимым которого управляет родительский React-компонент. */
interface CodeEditorProps {
    /** Исходный код для отображения и синхронизации с состоянием React. */
    value: string;
    /** Передаёт родителю полный текст документа после изменения в CodeMirror. */
    onChange: (value: string) => void;
    /** Запускает проверку; валидация и защита от повторных запросов остаются у родителя. */
    onSubmit: () => void;
    /** Связывает доступное состояние редактора с результатом клиентской валидации. */
    invalid: boolean;
}

/**
 * Встраивает JavaScript-редактор CodeMirror в управляемую React-форму.
 *
 * CodeMirror управляет своим DOM и историей редактирования, а React хранит текст и состояние формы.
 *
 * @param {CodeEditorProps} props Исходный код, обработчики изменений и признак ошибки ввода.
 * @returns {React.ReactElement} Контейнер редактора с подсветкой, номерами строк и горячими клавишами.
 */
export default function CodeEditor({ value, onChange, onSubmit, invalid }: CodeEditorProps) {
    const container = useRef<HTMLDivElement>(null);
    const editor = useRef<EditorView | null>(null);
    const callbacks = useRef({ onChange, onSubmit });
    const initialValue = useRef(value);
    const attributes = useRef(new Compartment());

    // Стабильные расширения CodeMirror вызывают актуальные обработчики без сброса курсора и истории.
    useEffect(() => { callbacks.current = { onChange, onSubmit }; }, [onChange, onSubmit]);

    // Экземпляр создаётся при монтировании и освобождает DOM-обработчики при размонтировании.
    useEffect(() => {
        if (!container.current) return;
        /**
         * Передаёт запуск проверки родителю и подавляет стандартную обработку сочетания клавиш.
         *
         * @returns {boolean} Признак обработанной команды, чтобы Enter не добавил новую строку.
         */
        const submit = () => { callbacks.current.onSubmit(); return true; };
        const view = new EditorView({
            parent: container.current,
            state: EditorState.create({
                doc: initialValue.current,
                extensions: [
                    lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(),
                    indentOnInput(), bracketMatching(), javascript(),
                    syntaxHighlighting(highlighting), EditorState.tabSize.of(2),
                    EditorView.lineWrapping,
                    placeholder('Вставьте JavaScript-код для проверки…'),
                    attributes.current.of(EditorView.contentAttributes.of({})),
                    keymap.of([
                        // Mod соответствует Cmd на macOS и Ctrl на остальных платформах; Tab не перехватывается.
                        { key: 'Mod-Enter', run: submit }, { key: 'Ctrl-Enter', run: submit },
                        ...defaultKeymap, ...historyKeymap,
                    ]),
                    EditorView.updateListener.of((update) => {
                        // Перемещение курсора и смена атрибутов не считаются изменением исходного кода.
                        if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
                    }),
                ],
            }),
        });
        editor.current = view;
        return () => { editor.current = null; view.destroy(); };
    }, []);

    // Внешнее обновление value применяется только при отличии текста, чтобы избежать цикла обновлений.
    useEffect(() => {
        const view = editor.current;
        if (view && value !== view.state.doc.toString()) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
        }
    }, [value]);

    // Compartment обновляет ARIA-атрибуты существующего редактора, сохраняя документ и историю отмены.
    useEffect(() => {
        editor.current?.dispatch({
            effects: attributes.current.reconfigure(EditorView.contentAttributes.of({
                'aria-label': 'Код для ревью',
                'aria-describedby': 'reviewer-code-count reviewer-code-error',
                'aria-invalid': String(invalid), 'aria-multiline': 'true', spellcheck: 'false',
            })),
        });
    }, [invalid]);

    return <div className="reviewer-code-editor" ref={container} />;
}
