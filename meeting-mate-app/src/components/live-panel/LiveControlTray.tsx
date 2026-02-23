"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  MonitorUp,
  MonitorOff,
  Volume2,
  Send,
} from "lucide-react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { AudioRecorder } from "../../lib/audio-recorder";
import type { LiveMode } from "../../types/live-api";

interface LiveControlTrayProps {
  mode: LiveMode;
  onSendText?: (text: string) => void;
  onTabAudioStream?: (stream: MediaStream | null) => void;
}

export default function LiveControlTray({
  mode,
  onSendText,
  onTabAudioStream,
}: LiveControlTrayProps) {
  const { client, connected, connect, disconnect, volume } =
    useLiveAPIContext();

  const [muted, setMuted] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [inVolume, setInVolume] = useState(0);
  const [tabAudioActive, setTabAudioActive] = useState(false);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tabStreamRef = useRef<MediaStream | null>(null);

  // Microphone audio → Gemini
  useEffect(() => {
    const onData = (base64: string) => {
      client.sendRealtimeInput([
        { mimeType: "audio/pcm;rate=16000", data: base64 },
      ]);
    };

    if (connected && !muted) {
      audioRecorder.on("data", onData).on("volume", setInVolume).start();
    } else {
      audioRecorder.stop();
    }

    return () => {
      audioRecorder.off("data", onData).off("volume", setInVolume);
    };
  }, [connected, client, muted, audioRecorder]);

  const stopTabAudio = useCallback(() => {
    tabStreamRef.current?.getTracks().forEach((t) => t.stop());
    tabStreamRef.current = null;
    setTabAudioActive(false);
    onTabAudioStream?.(null);
  }, [onTabAudioStream]);

  // Tab audio capture → send as video frames with audio
  const startTabAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      tabStreamRef.current = stream;
      setTabAudioActive(true);
      onTabAudioStream?.(stream);

      // Tab audio → PCM16 → Gemini
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        const source = audioCtx.createMediaStreamSource(
          new MediaStream(audioTracks)
        );
        const processor = audioCtx.createScriptProcessor(2048, 1, 1);

        processor.onaudioprocess = (e) => {
          if (!connected) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = float32[i] * 32768;
          }
          const bytes = new Uint8Array(int16.buffer);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          client.sendRealtimeInput([
            { mimeType: "audio/pcm;rate=16000", data: base64 },
          ]);
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
      }

      // Video frames from tab → Gemini (low fps)
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0 && videoRef.current && canvasRef.current) {
        const video = videoRef.current;
        video.srcObject = new MediaStream(videoTracks);
        await video.play();

        const sendFrame = () => {
          if (!connected || !tabStreamRef.current) return;
          const canvas = canvasRef.current;
          if (!canvas || !video) return;

          canvas.width = video.videoWidth * 0.25;
          canvas.height = video.videoHeight * 0.25;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const base64 = canvas.toDataURL("image/jpeg", 0.5);
          const data = base64.slice(base64.indexOf(",") + 1);
          client.sendRealtimeInput([{ mimeType: "image/jpeg", data }]);

          setTimeout(sendFrame, 2000); // 0.5 FPS
        };
        sendFrame();
      }

      // Handle stream end
      stream.getTracks().forEach((track) => {
        track.onended = () => stopTabAudio();
      });
    } catch (err) {
      console.error("Tab audio capture failed:", err);
    }
  }, [connected, client, onTabAudioStream, stopTabAudio]);

  const handleSendText = () => {
    if (!textInput.trim() || !connected) return;
    client.send([{ text: textInput }]);
    onSendText?.(textInput);
    setTextInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendText();
    }
  };

  // Volume indicator style
  const volumeStyle = (vol: number) => ({
    width: `${Math.min(vol * 300, 100)}%`,
  });

  return (
    <div className="flex flex-col gap-2 p-3 border-t border-gray-200 dark:border-gray-700">
      {/* Hidden elements for tab capture */}
      <video ref={videoRef} className="hidden" playsInline />
      <canvas ref={canvasRef} className="hidden" />

      {/* Volume indicators */}
      {connected && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>入力:</span>
          <div className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
            <div
              className="h-full bg-green-500 transition-all duration-75"
              style={volumeStyle(inVolume)}
            />
          </div>
          <span>出力:</span>
          <div className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-75"
              style={volumeStyle(volume)}
            />
          </div>
        </div>
      )}

      {/* Text input */}
      {connected && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="テキストで質問..."
            className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleSendText}
            disabled={!textInput.trim()}
            className="p-1.5 rounded-lg bg-blue-500 text-white disabled:opacity-40 hover:bg-blue-600 transition"
          >
            <Send size={16} />
          </button>
        </div>
      )}

      {/* Control buttons */}
      <div className="flex items-center justify-center gap-3">
        {/* Connect/Disconnect */}
        <button
          onClick={connected ? disconnect : connect}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium transition ${
            connected
              ? "bg-red-500 hover:bg-red-600 text-white"
              : "bg-green-500 hover:bg-green-600 text-white"
          }`}
        >
          {connected ? (
            <>
              <PhoneOff size={16} />
              切断
            </>
          ) : (
            <>
              <Phone size={16} />
              接続
            </>
          )}
        </button>

        {/* Mic toggle */}
        {connected && (
          <button
            onClick={() => setMuted(!muted)}
            className={`p-2 rounded-full transition ${
              muted
                ? "bg-red-100 text-red-500 dark:bg-red-900/30"
                : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
            }`}
            title={muted ? "マイクON" : "マイクOFF"}
          >
            {muted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
        )}

        {/* Tab audio capture */}
        {connected && (
          <button
            onClick={tabAudioActive ? stopTabAudio : startTabAudio}
            className={`p-2 rounded-full transition ${
              tabAudioActive
                ? "bg-purple-100 text-purple-600 dark:bg-purple-900/30"
                : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
            }`}
            title={
              tabAudioActive ? "タブ音声停止" : "タブ音声キャプチャ"
            }
          >
            {tabAudioActive ? (
              <MonitorOff size={18} />
            ) : (
              <MonitorUp size={18} />
            )}
          </button>
        )}

        {/* Output volume indicator */}
        {connected && (
          <div className="flex items-center gap-1 text-gray-500">
            <Volume2 size={16} />
          </div>
        )}

        {/* Mode indicator */}
        <span
          className={`text-xs px-2 py-1 rounded-full ${
            mode === "active"
              ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
              : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
          }`}
        >
          {mode === "active" ? "Active" : "Passive"}
        </span>
      </div>
    </div>
  );
}
