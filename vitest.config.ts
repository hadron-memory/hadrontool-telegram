import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests always run against the dedicated test DB, regardless of .env —
    // same posture as hadron-server's vitest config.
    env: {
      DATABASE_URL: 'postgresql://holger@localhost:5432/hadrontool_telegram_test',
      NODE_ENV: 'test',
      TOKEN_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      TELEGRAM_TOOL_TOKEN: 'test-tool-token',
      // No pacing gaps in tests — the pacer's queueing is tested explicitly.
      TELEGRAM_SEND_GAP_MS: '0',
    },
    // DB-backed route tests share tables; run files sequentially.
    fileParallelism: false,
  },
});
