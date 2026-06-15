// Stores uploaded call recordings on disk so the other participant can fetch and
// play them. This is demo-grade: the temp directory is ephemeral (wiped on
// restart/redeploy) and only the most recent few recordings are kept. For
// production, use durable object storage (S3/GCS/Cloudinary) instead.
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  createReadStream,
  existsSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = join(tmpdir(), "informalert-uploads");
mkdirSync(dir, { recursive: true });

const meta = new Map<string, { mime: string }>();
const order: string[] = [];
const MAX_KEPT = 20; // bound disk use on the free tier

export function saveRecording(id: string, buffer: Buffer, mime: string): void {
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

export function getRecording(id: string) {
  const path = join(dir, id);
  if (!meta.has(id) || !existsSync(path)) return null;
  return { stream: createReadStream(path), mime: meta.get(id)!.mime };
}

// Whole-file read, for handing the recording to the transcription service.
export function getRecordingBuffer(id: string) {
  const path = join(dir, id);
  if (!meta.has(id) || !existsSync(path)) return null;
  return { buffer: readFileSync(path), mime: meta.get(id)!.mime };
}
