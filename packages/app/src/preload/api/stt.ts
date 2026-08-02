/**
 * `window.piBuddy.stt` —— 语音转写。
 *
 * 入参恰好三个字段 `{endpointId, audio, mimeType}`（CT-07）：地址、模型、
 * 密钥三样全部由主进程按 endpointId 查出来。收敛前渲染进程同时交出
 * baseUrl 与密钥，等价于可以把 Bearer token 定向送到任意主机
 * （`http://169.254.169.254/...` 照发不误）。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { SttTranscribeRequest, SttTranscribeResult } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const stt = {
  transcribe: (request: SttTranscribeRequest) =>
    invoke<SttTranscribeResult>(CHANNELS.sttTranscribe, request),
};
