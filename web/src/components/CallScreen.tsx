import { useEffect, useRef, useState } from "react";
import type { CallType, User } from "../types";

// Live call UI: remote video fills the screen, local video is a small overlay,
// with mute / camera / end controls. For voice calls (or before the remote
// stream connects) we show the peer's avatar instead of a black video box.
export function CallScreen({
  peer,
  callType,
  localStream,
  remoteStream,
  connectionState,
  onEnd,
}: {
  peer: User;
  callType: CallType;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  onEnd: () => void;
}) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(callType === "voice");

  useEffect(() => {
    if (localRef.current) localRef.current.srcObject = localStream;
  }, [localStream]);
  useEffect(() => {
    if (remoteRef.current) remoteRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  const toggleMute = () => {
    const next = !muted;
    localStream?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  };
  const toggleCam = () => {
    const next = !camOff;
    localStream?.getVideoTracks().forEach((t) => (t.enabled = !next));
    setCamOff(next);
  };

  const connected = connectionState === "connected";
  const status =
    connectionState === "failed"
      ? "Connection failed"
      : connectionState === "disconnected"
        ? "Reconnecting…"
        : connected
          ? "Connected"
          : "Connecting…";

  const showAvatar = callType === "voice" || !connected;

  return (
    <div className="callscreen">
      <div className="remote-wrap">
        <video ref={remoteRef} autoPlay playsInline className="remote-video" />
        {showAvatar && (
          <div className="call-overlay">
            <div className="avatar-big">{peer.avatar}</div>
            <h2>{peer.name}</h2>
            <p className="muted">{status}</p>
          </div>
        )}
      </div>

      {callType === "video" && (
        <video
          ref={localRef}
          autoPlay
          playsInline
          muted
          className="local-video"
          style={{ visibility: camOff ? "hidden" : "visible" }}
        />
      )}

      <div className="call-controls">
        <button title={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
          {muted ? "🔇" : "🎤"}
        </button>
        {callType === "video" && (
          <button title={camOff ? "Camera on" : "Camera off"} onClick={toggleCam}>
            {camOff ? "📷̶" : "📷"}
          </button>
        )}
        <button className="busy" onClick={onEnd}>
          End
        </button>
      </div>
    </div>
  );
}
