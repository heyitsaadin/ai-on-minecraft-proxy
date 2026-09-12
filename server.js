// AI on Minecraft — free-tier proxy server
//
// Purpose: the mod's "free" tier should work for any player with zero setup.
// That means a Groq API key has to live SOMEWHERE that isn't the player's
// computer (an embedded key in the mod jar can be extracted trivially).
// This tiny server holds the real key as a server-side secret and exposes
// one endpoint the mod calls instead.
//
// Deploy this anywhere that runs Node (Render, Railway, Fly.io, a VPS, etc).
// Set the GROQ_API_KEY environment variable there — never commit it to code.

import express from "express";
import rateLimit from "express-rate-limit";

const app = express();
app.use(express.json({ limit: "100kb" }));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.1-8b-instant was deprecated by Groq (announced June 2026); this
// is their recommended 1:1 replacement for free/developer-tier usage.
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY environment variable. Set it before starting the server.");
  process.exit(1);
}

// Basic abuse protection: caps how many requests a single IP can make.
// Tune these numbers based on how many concurrent players you expect —
// this is deliberately conservative to start.
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,             // 20 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down a little." },
});
app.use("/chat", limiter);

app.post("/chat", async (req, res) => {
  const { messages } = req.body ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Request must include a non-empty 'messages' array." });
  }

  // Basic shape/size guardrails so a malicious client can't send an
  // enormous payload or garbage roles that could waste API spend.
  if (messages.length > 30) {
    return res.status(400).json({ error: "Too many messages in one request." });
  }
  for (const m of messages) {
    if (typeof m.role !== "string" || typeof m.content !== "string") {
      return res.status(400).json({ error: "Each message needs a string 'role' and 'content'." });
    }
    if (m.content.length > 2000) {
      return res.status(400).json({ error: "A message is too long." });
    }
  }

  try {
    const groqResponse = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: 200,
        temperature: 0.9,
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error("Groq error:", groqResponse.status, errText);
      return res.status(502).json({ error: "Upstream AI provider error." });
    }

    const data = await groqResponse.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      return res.status(502).json({ error: "No reply returned from provider." });
    }

    return res.json({ reply });
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Internal proxy error." });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI on Minecraft proxy listening on port ${PORT}`);
});
