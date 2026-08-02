#!/usr/bin/env node
/**
 * fake Pi RPC 进程 —— 在不接真实 Provider 的前提下驱动 PiRpcClient 的回归测试夹具。
 *
 * 用法：
 *   node tools/fake-pi/fake-pi.mjs --mode rpc --scenario <name> [--cancel]
 *
 * 协议以 pi 自身 docs/rpc.md 为准：
 *   - stdin/stdout 均为严格 JSONL，**仅** LF (\n) 是记录分隔符；
 *   - 输入允许 \r\n，读侧剥掉尾部 \r；
 *   - 禁止使用 Node 内置的通用行读取模块 —— 它还会按 U+2028 / U+2029 分行，
 *     而这两个码位在 JSON 字符串里是合法内容。这里手写 indexOf("\n") 分帧循环。
 */

import {
  SCENARIOS,
  CRASH_EXIT_CODE,
  EXTENSION_UI_REQUEST_ID,
  MALFORMED_LINE,
  NORMAL_TEXT,
  NORMAL_TEXT_DELTAS,
  OVERSIZED_BYTES,
  STALE_DELAY_MS,
  normalEventSequence,
} from "./scenarios.mjs";

// ---------- argv ----------

function readFlag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

const scenario = readFlag("--scenario", "normal");
const cancelled = process.argv.includes("--cancel");

if (!SCENARIOS.includes(scenario)) {
  process.stderr.write(`fake-pi: unknown scenario ${scenario}\n`);
  process.exit(2);
}

// ---------- 输出 ----------

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(command, extra = {}) {
  emit({
    type: "response",
    ...(command.id !== undefined ? { id: command.id } : {}),
    command: command.type,
    success: true,
    ...extra,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 启动期行为 ----------

if (scenario === "exit-immediately") {
  // 模拟 pi 可执行文件存在但启动即死（配置错误 / 端口占用 / 依赖缺失）。
  process.exit(0);
}

if (scenario === "stderr-noise") {
  process.stderr.write("fake-pi: warning: noisy diagnostic on stderr\n");
  process.stderr.write("fake-pi: warning: second noisy line\n");
}

// ---------- stdin 严格 LF 分帧 ----------

let buffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) break;
    let line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0) void handleLine(line);
  }
});

process.stdin.on("end", () => {
  if (buffer.length > 0) {
    const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    buffer = "";
    void handleLine(line);
  }
  // 客户端关闭 stdin 即视为收工。
  setTimeout(() => process.exit(0), 10);
});

// ---------- 命令分发 ----------

/** crash-mid-stream 进入濒死状态后不再应答任何命令。 */
let crashing = false;

async function handleLine(line) {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    process.stderr.write(`fake-pi: dropped unparseable input line\n`);
    return;
  }

  // timeout 场景：吞掉所有命令，永不回响应，用于验证客户端的超时/挂起处理。
  if (scenario === "timeout") return;
  // 濒死进程不再应答：在途请求必须由客户端的 exit 处理器 reject。
  if (crashing) return;

  if (command.type === "extension_ui_response") {
    emit({ type: "agent_settled" });
    return;
  }

  switch (command.type) {
    case "new_session":
    case "switch_session":
      respond(command, { data: { cancelled } });
      return;
    case "get_state":
      respond(command, {
        data: { isStreaming: false, model: { provider: "fake", id: "fake-1" } },
      });
      return;
    case "get_messages":
      respond(command, { data: { messages: [] } });
      return;
    case "abort":
      respond(command);
      await afterAbort();
      return;
    case "prompt":
    case "steer":
    case "follow_up":
      await afterPrompt(command);
      return;
    default:
      respond(command);
      return;
  }
}

// ---------- 场景行为 ----------

async function afterPrompt(command) {
  switch (scenario) {
    case "malformed-json": {
      // 坏行先于响应写出：客户端必须跳过它并仍然把随后的 response 关联上。
      process.stdout.write(MALFORMED_LINE + "\n");
      respond(command);
      process.stdout.write("这不是 JSON，只是一行噪声\n");
      emit({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: NORMAL_TEXT,
          partial: {},
        },
      });
      emit({ type: "agent_settled" });
      return;
    }

    case "crash-mid-stream": {
      respond(command);
      crashing = true;
      emit({ type: "agent_start" });
      for (const delta of NORMAL_TEXT_DELTAS.slice(0, 2)) {
        emit({
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta,
            partial: {},
          },
        });
      }
      // 流到一半进程死掉：客户端应触发 exit 并 reject 所有在途请求。
      await sleep(20);
      process.exit(CRASH_EXIT_CODE);
      return;
    }

    case "oversized-line": {
      respond(command);
      const filler = "x".repeat(OVERSIZED_BYTES);
      emit({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: filler,
          partial: {},
        },
      });
      emit({ type: "agent_settled" });
      return;
    }

    case "extension-ui": {
      respond(command);
      emit({
        type: "extension_ui_request",
        id: EXTENSION_UI_REQUEST_ID,
        method: "select",
        title: "Allow dangerous command?",
        options: ["Allow", "Block"],
        timeout: 10000,
      });
      return;
    }

    case "stale-generation": {
      respond(command);
      emit({ type: "agent_start" });
      emit({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: NORMAL_TEXT_DELTAS[0],
          partial: {},
        },
      });
      return;
    }

    case "normal":
    default: {
      respond(command);
      for (const ev of normalEventSequence()) emit(ev);
      return;
    }
  }
}

async function afterAbort() {
  if (scenario !== "stale-generation") {
    emit({ type: "agent_settled" });
    return;
  }
  // 旧代际延迟事件：abort 已经回过响应，但上一代的事件迟到 300ms 才吐出来。
  // 客户端必须能把它按代际丢弃，而不是渲染到新会话里。
  await sleep(STALE_DELAY_MS);
  emit({ type: "agent_start" });
  emit({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "STALE",
      partial: {},
    },
  });
  emit({ type: "agent_settled" });
}
