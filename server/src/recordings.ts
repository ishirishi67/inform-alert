// Stores uploaded call recordings. When a database is configured (DATABASE_URL),
// recordings are stored there so they survive restarts and stay playable. Without
// a database, they fall back to the OS temp dir (demo-grade, wiped on restart).
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { dbEnabled, dbGetRecording, dbSaveRecording } from "./db.js";

const dir = join(tmpdir(), "informalert-uploads");
mkdirSync(dir, { recursive: true });

const meta = new Map<string, { mime: string }>();
const order: string[] = [];
const MAX_KEPT = 20; // bound disk use when falling back to local files

export async function saveRecording(
  id: string,
  buffer: Buffer,
  mime: string
): Promise<void> {
  if (dbEnabled) {
    await dbSaveRecording(id, buffer, mime);
    return;
  }
  writeFileSync(join(dir, id), buffer);
  meta.set(id, { mime });
  order.push(id);
  while (order.length > MAX_KEPT) {
    const old = order.shift();
    if (old) {
      try {
        rmSync(join(dir, old));
      } catch {
        /* already gone */
      }
      meta.delete(old);
    }
  }
}

// Whole-file read — used both to serve playback (with range support) and to hand
// the recording to the transcription service.
export async function getRecordingBuffer(
  id: string
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (dbEnabled) return dbGetRecording(id);
  const path = join(dir, id);
  if (!meta.has(id) || !existsSync(path)) return null;
  return { buffer: readFileSync(path), mime: meta.get(id)!.mime };
}
