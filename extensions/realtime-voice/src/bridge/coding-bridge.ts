import {
  ERR_SESSION_CORRUPT,
  ERR_SESSION_NOT_FOUND,
  query as sdkQuery,
  SdkSessionError,
} from "@step-cli/agent-sdk";
import type { QueryOptions, SDKUserMessage } from "@step-cli/agent-sdk";
import type { ChatCompletionClient } from "@step-cli/core/model-client.js";
import {
  logger,
  type RealtimeSession,
  type TaskFinalSummary,
  type TaskSnapshot,
} from "@step-cli/realtime";

const log = logger.child({ component: "coding-bridge" });

function clip(s: unknown, n = 200): string {
  const text = typeof s === "string" ? s : JSON.stringify(s);
  if (text == null) return "";
  return text.length > n ? text.slice(0, n) + `…(+${text.length - n})` : text;
}

export type CodingPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export interface CodingBridgeConfig {
  cwd: string;
  model: string;
  permissionMode: CodingPermissionMode;
  maxTurns: number;
  budgetUsd: number;
}

const CAPABILITY_ID = "coding_agent";

/** Coding-specific live progress payload stashed into the generic
 *  TaskSnapshot.progress by this bridge. The SDK treats it as opaque. */
interface CodingProgress {
  lastTool?: string;
  lastToolInput?: string;
  lastAssistantText?: string;
  toolCounts: Record<string, number>;
  filesChanged: string[];
  bashCommands: string[];
  costUsd: number;
}

/** Coding-specific result payload carried in the generic TaskFinalSummary.detail. */
interface CodingDetail {
  filesChanged: string[];
  bashCommands: string[];
  costUsd: number;
  errors: string[];
}

export class CodingBridge {
  private session: RealtimeSession;
  private config: CodingBridgeConfig;
  private client: ChatCompletionClient;
  /** Resume state owned by the capability (SDK is task-agnostic). */
  private codingSessionId?: string;

  constructor(
    session: RealtimeSession,
    config: CodingBridgeConfig,
    client: ChatCompletionClient,
  ) {
    this.session = session;
    this.config = config;
    this.client = client;
  }

  async onToolCall(args: {
    task: string;
    session: "continue" | "new";
  }): Promise<string> {
    const shouldResume =
      args.session === "continue" && this.codingSessionId != null;
    const taskId = crypto.randomUUID();
    log.info(
      {
        event: "onToolCall",
        taskId,
        sessionMode: args.session,
        shouldResume,
        priorCodingSessionId: this.codingSessionId,
        task: clip(args.task, 500),
      },
      "voice → coding_agent invoked",
    );
    this.startTask(taskId, args.task, shouldResume);
    // Return immediately: the task runs in the background. The realtime model
    // speaks a short opener on the follow-up response (driven by the registered
    // startAnnouncement), and the result is announced later via
    // completionAnnouncement. The old code blocked here on waitForTaskDone for
    // the entire task — that froze tool dispatch, so "stop" and new-task calls
    // couldn't be processed and a stale function_call_output landed minutes
    // late, corrupting the stateless backend's per-response protocol.
    return JSON.stringify({ status: "started", taskId });
  }

  private startTask(taskId: string, task: string, shouldResume: boolean): void {
    const progress: CodingProgress = {
      toolCounts: {},
      filesChanged: [],
      bashCommands: [],
      costUsd: 0,
    };

    const ac = new AbortController();
    this.session.registerTask({
      taskId,
      capabilityId: CAPABILITY_ID,
      label: task,
      abortController: ac,
      startAnnouncement: buildStartAnnouncement(taskId),
      completionAnnouncement: (summary) =>
        buildCompletionAnnouncement(taskId, summary),
      statusInstruction: (snap, elapsedSec) =>
        buildStatusInstruction(snap, elapsedSec),
      run: async (snap, emit) => {
        snap.progress = progress as unknown as Record<string, unknown>;
        // Resolve as interrupted the instant abort fires, even if the agent
        // subprocess hasn't fully torn down yet. Relying on the for-await to
        // throw on abort is not reliable (the subprocess can linger), and a
        // run() that never settles would leave currentTask stuck forever →
        // cancel appears to do nothing and no new task can be started.
        const abortPromise = new Promise<TaskFinalSummary>((resolve) => {
          const listener = () => {
            ac.signal.removeEventListener("abort", listener);
            resolve({
              status: "interrupted",
              summary: "任务已取消",
              detail: makeDetail(progress) as unknown as Record<
                string,
                unknown
              >,
            });
          };
          if (ac.signal.aborted) listener();
          else ac.signal.addEventListener("abort", listener, { once: true });
        });
        const work = this.runAgent(task, shouldResume, ac, progress, emit);
        return Promise.race([work, abortPromise]);
      },
    });
  }

