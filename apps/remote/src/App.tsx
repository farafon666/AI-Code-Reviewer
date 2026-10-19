import React from 'react';
import CodeReviewer from './CodeReviewer';

/**
 * Открывает тот же интерфейс проверки напрямую, без оболочки host и дублирующих заголовков.
 *
 * @returns {React.ReactElement} Самостоятельная рабочая область CodeReviewer.
 */
const App: React.FC = () => {
    return <CodeReviewer />;
};

export default App;
