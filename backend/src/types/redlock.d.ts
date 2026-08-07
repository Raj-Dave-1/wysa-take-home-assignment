// The redlock@5.0.0-beta.2 package ships types at `dist/index.d.ts` but its
// package.json "exports" only lists the ESM/CJS JS entries, so TS Bundler
// resolution can't find them. Re-export from the internal typings path.
declare module "redlock" {
  export * from "redlock/dist/index.js";
  export { default } from "redlock/dist/index.js";
}