  /** Drive an @step-cli/agent-sdk query to completion, translating messages
   *  into task progress. Falls back to a fresh session once if a resume fails
   *  with an SDK session error (NOT_FOUND or CORRUPT); other errors propagate
   *  to a failed summary. */
  private async runAgent(
    task: string,
    resume: boolean,
    ac: AbortController,
    progress: CodingProgress,
    emit: (progress: { kind: string; data: unknown }) => void,
  ): Promise<TaskFinalSummary> {
    try {
      return await this.runAgentOnce(task, resume, ac, progress, emit);
    } catch (err) {
      if (resume && !ac.signal.aborted && isResumeFailure(err)) {
        // Stale or corrupt sessionId → drop the resume key and retry once with
        // a fresh session. Any non-session error (network, model, tool) flows
        // through to the failed branch below.
        log.warn(
          {
            event: "resume_fallback",
            staleSessionId: this.codingSessionId,
            errCode: (err as SdkSessionError).code,
            errMsg: clip(String(err), 300),
          },
          "SDK resume failed → retrying with fresh session",
        );
        this.codingSessionId = undefined;
        return await this.runAgentOnce(task, false, ac, progress, emit);
      }
      if (ac.signal.aborted) {
        log.info(
          { event: "aborted", reason: clip(String(err), 200) },
          "coding task aborted",
        );
        return {
          status: "interrupted",
          summary: "任务已取消",
          detail: makeDetail(progress) as unknown as Record<string, unknown>,
        };
      }
      log.error(
        {
          event: "failed",
          err: String(err),
          stack: err instanceof Error ? err.stack : undefined,
          progress,
        },
        "coding task failed",
      );
      return {
        status: "failed",
        summary: String(err).slice(0, 500),
        detail: {
          ...makeDetail(progress),
          errors: [String(err).slice(0, 500)],
        } as unknown as Record<string, unknown>,
      };
    }
  }

  private async runAgentOnce(
    task: string,
    resume: boolean,
    ac: AbortController,
    progress: CodingProgress,
    emit: (progress: { kind: string; data: unknown }) => void,
  ): Promise<TaskFinalSummary> {
    const opts: QueryOptions = {
      client: this.client,
      cwd: this.config.cwd,
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.budgetUsd,
      abortController: ac,
      tools: { type: "preset", preset: "stepfun_code" },
    };
    if (resume && this.codingSessionId) {
      opts.resume = this.codingSessionId;
    }

    log.info(
      {
        event: "sdkQuery_start",
        task: clip(task, 500),
        resume,
        resumeId: opts.resume,
        cwd: opts.cwd,
        model: opts.model,
        permissionMode: opts.permissionMode,
        maxTurns: opts.maxTurns,
        budgetUsd: opts.maxBudgetUsd,
      },
      "calling agent-sdk query()",
    );
    const sdkStartedAt = Date.now();

    const q = sdkQuery({
      prompt: singleUserMessageStream(task),
      options: opts,
    });

    let resultText = "";
    let costUsd = 0;
    let msgCount = 0;

    for await (const msg of q) {
      msgCount++;
      logSdkMessage(msg, msgCount);

      // Capability-owned translation: SDK messages → generic
      // task.progress events (the SDK no longer knows these shapes).
      for (const p of sdkMessageToProgress(msg)) emit(p);

      if (msg.type === "assistant") {
        const blocks = (msg.message?.content ?? []) as Array<
          Record<string, unknown>
        >;
        for (const block of blocks) {
          if (block.type === "tool_use") {
            const tool = String(block.name ?? "");
            progress.toolCounts[tool] = (progress.toolCounts[tool] ?? 0) + 1;
            progress.lastTool = tool;
            progress.lastToolInput = JSON.stringify(block.input).slice(0, 100);
          } else if (block.type === "text") {
            progress.lastAssistantText = String(block.text ?? "");
          }
        }
      } else if (msg.type === "result") {
        resultText = String((msg as { result?: string }).result ?? "");
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) this.codingSessionId = sid;
        costUsd = Number(
          (msg as { total_cost_usd?: number }).total_cost_usd ?? 0,
        );
        progress.costUsd = costUsd;
      }
    }

