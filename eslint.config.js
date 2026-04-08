import js from '@eslint/js';

export default [
    {
        ignores: ['node_modules/', 'dist/'],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // GJS runtime globals (not present in browser or Node environments).
                console:     'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
            },
        },
        rules: {
            'no-var':         'error',
            'prefer-const':   'error',
            'eqeqeq':         ['error', 'always'],
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
        },
    },
];
