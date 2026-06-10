/** @jsxImportSource @opentui/react */

import React from "react";

interface VoiceInputWidgetProps {
  mode: "ptt" | "duplex";
  isRecording: boolean;
  isPlaying: boolean;
  onToggleMode: () => void;
  onCancel: () => void;
  onExitVoice: () => void;
}

export function VoiceInputWidget(props: VoiceInputWidgetProps): JSX.Element {
  const { mode, isRecording, isPlaying } = props;

  const modeLabel = mode === "ptt" ? "PTT" : "Duplex";
  const statusText = isRecording
    ? "Recording..."
    : isPlaying
      ? "Playing..."
      : "Ready";

  const waveform = isRecording ? " ▁▂▃▅▃▂▁ " : " ─────── ";
  const hint = mode === "ptt" ? "hold to talk" : "toggle mute";

  return (
    <text>{`🎤${waveform} [${modeLabel}] ${statusText}  |  Space: ${hint}  T: switch mode  Esc: exit voice  C: cancel`}</text>
  ) as JSX.Element;
}
