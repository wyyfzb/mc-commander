/** vite define 注入的全局常量（vite.config.ts） */
declare const __APP_VERSION__: string

/**
 * monaco-editor 的语言定义与语言服务模块（侧效应导入）不带类型声明：包 exports 只把 `./*`
 * 映射到 `./esm/vs/*.js`，而这些 register/contribution 只有 JS。按需引入语言是刻意的
 * （整包引入会打进 ts/css/html 三套语言服务，实测 8.5MB 冗余），故在此声明它们存在即可。
 */
declare module 'monaco-editor/languages/definitions/*'
declare module 'monaco-editor/language/json/monaco.contribution'
