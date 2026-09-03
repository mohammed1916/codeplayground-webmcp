const MAX_REQUEST_CHARS = 90_000;

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch {
      return Promise.reject(new Error("Invalid JSON request."));
    }
  }
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_REQUEST_CHARS) {
        reject(new Error("AI request is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON request."));
      }
    });
    req.on("error", reject);
  });
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
    content: String(message.text ?? message.content ?? ""),
  })).filter((message) => message.content.trim());
}

function writeText(res, status, text) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

async function streamResponseBody(providerResponse, res) {
  if (!providerResponse.ok) {
    writeText(res, providerResponse.status, await providerResponse.text());
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const reader = providerResponse.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function handleOllamaCloud(body, res) {
  const key = body.ollamaApiKey || process.env.OLLAMA_API_KEY;
  if (!key) {
    writeText(res, 400, "Missing Ollama API key. Add OLLAMA_API_KEY in Vercel or enter a key in the provider panel.");
    return;
  }
  const baseUrl = (process.env.OLLAMA_BASE_URL || "https://ollama.com/api").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: body.model || "gpt-oss:120b",
      stream: true,
      messages: normalizeMessages(body.messages),
    }),
  });
  await streamResponseBody(response, res);
}

async function handleGemini(body, res) {
  const key = body.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    writeText(res, 400, "Missing Gemini API key. Add GEMINI_API_KEY in Vercel or enter a key in the provider panel.");
    return;
  }
  const model = encodeURIComponent(body.model || "gemini-2.5-flash");
  const messages = normalizeMessages(body.messages);
  const systemInstruction = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        contents,
      }),
    },
  );
  if (!response.ok) {
    writeText(res, response.status, await response.text());
    return;
  }
  const result = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ message: { content: text } }) + "\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    writeText(res, 405, "Method not allowed.");
    return;
  }
  try {
    const body = await readBody(req);
    if (body.provider === "ollama-cloud") {
      await handleOllamaCloud(body, res);
    } else if (body.provider === "gemini") {
      await handleGemini(body, res);
    } else {
      writeText(res, 400, "Unsupported hosted AI provider.");
    }
  } catch (error) {
    writeText(res, 500, error?.message || "AI proxy failed.");
  }
}
