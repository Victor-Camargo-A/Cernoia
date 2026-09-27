import assert from "node:assert/strict";
import test from "node:test";



test("renders public SEO metadata in the initial HTML", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<title>CernoIA \| Licitaciones SECOP y análisis de requisitos con IA<\/title>/);
  assert.match(html, /name="description" content="Encuentra oportunidades en SECOP, analiza requisitos con IA y prepara propuestas con CernoIA\./);
  assert.match(html, /rel="canonical" href="https:\/\/cernoia\.energeticanika\.com\/"/);
  assert.match(html, /application\/ld\+json/);
  assert.doesNotMatch(html, /name="codex-preview"/);
  assert.doesNotMatch(html, /name="robots" content="noindex/);
});
