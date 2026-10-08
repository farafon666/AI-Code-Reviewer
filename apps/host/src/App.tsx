import React, { lazy, Suspense } from 'react';

// Загружаем микрофронтенд через Module Federation
const RemoteReviewer = lazy(() => import('remote/CodeReviewer'));

const App: React.FC = () => {
    return (
        <div style={{ padding: '20px' }}>
            <h1>Host Application</h1>
            <Suspense fallback={<div>Loading Reviewer...</div>}>
                <RemoteReviewer />
            </Suspense>
        </div>
    );
};

export default App;