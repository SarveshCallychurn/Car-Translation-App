// Netlify Function (v2). Receives a photo, asks Google's Gemini (free tier) to translate the
// Japanese text in it, and streams the English translation back as plain text.
// The API key lives only in the GEMINI_API_KEY environment variable.

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_IMAGE_CHARS = 5_500_000; // base64 chars (~4 MB photo); Netlify request cap is ~6 MB
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "10", 10); // requests per IP per hour
const WINDOW_MS = 60 * 60 * 1000;

// Best-effort rate limiting (in-memory, so it resets when the function instance is recycled).
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }
  return false;
}

// Give an attempt back when Google failed, so errors don't use up the visitor's allowance.
function refund(ip) {
  const list = hits.get(ip);
  if (list && list.length) list.pop();
}

const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function buildPrompt(car) {
  return [
    "You are translating a photo of Japanese text from a car (owner's manual page, dashboard message, warning label, sticker, or button panel) into English for the owner.",
    car ? `The car is: ${car}.` : "",
    "",
    "Do this:",
    "1. Read ALL Japanese text in the photo carefully, including small print, captions, and text next to icons.",
    "2. Give a faithful, natural English translation that keeps the original order and structure (headings, numbered steps, bullet points, tables).",
    "3. Use standard automotive terminology (e.g. 取扱説明書 = owner's manual, 警告灯 = warning light, 車検 = shaken / vehicle inspection).",
    "4. If a word or part is unreadable or ambiguous, write [unclear] and say what you think it might be.",
    "5. If the text describes a warning or safety-critical step, put a line starting with 'WARNING:' before it.",
    "6. If the photo contains no Japanese text, say so briefly.",
    "",
    "Output format, plain text only (no markdown symbols like ** or #):",
    "TRANSLATION",
    "<the English translation>",
    "",
    "NOTES (only if useful: unit conversions, what a symbol means, terms worth knowing)",
    "<short notes>",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export default async (req) => {
  // Open /api/translate in a browser to check the setup (never reveals the key).
  if (req.method === "GET") {
    return json({ ok: true, model: MODEL, keyConfigured: Boolean(process.env.GEMINI_API_KEY) }, 200);
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!process.env.GEMINI_API_KEY) {
    return json({ error: "Server is not configured (missing API key)." }, 500);
  }

  const ip =
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
  if (limited(ip)) {
    return json({ error: "Too many requests. Please try again later." }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const image = typeof body.image === "string" ? body.image : "";
  const car = typeof body.car === "string" ? body.car.slice(0, 80) : "";
  if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ error: "No valid image received." }, 400);
  if (image.length > MAX_IMAGE_CHARS) return json({ error: "Image is too large." }, 413);

  // Try the main model first; if Google is overloaded (503), out of quota (429) or the model is
  // unavailable (404/500), automatically try the backup models.
  const models = [
    MODEL,
    ...(process.env.GEMINI_FALLBACK_MODELS || "gemini-3.7-flash,gemini-3.5-flash").split(","),
  ]
    .map((m) => m.trim())
    .filter((m, i, arr) => m && arr.indexOf(m) === i);

  const requestBody = (model) => {
    const generationConfig = { maxOutputTokens: 4096, temperature: 0.2 };
    // On 2.5 Flash, skip "thinking" so answers start quickly (Netlify functions have short time limits).
    if (/2\.5-flash/.test(model) && !/lite/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    return JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: image } },
            { text: buildPrompt(car) },
          ],
        },
      ],
      generationConfig,
    });
  };

  let upstream = null;
  let lastStatus = 0;
  let lastDetail = "";
  for (const model of models) {
    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY,
          },
          body: requestBody(model),
        }
      );
    } catch {
      lastStatus = 502;
      lastDetail = "Could not reach the translation service.";
      continue;
    }
    if (res.ok && res.body) {
      upstream = res;
      break;
    }
    lastStatus = res.status;
    lastDetail = "";
    try {
      const raw = await res.text();
      console.error("Gemini error", model, res.status, raw.slice(0, 500));
      try { lastDetail = JSON.parse(raw).error.message || ""; } catch { lastDetail = raw.slice(0, 200); }
    } catch {}
    // Only move on to the next model for temporary or model-specific problems.
    if (![404, 429, 500, 503].includes(res.status)) break;
  }

  if (!upstream) {
    refund(ip);
    if (lastStatus === 429) {
      return json({ error: "The free translation quota is used up for now. Please try again later." }, 429);
    }
    if (lastStatus === 503) {
      return json({ error: "Google's free translation service is very busy right now. Please try again in a minute." }, 503);
    }
    return json({ error: `Translation service error (${lastStatus}). ${lastDetail}`.trim().slice(0, 300) }, 502);
  }

  // Convert Gemini's server-sent events into a plain text stream.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = "";

  const handleEvent = (evt, controller) => {
    const line = evt.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    let data;
    try {
      data = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    for (const p of parts) {
      if (p.text && !p.thought) controller.enqueue(encoder.encode(p.text));
    }
  };

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) handleEvent(buffer, controller);
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const events = buffer.split("\n\n");
        buffer = events.pop();
        for (const evt of events) handleEvent(evt, controller);
      } catch {
        controller.enqueue(encoder.encode("\n\n[The translation was interrupted. Please try again.]"));
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
};

export const config = { path: "/api/translate" };
