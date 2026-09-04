import test from "node:test";
import assert from "node:assert/strict";

import { canUseLocalOllama, streamProviderChat } from "./chatProviders.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

test("local Ollama provider streams directly from the browser endpoint", async () => {
  let request;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(streamFromText(
      '{"message":{"content":"{\\"inputs\\":"}}\n{"message":{"content":"{\\"nums\\":[1,2]}}"}}\n',
    ));
  };

  try {
    let response = "";
    for await (const delta of streamProviderChat(
      [{ role: "user", text: "make inputs" }],
      { provider: "ollama-local", model: "test-model" },
    )) {
      response += delta;
    }

    assert.equal(request.url, "http://127.0.0.1:11434/api/chat");
    assert.equal(JSON.parse(request.init.body).model, "test-model");
    assert.equal(response, '{"inputs":{"nums":[1,2]}}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("huge AI requests fail before hitting fetch", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not run");
  };

  try {
    await assert.rejects(
      async () => {
        for await (const _delta of streamProviderChat(
          [{ role: "user", text: "x".repeat(100_000) }],
          { provider: "ollama-local", model: "test-model" },
        )) {
          // Exhaust the stream.
        }
      },
      /too large/i,
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud providers stream through the hosted proxy", async () => {
  let request;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(streamFromText('{"message":{"content":"ok"}}\n'));
  };

  try {
    let response = "";
    for await (const delta of streamProviderChat(
      [{ role: "user", text: "make inputs" }],
      { provider: "gemini", model: "gemini-2.5-flash", geminiApiKey: "test-key" },
    )) {
      response += delta;
    }

    assert.equal(request.url, "/api/chat");
    assert.equal(JSON.parse(request.init.body).provider, "gemini");
    assert.equal(response, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted pages may still attempt local Ollama when explicitly selected", async () => {
  const previousWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.window = { location: { hostname: "codeplaygroundwebmcp.vercel.app" } };
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(streamFromText('{"message":{"content":"ok"}}\n'));
  };

  try {
    assert.equal(canUseLocalOllama(), false);
    let response = "";
    for await (const delta of streamProviderChat(
      [{ role: "user", text: "make inputs" }],
      { provider: "ollama-local", model: "test-model" },
    )) {
      response += delta;
    }

    assert.equal(request.url, "http://127.0.0.1:11434/api/chat");
    assert.equal(response, "ok");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    globalThis.fetch = originalFetch;
  }
});
