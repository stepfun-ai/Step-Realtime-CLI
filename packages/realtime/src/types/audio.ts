export interface AudioCaptureHandle {
  readonly stream: AsyncIterable<Buffer>;
  stop(): void;
}

export interface AudioPlaybackHandle {
  write(pcm: Buffer): void;
  flush(): void;
  stop(): void;
}

export interface AudioProbeResult {
  captureAvailable: boolean;
  playbackAvailable: boolean;
  captureDevice?: string;
  playbackDevice?: string;
}

export interface AudioDriver {
  startCapture(): AudioCaptureHandle;
  startPlayback(): AudioPlaybackHandle;
  probe(): Promise<AudioProbeResult>;
  dispose(): Promise<void>;
}
