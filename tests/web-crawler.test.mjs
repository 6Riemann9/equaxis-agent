import test from "node:test";
import assert from "node:assert/strict";
import {
  assertUrlAllowed,
  crawlWeb,
  extractHtmlContent,
  isBlockedIpAddress,
  normalizeCrawlOptions
} from "../src/web-crawler.mjs";

const resolvePublicHost = async () => [{ address: "93.184.216.34", family: 4 }];

test("extracts title, readable text, and absolute links from HTML", () => {
  const result = extractHtmlContent(`
    <html>
      <head><title>Example &amp; Test</title><style>.x{}</style></head>
      <body>
        <h1>Hello</h1><script>ignore()</script>
        <p>Read&nbsp;me</p>
        <a href="/docs?a=1&amp;b=2#section">Docs</a>
      </body>
    </html>
  `, "https://example.com/base/page");

  assert.equal(result.title, "Example & Test");
  assert.match(result.text, /Hello Read me/);
  assert.deepEqual(result.links, ["https://example.com/docs?a=1&b=2"]);
});

test("blocks localhost and private network targets", async () => {
  await assert.rejects(() => assertUrlAllowed("http://localhost:3000"), /local hostname/);
  await assert.rejects(() => assertUrlAllowed("http://127.0.0.1"), /private or reserved/);
  await assert.rejects(() => assertUrlAllowed("http://[::1]"), /private or reserved/);
  assert.equal(isBlockedIpAddress("192.168.1.10"), true);
  assert.equal(isBlockedIpAddress("93.184.216.34"), false);
});

test("normalizes crawl options within configured bounds", () => {
  const options = normalizeCrawlOptions({
    url: "https://example.com",
    maxPages: 99,
    maxDepth: 99,
    maxCharsPerPage: 10,
    timeoutMs: 1
  });

  assert.equal(options.maxPages, 20);
  assert.equal(options.maxDepth, 3);
  assert.equal(options.maxCharsPerPage, 500);
  assert.equal(options.timeoutMs, 1000);
});

test("crawls public same-origin pages with a provided fetch implementation", async () => {
  const pages = new Map([
    ["https://example.com/", `<title>Home</title><main>Home page</main><a href="/next">Next</a><a href="https://other.example/skip">Skip</a>`],
    ["https://example.com/next", `<title>Next</title><main>Next page</main>`]
  ]);
  const fetchImpl = async (url) => new Response(pages.get(url) ?? "missing", {
    status: pages.has(url) ? 200 : 404,
    headers: { "content-type": "text/html; charset=utf-8" }
  });

  const result = await crawlWeb({
    url: "https://example.com/",
    maxPages: 2,
    maxDepth: 1,
    includeLinks: true
  }, {
    fetchImpl,
    resolveHost: resolvePublicHost
  });

  assert.equal(result.pageCount, 2);
  assert.equal(result.pages[0].title, "Home");
  assert.equal(result.pages[1].url, "https://example.com/next");
  assert.equal(result.skipped[0].reason, "outside same origin");
});

test("blocks redirects to private or local addresses before following them", async () => {
  const fetchImpl = async () => new Response("", {
    status: 302,
    headers: { location: "http://127.0.0.1/admin" }
  });

  const result = await crawlWeb({ url: "https://example.com/" }, {
    fetchImpl,
    resolveHost: resolvePublicHost
  });

  assert.equal(result.pageCount, 1);
  assert.equal(result.pages[0].ok, false);
  assert.match(result.pages[0].error, /private or reserved/);
});
