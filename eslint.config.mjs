import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default [
    { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.idea/**'] },
    {
        ...js.configs.recommended,
        files: ['**/*.{js,cjs,mjs}'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['**/*.{js,cjs}'],
        languageOptions: { sourceType: 'commonjs' },
    },
    ...tseslint.configs.recommended.map((config) => ({
        ...config,
        files: ['**/*.{ts,tsx,mts}'],
    })),
    {
        files: ['apps/*/src/**/*.{ts,tsx}', 'apps/remote/test/**/*.{ts,tsx}'],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ['apps/*/src/**/*.{ts,tsx}'],
        plugins: { 'react-hooks': reactHooks },
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'error',
        },
    },
];
