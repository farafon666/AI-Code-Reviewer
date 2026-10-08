const { ESLint } = require('eslint');

async function analyzeCode(code) {
    const eslint = new ESLint({
        useEslintrc: false,
        overrideConfig: {
            parser: '@typescript-eslint/parser',
            plugins: ['@typescript-eslint'],
            rules: {
                'no-unused-vars': 'warn',
                'no-console': 'off',
                'semi': ['error', 'always'],
            },
        },
    });

    const results = await eslint.lintText(code);
    const formatter = await eslint.loadFormatter('stylish');
    const output = formatter.format(results);

    // Возвращаем код с замечаниями
    return output || 'No issues found';
}

module.exports = { analyzeCode };