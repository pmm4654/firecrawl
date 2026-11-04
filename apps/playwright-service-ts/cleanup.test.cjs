const assert = require('node:assert/strict');
const { before, test, mock } = require('node:test');

// Exercise the real Express handlers without opening sockets or Chromium.
// Only their I/O boundaries are replaced; semaphore and cleanup code are real.
const handlers = new Map();
let scenario = {};
let contexts = [];
const browser = {
  async newContext() {
    const behavior = scenario;
    const page = {
      closeCalls: 0,
      async close() {
        this.closeCalls++;
        if (behavior.pageClose === 'reject') throw new Error('Page crashed');
        if (behavior.pageClose === 'hang') await new Promise(() => {});
      },
      async goto() {
        return {
          status: () => 200,
          allHeaders: async () => ({ 'content-type': 'text/html' }),
        };
      },
      async content() {
        return '<html>test</html>';
      },
    };
    const context = {
      page,
      closeCalls: 0,
      async route() {},
      async newPage() {
        if (behavior.newPageFails) throw new Error('Page could not open');
        return page;
      },
      async close() {
        this.closeCalls++;
        if (behavior.contextClose === 'reject')
          throw new Error('Context crashed');
        if (behavior.contextClose === 'hang') await new Promise(() => {});
      },
    };
    contexts.push(context);
    return context;
  },
};

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

before(async () => {
  process.env.MAX_CONCURRENT_PAGES = '1';
  process.env.CLOSE_TIMEOUT_MS = '1000';
  process.env.ALLOW_LOCAL_WEBHOOKS = 'true';
  process.env.BLOCK_MEDIA = 'false';
  delete process.env.PROXY_SERVER;
  const express = () => ({
    use() {},
    get(path, handler) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path, handler) {
      handlers.set(`POST ${path}`, handler);
    },
    listen(_port, ready) {
      ready();
    },
  });
  express.json = () => () => {};
  mock.module('express', { defaultExport: express });
  mock.module('dotenv', { defaultExport: { config() {} } });
  mock.module('playwright', {
    namedExports: { chromium: { launch: async () => browser } },
  });
  mock.module('proxy-chain', {
    namedExports: {
      Server: class {
        port = 12345;
        async listen() {}
      },
      RequestError: class extends Error {},
    },
  });
  require('./api.ts');
  await new Promise((resolve) => setImmediate(resolve));
});

for (const behavior of [
  {},
  { pageClose: 'reject' },
  { contextClose: 'reject' },
  { pageClose: 'reject', contextClose: 'reject' },
  { pageClose: 'hang' },
  { contextClose: 'hang' },
  { newPageFails: true },
]) {
  test(
    `cleanup restores capacity after ${JSON.stringify(behavior)}`,
    { timeout: 5000 },
    async () => {
      scenario = behavior;
      contexts = [];
      const result = response();
      await handlers.get('POST /scrape')(
        { body: { url: 'https://example.com/' } },
        result,
      );
      assert.equal(result.statusCode, behavior.newPageFails ? 500 : 200);
      assert.equal(contexts[0].closeCalls, 1, 'context cleanup must still run');
      assert.equal(contexts[0].page.closeCalls, behavior.newPageFails ? 0 : 1);

      scenario = {};
      const health = response();
      await handlers.get('GET /health')({}, health);
      assert.equal(
        health.body.availablePermits,
        1,
        'release exactly one permit',
      );
      assert.equal(health.body.queuedRequests, 0);

      const next = response();
      await handlers.get('POST /scrape')(
        { body: { url: 'https://example.com/' } },
        next,
      );
      assert.equal(next.statusCode, 200, 'the next request must not hang');
    },
  );
}
