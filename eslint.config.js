"use strict";

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    {
        ignores: ["node_modules/"]
    },
    js.configs.recommended,
    {
        files: ["spicetify-connect-api.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: {
                ...globals.browser,
                Spicetify: "readonly"
            }
        },
        rules: {
            "no-empty": ["error", { allowEmptyCatch: true }],
            "no-unused-vars": ["error", { caughtErrors: "none" }]
        }
    },
    {
        files: ["eslint.config.js", "test/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: globals.node
        }
    }
];
