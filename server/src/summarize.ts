// Turns a call recording into a short summary in two steps:
//   1. Transcribe the audio with Whisper (Groq's free OpenAI-compatible API).
//   2. Summarize the transcript with an LLM.
//
// Both run on the FREE Groq API key (GROQ_API_KEY) — no paid plan needed.
// If an ANTHROPIC_API_KEY is also set, the summary/to-dos upgrade to Claude
// automatically; otherwise they use Groq's free Llama model. Either way the
// server still boots fine when keys are absent (the feature just errors politely).
import Anthropic from "@anthropic-ai/sdk";

const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_WHISPER = "whisper-large-v3";
const GROQ_CHAT = "llama-3.3-70b-versatile"; // free, capable summarizer

export async function transcribe(buffer: Buffer, mime: string): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key)
    throw new Error("Transcription isn't configured yet (GROQ_API_KEY missing).");

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mime || "video/webm" }),
    "call.webm"
  );
  form.append("model", GROQ_WHISPER);

  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 413)
      throw new Error("This recording is too large to summarize — try a shorter one.");
    throw new Error(`Transcription failed (${res.status}). ${detail.slice(0, 160)}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

// One chat call — Claude if an Anthropic key is present, else free Groq Llama.
async function chat(system: string, user: string): Promise<string> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const msg = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("Summaries aren't configured yet (GROQ_API_KEY missing).");
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_CHAT,
      max_tokens: 1024,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Summary failed (${res.status}). ${detail.slice(0, 160)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

export async function summarize(transcript: string): Promise<string> {
  return chat(
    "You summarize a recorded family phone or video call from its transcript. " +
      "Reply with a warm 2-3 sentence overview, then a few short bullet points covering " +
      "what was discussed, any decisions made, and any follow-ups or things to remember. " +
      "Keep it friendly and concise. Do not invent details not in the transcript.",
    `Transcript of the call:\n\n${transcript}`
  );
}

export async function generateTodos(
  name: string,
  material: string
): Promise<string> {
  return chat(
    `You turn a week of ${name}'s family call summaries and messages into a short, ` +
      "practical to-do list for them. Output a markdown checklist of concrete action items " +
      "and follow-ups that were mentioned or implied. Group by person when helpful. " +
      "If there are no real action items, say so briefly. Be concise and don't invent tasks.",
    `Here is ${name}'s call and message activity from the past week:\n\n${material}`
  );
}
