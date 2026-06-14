// A self-contained phone ring generated with the Web Audio API (no audio file to
// bundle). Used both for the incoming-call ring (callee) and the ringback the
// caller hears while waiting. Plays a two-tone warble burst every few seconds.
//
// Autoplay note: browsers only allow audio after a user gesture. Both callers and
// callees have clicked (to log in / to call), so resuming the context works.
export class Ringtone {
  private ctx: AudioContext | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private safety: ReturnType<typeof setTimeout> | null = null;
  private playing = false;

  private ensureCtx(): AudioContext {
    this.ctx =
      this.ctx ??
      new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext)();
    return this.ctx;
  }

  // Call this from a real user gesture (e.g. the login click) to "unlock" audio
  // so the ring can later play when a call arrives over the network — at which
  // point there is no gesture and the browser would otherwise block sound.
  async unlock(): Promise<void> {
    try {
      const ctx = this.ensureCtx();
      if (ctx.state === "suspended") await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0; // silent — just activates the context
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.01);
    } catch {
      /* best effort */
    }
  }

  async start(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      const ctx = this.ensureCtx();
      if (ctx.state === "suspended") await ctx.resume();
    } catch {
      this.playing = false;
      return;
    }
    this.ringOnce();
    this.interval = setInterval(() => this.ringOnce(), 3000);
    // Safety net: never ring longer than 60s, whatever else goes wrong.
    this.safety = setTimeout(() => this.stop(), 60_000);
  }

  private ringOnce(): void {
    const ctx = this.ctx;
    if (!ctx || !this.playing) return;
    const now = ctx.currentTime;
    // 4 alternating beeps (~1s) — the classic warble.
    [440, 480, 440, 480].forEach((freq, i) => {
      const t0 = now + i * 0.25;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    });
  }

  stop(): void {
    this.playing = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.safety) {
      clearTimeout(this.safety);
      this.safety = null;
    }
  }
}
