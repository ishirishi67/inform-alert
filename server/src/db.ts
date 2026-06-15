// Optional PostgreSQL persistence. When DATABASE_URL is set (e.g. a free Neon or
// Supabase database), calls, messages, recordings, transcripts, summaries, and
// weekly to-dos are stored durably and reloaded on boot — nothing vanishes on a
// restart. When DATABASE_URL is absent, everything falls back to in-memory (the
// app still works; data just resets on restart). Hosted Postgres requires SSL.
import pg from "pg";
import type { Call, Message, WeeklyTodo } from "./types.js";

// node-postgres doesn't support `channel_binding=require` — strip it (and tidy a
// resulting leading "?&") so a Neon/Supabase pooled URL connects cleanly.
const raw = process.env.DATABASE_URL;
const url = raw
  ? raw.replace(/[?&]channel_binding=require/gi, "").replace(/\?&/, "?")
  : undefined;

export const dbEnabled = !!url;
const pool = url
  ? new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

// True only once the connection succeeded and tables exist. Recording storage and
// the /api/health diagnostic key off this, NOT off "a URL was configured".
let ready = false;
export const isDbReady = () => ready;

export async function initDb(): Promise<void> {
  if (!pool) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS calls (
       id text PRIMARY KEY, caller_id text, callee_id text, type text,
       status text, started_at bigint, ended_at bigint)`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS messages (
       id text PRIMARY KEY, thread_id text, sender_id text, body text, kind text,
       media_url text, summary text, transcript text, created_at bigint)`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS recordings (
       id text PRIMARY KEY, mime text, data bytea, created_at bigint)`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS todos (
       id text PRIMARY KEY, user_id text, generated_at bigint, week_start bigint, content text)`
  );
  ready = true;
}

export async function loadAll(): Promise<{
  calls: Call[];
  messages: Message[];
  todos: WeeklyTodo[];
}> {
  if (!pool) return { calls: [], messages: [], todos: [] };
  const [c, m, t] = await Promise.all([
    pool.query("SELECT * FROM calls ORDER BY started_at ASC"),
    pool.query("SELECT * FROM messages ORDER BY created_at ASC"),
    pool.query("SELECT * FROM todos ORDER BY generated_at ASC"),
  ]);
  return {
    calls: c.rows.map((r) => ({
      id: r.id,
      callerId: r.caller_id,
      calleeId: r.callee_id,
      type: r.type,
      status: r.status,
      startedAt: Number(r.started_at),
      endedAt: r.ended_at != null ? Number(r.ended_at) : undefined,
    })),
    messages: m.rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      senderId: r.sender_id,
      body: r.body,
      kind: r.kind,
      mediaUrl: r.media_url ?? undefined,
      summary: r.summary ?? undefined,
      transcript: r.transcript ?? undefined,
      createdAt: Number(r.created_at),
    })),
    todos: t.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      generatedAt: Number(r.generated_at),
      weekStart: Number(r.week_start),
      content: r.content,
    })),
  };
}

const warn = (label: string) => (e: Error) =>
  console.error(`[db] ${label} failed:`, e.message);

export function persistCall(c: Call): void {
  if (!pool) return;
  pool
    .query(
      `INSERT INTO calls (id,caller_id,callee_id,type,status,started_at,ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET status=$5, ended_at=$7`,
      [c.id, c.callerId, c.calleeId, c.type, c.status, c.startedAt, c.endedAt ?? null]
    )
    .catch(warn("persistCall"));
}

export function persistMessage(m: Message): void {
  if (!pool) return;
  pool
    .query(
      `INSERT INTO messages (id,thread_id,sender_id,body,kind,media_url,summary,transcript,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET summary=$7, transcript=$8`,
      [
        m.id,
        m.threadId,
        m.senderId,
        m.body,
        m.kind,
        m.mediaUrl ?? null,
        m.summary ?? null,
        m.transcript ?? null,
        m.createdAt,
      ]
    )
    .catch(warn("persistMessage"));
}

export function persistTodo(t: WeeklyTodo): void {
  if (!pool) return;
  pool
    .query(
      `INSERT INTO todos (id,user_id,generated_at,week_start,content) VALUES ($1,$2,$3,$4,$5)`,
      [t.id, t.userId, t.generatedAt, t.weekStart, t.content]
    )
    .catch(warn("persistTodo"));
}

// --- Recordings stored as bytes (durable + playable across restarts) ---------
export async function dbSaveRecording(
  id: string,
  buffer: Buffer,
  mime: string
): Promise<void> {
  if (!pool) return;
  await pool.query(
    "INSERT INTO recordings (id,mime,data,created_at) VALUES ($1,$2,$3,$4)",
    [id, mime, buffer, Date.now()]
  );
  // Keep only the most recent 30 to bound free-tier storage.
  await pool
    .query(
      "DELETE FROM recordings WHERE id NOT IN (SELECT id FROM recordings ORDER BY created_at DESC LIMIT 30)"
    )
    .catch(warn("prune recordings"));
}

export async function dbGetRecording(
  id: string
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!pool) return null;
  const r = await pool.query("SELECT mime, data FROM recordings WHERE id=$1", [id]);
  if (!r.rows.length) return null;
  return { buffer: r.rows[0].data as Buffer, mime: r.rows[0].mime as string };
}
