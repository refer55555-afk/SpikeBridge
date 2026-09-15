// Canonical Mac provider entrypoint. The implementation remains in the legacy
// workbee.mjs file temporarily so existing internal imports can transition
// without breaking old snapshots.
export { createMacProvider, createWorkBeeProvider } from "./workbee.mjs";
