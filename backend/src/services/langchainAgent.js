const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { ChatOpenAI } = require('langchain/chat_models/openai');
const { DynamicTool } = require('langchain/tools');
const { analyzeCode } = require('./staticAnalyzer');

async function runCodeReview(code) {
    // Создаём инструмент статического анализатора
    const staticAnalyzerTool = new DynamicTool({
        name: 'static-code-analyzer',
        description: 'Analyzes JavaScript/TypeScript code and returns linting issues. Input should be the code string.',
        func: async (input) => {
            return await analyzeCode(input);
        },
    });

    // Инициализируем модель
    const model = new ChatOpenAI({
        openAIApiKey: process.env.OPENAI_API_KEY,
        temperature: 0,
        modelName: 'gpt-3.5-turbo',
    });

    // Создаём агента с инструментом
    const executor = await initializeAgentExecutorWithOptions(
        [staticAnalyzerTool],
        model,
        {
            agentType: 'openai-functions',
            verbose: true,
        }
    );

    const prompt = `You are a code reviewer. Use the static-code-analyzer tool on the following code and then provide a summary of the issues found. Code:\n\n${code}`;

    const result = await executor.run(prompt);
    return result;
}

module.exports = { runCodeReview };