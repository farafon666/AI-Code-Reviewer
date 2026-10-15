import React, { useState } from 'react';

const CodeReviewer: React.FC = () => {
    const [code, setCode] = useState('');
    const [review, setReview] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setReview('');
        try {
            const response = await fetch('/api/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const data = await response.json();
            setReview(data.review || 'No review returned');
        } catch (error) {
            setReview('Error: ' + (error as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{ border: '1px solid #ccc', padding: '15px', marginTop: '10px' }}>
            <h3>AI Code Reviewer</h3>
            <form onSubmit={handleSubmit}>
        <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={10}
            cols={60}
            placeholder="Вставьте код для ревью"
        />
                <br />
                <button type="submit" disabled={loading}>
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
