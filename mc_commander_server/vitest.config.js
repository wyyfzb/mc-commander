import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      API_KEY: 'test-api-key-for-unit-tests'
    }
  }
});
