// 语音输入：MediaRecorder 录音，交给主进程调用 OpenAI 兼容 STT 端点转写

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === "recording";
  }

  async start(): Promise<void> {
    if (this.recording) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  /** 停止录音并返回音频数据 */
  async stop(): Promise<{ audio: ArrayBuffer; mimeType: string }> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("未在录音");
    const mimeType = recorder.mimeType || "audio/webm";
    const done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.stream = null;
    const blob = new Blob(this.chunks, { type: mimeType });
    return { audio: await blob.arrayBuffer(), mimeType };
  }

  cancel(): void {
    try {
      this.recorder?.stop();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
  }
}
