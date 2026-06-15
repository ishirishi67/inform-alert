// One peer-to-peer call. Media (audio/video) flows directly browser-to-browser
// via WebRTC; the app server is used only to exchange the SDP offer/answer and
// ICE candidates (see ws relay). Public STUN handles NAT traversal for most home
// networks. NOTE: very restrictive networks (symmetric/corporate NAT) also need a
// TURN relay — add one here later if calls fail to connect on some networks.
// STUN finds a direct path; TURN relays media when a direct path is impossible
// (different networks, strict NAT, mobile data ↔ wifi). Without TURN, cross-
// network calls often connect briefly then fail. These are free public TURN
// relays — fine for a family-scale demo. For production, get your own
// credentials (e.g. Metered's free 50GB/mo tier) and swap them in here.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

type SignalSend = (type: string, payload: unknown) => void;

export class PeerCall {
  readonly pc: RTCPeerConnection;
  private localStream: MediaStream | null = null;
  private remoteStream = new MediaStream();
  private remoteReady = false;
  private pendingIce: RTCIceCandidateInit[] = [];

  constructor(
    private send: SignalSend,
    private peerId: string,
    private callId: string,
    private onRemoteStream: (s: MediaStream) => void,
    private onStateChange: (s: RTCPeerConnectionState) => void
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (e) => {
      if (e.candidate)
        this.send("webrtc:ice", {
          callId: this.callId,
          toUserId: this.peerId,
          candidate: e.candidate.toJSON(),
        });
    };

    this.pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach((t) => this.remoteStream.addTrack(t));
      this.onRemoteStream(this.remoteStream);
    };

    this.pc.onconnectionstatechange = () =>
      this.onStateChange(this.pc.connectionState);
  }

  // Capture mic (+ camera for video calls) and add the tracks to the connection.
  async startLocalMedia(video: boolean): Promise<MediaStream> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video,
    });
    this.localStream
      .getTracks()
      .forEach((t) => this.pc.addTrack(t, this.localStream!));
    return this.localStream;
  }

  // Caller side: create and send the offer (after the callee has accepted).
  async createOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.send("webrtc:offer", {
      callId: this.callId,
      toUserId: this.peerId,
      sdp: offer,
    });
  }

  // Callee side: accept the offer and answer.
  async handleOffer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteReady = true;
    await this.flushIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.send("webrtc:answer", {
      callId: this.callId,
      toUserId: this.peerId,
      sdp: answer,
    });
  }

  async handleAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteReady = true;
    await this.flushIce();
  }

  // ICE can arrive before the remote description is set — buffer until ready.
  async handleIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteReady) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      /* ignore late/duplicate candidates */
    }
  }

  private async flushIce(): Promise<void> {
    for (const c of this.pendingIce) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        /* ignore */
      }
    }
    this.pendingIce = [];
  }

  close(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.remoteStream.getTracks().forEach((t) => t.stop());
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
