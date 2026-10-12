const { ESLint } = require('eslint');

async function analyzeCode(code) {
    const eslint = new ESLint({
        useEslintrc: false,
        overrideConfig: {
            env: {
                browser: true,
                es2021: true,
                node: true,
            },
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
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

    return output || 'No issues found';
}

module.exports = { analyzeCode };