    log.info(
      {
        event: "sdkQuery_end",
        msgCount,
        elapsedMs: Date.now() - sdkStartedAt,
        sessionId: this.codingSessionId,
        costUsd,
        resultLen: resultText.length,
        resultHead: clip(resultText, 400),
        toolCounts: progress.toolCounts,
        filesChangedCount: progress.filesChanged.length,
      },
      "agent-sdk query() iteration completed",
    );

    return {
      status: "done",
      summary: resultText,
      detail: makeDetail(progress, costUsd) as unknown as Record<
        string,
        unknown
      >,
    };
  }
}

/** Per-message debug trace of agent-sdk output. One line per SDK message so
 *  `tail -f voice.log` shows the full assistant ↔ tool loop in real time. */
function logSdkMessage(msg: unknown, n: number): void {
  const m = msg as Record<string, unknown>;
  const type = String(m.type ?? "?");
  try {
    switch (type) {
      case "assistant": {
        const blocks = ((m.message as Record<string, unknown>)?.content ??
          []) as Array<Record<string, unknown>>;
        for (const block of blocks) {
          if (block.type === "tool_use") {
            log.debug(
              {
                event: "sdk_msg",
                n,
                type,
                block: "tool_use",
                tool: block.name,
                toolUseId: block.id,
                input: clip(block.input, 400),
              },
              "← assistant.tool_use",
            );
          } else if (block.type === "text") {
            const text = String(block.text ?? "");
            if (text) {
              log.debug(
                {
                  event: "sdk_msg",
                  n,
                  type,
                  block: "text",
                  text: clip(text, 400),
                },
                "← assistant.text",
              );
            }
          } else {
            log.debug(
              { event: "sdk_msg", n, type, block: String(block.type ?? "?") },
              "← assistant.other",
            );
          }
        }
        break;
      }
      case "user": {
        const raw = (m.message as Record<string, unknown>)?.content;
        const blocks = Array.isArray(raw)
          ? (raw as Array<Record<string, unknown>>)
          : [];
        for (const block of blocks) {
          if (block.type === "tool_result") {
            const content = block.content;
            const text =
              typeof content === "string" ? content : JSON.stringify(content);
            log.debug(
              {
                event: "sdk_msg",
                n,
                type,
                block: "tool_result",
                toolUseId: block.tool_use_id,
                isError: block.is_error === true,
                output: clip(text, 400),
              },
              "→ user.tool_result",
            );
          }
        }
        break;
      }
      case "stream_event": {
        const ev = m.event as Record<string, unknown> | undefined;
        const evType = String(ev?.type ?? "?");
        // stream_event deltas are very noisy; keep them at trace-ish debug
        // with minimal payload so file size stays manageable.
        log.debug({ event: "sdk_msg", n, type, evType }, "stream_event");
        break;
      }
      case "system": {
        log.debug(
          {
            event: "sdk_msg",
            n,
            type,
            subtype: m.subtype,
            status: (m as { status?: string }).status,
            tool: (m as { tool_name?: string }).tool_name,
            reason: clip(
              (m as { decision_reason?: unknown }).decision_reason,
              200,
            ),
          },
          "system",
        );
        break;
      }
      case "result": {
        log.info(
          {
            event: "sdk_msg",
            n,
            type,
            sessionId: (m as { session_id?: string }).session_id,
            costUsd: (m as { total_cost_usd?: number }).total_cost_usd,
            numTurns: (m as { num_turns?: number }).num_turns,
            resultHead: clip((m as { result?: string }).result, 400),
          },
          "← result",
        );
        break;
      }
      default:
        log.debug({ event: "sdk_msg", n, type }, "(other)");
    }
  } catch (err) {
    log.warn(
      { event: "sdk_msg_log_failed", n, type, err: String(err) },
      "failed to log SDK message",
    );
  }
}

