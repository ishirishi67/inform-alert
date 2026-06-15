// Turns a call recording into a short summary in two steps:
//   1. Transcribe the audio with Whisper (via Groq's free OpenAI-compatible API).
//      Claude can't transcribe audio, so this step needs a speech-to-text service.
//   2. Summarize the transcript with Claude (claude-opus-4-8).
// Both read API keys from env vars; neither client is constructed until used, so
// the server still boots fine when the keys aren't set (the feature just errors).
import Anthropic from "@anthropic-ai/sdk";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

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
  form.append("model", "whisper-large-v3");

  const res = await fetch(GROQ_URL, {
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

export async function summarize(transcript: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new Error("Summarizing isn't configured yet (ANTHROPIC_API_KEY missing).");

  const anthropic = new Anthropic({ apiKey });
  const msg = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system:
      "You summarize a recorded family phone or video call from its transcript. " +
      "Reply with a warm 2-3 sentence overview, then a few short bullet points covering " +
      "what was discussed, any decisions made, and any follow-ups or things to remember. " +
      "Keep it friendly and concise. Do not invent details not in the transcript.",
    messages: [{ role: "user", content: `Transcript of the call:\n\n${transcript}` }],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
