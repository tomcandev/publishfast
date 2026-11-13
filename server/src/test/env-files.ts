/** Import right after ./env.js in files.test.ts: a 6 MiB drop-box cap so the size limit is cheap to test. */
process.env.MAX_FILE_BYTES = String(6 * 1024 * 1024)
