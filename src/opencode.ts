export * from "../packages/opencode/src/index.ts";
// export * drops the "default" name by spec; re-export it explicitly so hosts
// that load the default export (file plugin loaders) find the V1 plugin.
export { SupraCortex as default } from "../packages/opencode/src/index.ts";