async function* singleUserMessageStream(
  task: string,
): AsyncIterable<SDKUserMessage> {
  yield { role: "user", content: task };
}

function isResumeFailure(err: unknown): boolean {
  return (
    err instanceof SdkSessionError &&
    (err.code === ERR_SESSION_NOT_FOUND || err.code === ERR_SESSION_CORRUPT)
  );
}

// ─── coding-specific copy + translation (lives in the capability, not SDK) ───

function makeDetail(progress: CodingProgress, costUsd?: number): CodingDetail {
  return {
    filesChanged: progress.filesChanged,
    bashCommands: progress.bashCommands,
    costUsd: costUsd ?? progress.costUsd,
    errors: [],
  };
}

function buildStartAnnouncement(taskId: string): string {
  return (
    "[harness] 后台 coding 任务刚刚启动 (taskId=" +
    taskId +
    "). 这是用户唯一能听到的开始反馈, 你现在必须只生成一句简短自然的中文口语 (例如 '好的, 我让助手去看一下, 稍等' / '让我去查一下' / '稍等一下'). 不要重复任务内容, 不要再调任何工具, 不要预测结果. 任务完成时会有一条 '[coding_agent done]' 系统消息送达, 那时再播报真正的结果."
  );
}

function buildStatusInstruction(
  snap: TaskSnapshot,
  elapsedSec: number,
): string {
  const p = (snap.progress ?? {}) as Partial<CodingProgress>;
  const lastTool = p.lastTool
    ? `${p.lastTool}${p.lastToolInput ? `(${p.lastToolInput.slice(0, 60)})` : ""}`
    : "thinking";
  const filesCount = p.filesChanged?.length ?? 0;
  return `# 后台任务状态 (本轮实时数据,唯一权威)\n当前有一个 coding 任务在跑 (用户已经被告知了):\n- taskId: ${snap.taskId}\n- 已运行: ${formatElapsed(elapsedSec)}\n- 最近动作: ${lastTool}\n- 文件改动数: ${filesCount}\n回答运行时长时,只能用上面这个"已运行"的值; 忽略你在之前对话里说过的任何时长数字 (那些已经过时).\n下一轮用户说话时,根据语义判断:进度类问题→直接用上面的状态口头回答,不要调任何工具; 明确说停→coding_task_cancel; 无关闲聊→正常回答;不要默认取消任务.`;
}

