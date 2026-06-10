import type { Message } from "../types/events.js";
import { logger } from "./logger.js";

const log = logger.child({ component: "summarizer" });

/** A summarizer condenses a list of conversation messages into a short
 *  natural-language abstract. Used by RealtimeSession's auto-compaction
 *  path to bound the in-memory history without losing the gist of older
 *  turns. Implementations can call out to any LLM endpoint; the SM treats
 *  the summarizer as backend-agnostic. */
export interface Summarizer {
  summarize(messages: Message[]): Promise<string>;
}

interface StepfunChatSummarizerOptions {
  apiKey: string;
  /** Stepfun chat-completions model id. Default `step-2-mini` (cheap text
   *  model). Override if your key has access to another. */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Calls stepfun's OpenAI-compatible `/v1/chat/completions` endpoint with
 *  a text-only model. Cheap, no audio, runs out-of-band from the realtime
 *  ws so the user's current conversation isn't affected. */
export class StepfunChatSummarizer implements Summarizer {
  constructor(private readonly opts: StepfunChatSummarizerOptions) {}

  async summarize(messages: Message[]): Promise<string> {
    if (messages.length === 0) return "";
    const transcript = renderForSummarizer(messages);
    return this.callLLM({
      system:
        "你是一个对话摘要工具。把下面一段语音助手与用户的对话压缩成不超过 200 字的中文摘要。要求：\n" +
        "- 客观、第三人称转述, 不要加自己的意见\n" +
        "- 保留对话中已经明确的事实 (用户偏好、工具结果等)\n" +
        "- 如果对话中助手出现过事实错误又被纠正, 摘要只保留最终正确版本, 不复述错误\n" +
        "- 不要使用 markdown 标题或列表, 直接一段连贯文本",
      user: transcript,
      maxTokens: 400,
    });
  }

  /** Public helper for capabilities that want an LLM-generated completion
   *  blurb (used by coding_agent's completionAnnouncement). Stays outside
   *  the Summarizer interface so the SDK's compaction path doesn't depend
   *  on capability-specific shapes. */
  async chat(args: {
    system: string;
    user: string;
    maxTokens: number;
    timeoutMs?: number;
  }): Promise<string> {
    return this.callLLM(args);
  }

  private async callLLM(args: {
    system: string;
    user: string;
    maxTokens: number;
    timeoutMs?: number;
  }): Promise<string> {
    const baseUrl = this.opts.baseUrl ?? "https://api.stepfun.com";
    const model = this.opts.model ?? "step-2-mini";
    const body = {
      model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      temperature: 0.3,
      max_tokens: args.maxTokens,
    };
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        args.timeoutMs ?? this.opts.timeoutMs ?? 20_000,
      ),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`summarizer HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    const j = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = j.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error(`summarizer returned empty content`);
    log.debug({ chars: out.length, model }, "summary produced");
    return out;
  }
}

/** Flatten Message[] to a single text transcript the summarizer can read.
 *  Audio messages use their transcript; tool calls render as a one-line
 *  marker so the summarizer knows tools were used but won't quote raw JSON. */
function renderForSummarizer(msgs: Message[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const tag =
      m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role;
    for (const p of m.content) {
      switch (p.type) {
        case "text":
          lines.push(`${tag}: ${p.text}`);
          break;
        case "input_audio":
        case "audio":
          if (p.transcript) lines.push(`${tag}: ${p.transcript}`);
          break;
        case "function_call":
          lines.push(`${tag}: [调用工具 ${p.name}]`);
          break;
        case "function_call_output":
          lines.push(`(工具结果: ${p.output.slice(0, 120)})`);
          break;
      }
    }
  }
  return lines.join("\n");
}
