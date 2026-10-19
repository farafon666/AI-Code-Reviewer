import React, { lazy, Suspense } from 'react';

// Module Federation загружает общий интерфейс из remote вместе с его собственными стилями.
const RemoteReviewer = lazy(() => import('remote/CodeReviewer'));

/**
 * Подключает рабочую область проверки к host и показывает доступный статус загрузки чанков.
 *
 * @returns {React.ReactElement} Общий интерфейс remote либо временное сообщение Suspense.
 */
const App: React.FC = () => {
    return (
        <Suspense fallback={<main className="host-loading" role="status">Загрузка AI Code Reviewer…</main>}>
            <RemoteReviewer />
        </Suspense>
    );
};

export default App;
