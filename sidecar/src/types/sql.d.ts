// Ambient declaration so `import x from ".../*.sql" with { type: "text" }`
// type-checks as a string. Bun embeds the file's contents into the compiled
// binary at build time; tsc just needs to know the module resolves to a
// `string` default export. Without this, tsc reports
// TS2307 "Cannot find module '*.sql' or its corresponding type declarations".
declare module "*.sql" {
  const content: string;
  export default content;
}