function formatElapsed(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min} 分 ${rem} 秒`;
}

function buildCompletionAnnouncement(
  taskId: string,
  summary: TaskFinalSummary,
): string {
  const detail = (summary.detail ?? {}) as Partial<CodingDetail>;
  const statusZh =
    summary.status === "done"
      ? "完成"
      : summary.status === "interrupted"
        ? "已取消"
        : summary.status === "max_turns"
          ? "轮数超限"
          : summary.status === "max_budget"
            ? "预算超额"
            : "失败";
  const parts: string[] = [
    `[coding_agent done] taskId=${taskId} status=${summary.status}(${statusZh})`,
  ];
  const filesChanged = detail.filesChanged ?? [];
  const bashCommands = detail.bashCommands ?? [];
  const errors = detail.errors ?? [];
  if (filesChanged.length > 0) {
    parts.push(`files_changed=${JSON.stringify(filesChanged.slice(0, 8))}`);
  }
  if (bashCommands.length > 0) {
    parts.push(`bash_run=${JSON.stringify(bashCommands.slice(0, 3))}`);
  }
  if ((detail.costUsd ?? 0) > 0) {
    parts.push(`cost_usd=${(detail.costUsd ?? 0).toFixed(4)}`);
  }
  if (errors.length > 0) {
    parts.push(`errors=${JSON.stringify(errors.slice(0, 2))}`);
  }
  if (summary.summary) {
    parts.push(`agent_summary="""${summary.summary.slice(0, 800)}"""`);
  }
  parts.push(
    "请用 1-2 句自然中文向用户播报这个结果 (不要照念路径/diff/英文原文, 不要再调任何工具, 不要把这条消息当作真实用户提问).",
  );
  return parts.join("\n");
}

/** Map one @step-cli/agent-sdk message to zero or more generic task.progress
 *  payloads. The `kind` mirrors the former coding.* event types; `data` carries
 *  the specifics. UI that understands coding interprets these. */
function sdkMessageToProgress(
  msg: unknown,
): Array<{ kind: string; data: unknown }> {
  const out: Array<{ kind: string; data: unknown }> = [];
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "assistant": {
      const blocks = ((m.message as Record<string, unknown>)?.content ??
        []) as unknown as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === "tool_use") {
          out.push({
            kind: "tool_use",
            data: {
              toolUseId: String(block.id ?? ""),
              tool: String(block.name ?? ""),
              input: block.input,
            },
          });
        } else if (block.type === "text") {
          const text = String(block.text ?? "");
          if (text) {
            out.push({
              kind: "message",
              data: { role: "assistant", text, partial: false },
            });
          }
        }
      }
      break;
    }
    case "user": {
      const raw = (m.message as Record<string, unknown>)?.content;
      const blocks = Array.isArray(raw)
        ? (raw as unknown as Array<Record<string, unknown>>)
        : [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const content = block.content;
          const text =
            typeof content === "string" ? content : JSON.stringify(content);
          out.push({
            kind: "tool_result",
            data: {
              toolUseId: String(block.tool_use_id ?? ""),
              ok: !block.is_error,
              output: text,
            },
          });
        }
      }
      break;
    }
    case "stream_event": {
      const ev = m.event as unknown as Record<string, unknown> | undefined;
      if (!ev) break;
      if (ev.type === "content_block_delta") {
        const delta = ev.delta as Record<string, unknown> | undefined;
        if (
          delta?.type === "text_delta" &&
          typeof delta.text === "string" &&
          delta.text
        ) {
          out.push({
            kind: "message",
            data: { role: "assistant", text: delta.text, partial: true },
          });
        } else if (delta?.type === "input_json_delta") {
          const jsonDelta =
            typeof delta.partial_json === "string" ? delta.partial_json : "";
          out.push({
            kind: "tool_use_delta",
            data: { toolUseId: "", jsonDelta },
          });
        }
      }
      break;
    }
    case "system": {
      const subtype = (m as { subtype?: string }).subtype;
      if (subtype === "status") {
        const status = (m as { status?: string }).status;
        if (status === "compacting" || status === "requesting") {
          out.push({ kind: "status", data: { state: status } });
        } else if (status === null || status === undefined) {
          out.push({ kind: "status", data: { state: "idle" } });
        }
      } else if (subtype === "compact_boundary") {
        out.push({
          kind: "message",
          data: {
            role: "assistant",
            text: "(已自动压缩较早的消息)",
            partial: false,
          },
        });
      } else if (subtype === "permission_denied") {
        const pd = m as {
          tool_name?: string;
          tool_use_id?: string;
          decision_reason?: string;
        };
        out.push({
          kind: "tool_denied",
          data: {
            toolUseId: String(pd.tool_use_id ?? ""),
            tool: String(pd.tool_name ?? "?"),
            reason: pd.decision_reason,
          },
        });
      }
      break;
    }
    default:
      break;
  }
  return out;
}
