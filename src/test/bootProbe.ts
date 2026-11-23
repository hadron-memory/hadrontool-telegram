/**
 * Boot probe for the production-refusal tests (src/boot.test.ts, #1 F1/F5):
 * imports the real config and db modules exactly as src/index.ts does, so an
 * import-time refusal fails this process with its message on stderr. Prints
 * BOOT_OK when both load. Never runs queries — constructing the engine-less
 * client opens no connection.
 */
await import('../config.js');
await import('../db.js');
console.log('BOOT_OK');
process.exit(0);
