/// <reference types="vite/client" />

// Vite's ambient types, which is what makes `import.meta.env` (DEV, PROD, MODE) known to
// TypeScript. The project had no need for it until the login screen had to stop shipping
// its demo credentials in a production build.
