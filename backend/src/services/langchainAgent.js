const { ChatOllama } = require('@langchain/ollama');
const { analyzeCode } = require('./staticAnalyzer');

function getMessageContent(response) {
    if (typeof response === 'string') {
        return response;
    }

    if (Array.isArray(response?.content)) {
        return response.content
            .map((part) => (typeof part === 'string' ? part : part.text || ''))
            .join('')
            .trim();
    }

    return response?.content || '';
}

async function runCodeReview(code) {
    const staticAnalysis = await analyzeCode(code);

    const model = new ChatOllama({
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        model: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
        temperature: 0,
    });

    const prompt = [
        'You are a code reviewer.',
        'Use the static analysis output below as the primary source of lint findings.',
        'Then add a concise review summary with the most important risks and suggested fixes.',
        '',
        'Static analysis output:',
        staticAnalysis,
        '',
        'Code:',
        '```',
        code,
        '```',
    ].join('\n');

    const response = await model.invoke(prompt);
    const aiReview = getMessageContent(response);

    return [
        'Static analysis:',
        staticAnalysis,
        '',
        'AI review:',
        aiReview || 'No AI review content returned.',
    ].join('\n');
}

module.exports = { runCodeReview };
