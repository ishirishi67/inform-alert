// Records a call entirely in the browser (no server storage — the file is saved
// to the recorder's own device). Audio from both people is mixed together; for a
// video call, both faces are composited onto a canvas (remote large, self small)
// so the recording shows the whole conversation. Output is a WebM file.
//
// Works best in Chrome/Edge/Firefox. Safari/iOS MediaRecorder support is limited.

function pickMime(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported?.(m));
}

export class CallRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioCtx: AudioContext | null = null;
  private raf = 0;
  private videos: HTMLVideoElement[] = [];

  start(local: MediaStream, remote: MediaStream, hasVideo: boolean): void {
    // --- mix both audio sources into one track ---
    this.audioCtx = new AudioContext();
    const dest = this.audioCtx.createMediaStreamDestination();
    for (const s of [local, remote]) {
      if (s.getAudioTracks().length)
        this.audioCtx.createMediaStreamSource(s).connect(dest);
    }
    const tracks: MediaStreamTrack[] = [...dest.stream.getAudioTracks()];

    // --- composite both videos onto a canvas, if this is a video call ---
    if (hasVideo) {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d")!;

      const mk = (s: MediaStream) => {
        const v = document.createElement("video");
        v.srcObject = s;
        v.muted = true;
        v.playsInline = true;
        void v.play().catch(() => {});
        this.videos.push(v);
        return v;
      };
      const remoteVid = mk(remote);
      const localVid = mk(local);

      const draw = () => {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (remoteVid.videoWidth)
          ctx.drawImage(remoteVid, 0, 0, canvas.width, canvas.height);
        if (localVid.videoWidth)
          ctx.drawImage(localVid, canvas.width - 172, canvas.height - 132, 160, 120);
        this.raf = requestAnimationFrame(draw);
      };
      draw();
      tracks.unshift(canvas.captureStream(24).getVideoTracks()[0]);
    }

    const mixed = new MediaStream(tracks);
    const mime = pickMime();
    this.rec = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(1000); // gather data each second
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec) return resolve(new Blob());
      rec.onstop = () => {
        cancelAnimationFrame(this.raf);
        this.videos.forEach((v) => (v.srcObject = null));
        this.videos = [];
        void this.audioCtx?.close();
        resolve(new Blob(this.chunks, { type: rec.mimeType || "video/webm" }));
      };
      rec.stop();
    });
  }
}
