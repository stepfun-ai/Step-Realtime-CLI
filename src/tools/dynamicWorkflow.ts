import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { DynamicWorkflowError, runDynamicWorkflow } from '../agent/dynamicWorkflow/runner.js';
import { ScriptStore, type ScriptInfo } from '../agent/dynamicWorkflow/scriptStore.js';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';

/** agent 总数硬顶 1000；默认 100 在 runner。 */
const HARD_MAX_AGENTS = 1000;

const schema = z.object({
  script: z
    .string()
    .optional()
    .describe(
      'JS 编排脚本（async 函数体，以 return <报告> 收尾）。与 name/script_path 任一即可（都不给时返回可用脚本列表）；同时给 script 与 name 时以 script 为准。可用全局原语：' +
        'agent(prompt, {subagentType?, description?, schema?}?) → Promise<string|null|对象>（派子 agent，终态失败返回 null 不抛错；' +
        '给 schema（JSON Schema 对象）时自动追加输出契约，校验不匹配带错误纠正重试 ≤2 次，仍败返回 null，成功返回解析后的对象）；' +
        'parallel([() => agent(...), ...]) → Promise<(string|null)[]>（并发 barrier，永不 reject，失败位 null）；' +
        'pipeline(items, ...stages) → Promise<(string|null)[]>（每项串行过各 stage，某项失败掉 null 跳过后续 stage）；' +
        'phase(title)（记录阶段切换，展示层语义：阶段标题实时显示在 TUI 步骤面板，并随 [phase] 行进返回报告，长任务建议用它标注进度）；' +
        'budget({agents?, minutes?})（收紧本 run 预算：agents 覆盖 agent 上限、minutes 收紧 wall-clock，只能收紧不能放松，耗尽后 agent() 抛错；token 维度二期再做）；' +
        'args（入参 args）；console.log（限额日志）。' +
        '可直接用 if / for / .map / 提前 return 等原生控制流。Date.now / Math.random / 无参 new Date() 已禁用（保证可 resume），需要时间请从 args 传时间戳。',
    ),
  name: z
    .string()
    .optional()
    .describe('按名加载 .step-code/workflows/<name>.js 已存脚本执行（结构化重复性任务的复用入口）。未命中返回错误并列出当前可用脚本名。'),
  save_as: z
    .string()
    .optional()
    .describe('把本次 script 存为命名脚本（同名覆盖更新），之后可用 name 复用。必须配 script。description 非空时会写成脚本首行注释。'),
  script_path: z
    .string()
    .optional()
    .describe('从 cwd 内文件读取脚本执行（路径须在 cwd 内，越界拒绝）。与 script/name 同给属歧义会拒绝；文件不存在报错并给出路径。典型用法：失败后编辑结果里返回的脚本存档文件，再用 script_path 重跑（不必重发脚本全文），可与 resume_from_run_id 叠加。'),
  args: z.record(z.string(), z.unknown()).optional().describe('传给脚本的参数对象，沙箱内以全局 args 访问。'),
  max_agents: z
    .number()
    .int()
    .positive()
    .max(HARD_MAX_AGENTS)
    .optional()
    .describe(`agent 总数上限（护栏），默认 100，硬顶 ${HARD_MAX_AGENTS}；超限向脚本抛错。`),
  description: z.string().optional().describe('编排任务简述（3-5 词），用于后台任务列表展示；save_as 时写入脚本首行注释。'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('后台异步执行：立即返回 task_id，终态自动注入通知，不阻塞主会话。v1 限制：后台编排被 task_stop 时只标记 killed，不真正 abort 执行中的子 agent。'),
  resume_from_run_id: z
    .string()
    .optional()
    .describe('指定上一次失败的 runId：预载其 journal 缓存后从头重放脚本，已成功的 agent() 调用瞬时返回旧结果，失败的真重跑。'),
});

/** 失败结果格式化（前台返回与后台任务输出共用）：DynamicWorkflowError 带 resume 指引，其余给通用消息。 */
function formatFailure(e: unknown): string {
  if (e instanceof DynamicWorkflowError) {
    const stack = e.detail.stack !== undefined ? `\n\n栈：\n${e.detail.stack}` : '';
    return (
      `${e.message}${stack}\n\n` +
      `已完成 ${e.detail.agentsUsed} 个子 agent（成功结果已缓存）。\n` +
      `journal：${e.detail.journalPath}\n` +
      `脚本存档：${e.detail.scriptPath}\n` +
      `修复脚本后可用 resume_from_run_id: "${e.detail.runId}" 重试——已成功的调用走缓存瞬时返回，只真跑失败/新增部分；` +
      `也可编辑上面的存档文件后用 script_path 重跑（不必重发脚本全文），两者可叠加。`
    );
  }
  return `dynamic_workflow 执行失败：${(e as Error).message}`;
}

/** 「名字 — 描述」列表格式（零参数发现与 name 未命中共用）。 */
function formatScriptList(scripts: ScriptInfo[]): string {
  if (scripts.length === 0) return '（无）';
  return scripts.map((s) => (s.description !== undefined ? `${s.name} — ${s.description}` : s.name)).join(', ');
}

/**
 * 动态工作流：模型现写一段 JS 编排脚本，在零能力 wasm 沙箱（quickjs）里执行。
 * step-code 的编排收敛为两层：spawn_agent（直接派子 agent，简单批量用它）+
 * 本工具（写 JS 脚本，需要条件分支、循环、由中间数据动态决定编排时用）。
 * 循环（loop-until-done）与分支无需专门原语——用原生 for/while/if 表达即可。
 */
export const dynamicWorkflowTool: ToolDef<z.infer<typeof schema>> = {
  name: 'dynamic_workflow',
  description:
    '动态工作流：用一段现写的 JS 脚本动态编排多个子 agent（quickjs 沙箱执行，脚本只能调 agent/parallel/pipeline/phase/budget 原语，无文件/网络权限）。' +
    '适合需要条件分支、循环、根据中间结果动态决定后续编排的复杂任务；中间结果不占主上下文，只回最终 return 的报告（≤32KB）。' +
    '简单的固定批量任务（并行调查后综合、对列表逐项处理）优先直接发多个 spawn_agent，不必写脚本。' +
    '\n\n循环与分支无需专门原语——用原生 for/while/if 表达。loop-until-done（循环到条件满足）写法：' +
    'while (!done) { 派 agent 处理/验证; 根据结果更新 done }，停止条件必须显式可判（「无新发现/无新错误/全部归因」），' +
    '并设硬上限防死循环（如 for (let i = 0; i < 8 && !done; i++)，同时受 max_agents 与 budget() 兜底）。' +
    '\n\n示例：' +
    '\n① 无依赖任务 fan-out（必须 parallel，不要顺序 await）：' +
    'const [a, b, c] = await parallel([() => agent("调查X"), () => agent("调查Y"), () => agent("调查Z")]);' +
    'const ok = [a, b, c].filter(Boolean); return "综合:" + ok.join(";");' +
    '\n② pipeline 多阶段：return await pipeline(topics, (t) => agent("调研:" + t), (r) => agent("成文:" + r));' +
    '\n③ 条件分支：const pre = await agent("预检"); if (pre === null || pre.includes("不适用")) return "终止"; return await agent("深入:" + pre);' +
    '\n④ 评审闭环（loop-until-done：写→审→改，最多 N 轮、通过提前停）：' +
    'let draft = await agent("写初稿"); for (let i = 0; i < 5; i++) { const review = await agent("按标准审查，通过则回复 PASS，否则给修改意见:" + draft); if (review !== null && review.includes("PASS")) break; draft = await agent("按意见改:" + review + "原文:" + draft); } return draft;' +
    '\n⑤ 类型化中间结果（schema + fan-out，下游直接取字段）：' +
    'const S = { type: "object", properties: { topic: {type:"string"}, points: {type:"array", items:{type:"string"}} }, required: ["topic","points"] };' +
    'const rs = (await parallel(items.map((it) => () => agent("调研:" + it, { schema: S })))).filter(Boolean);' +
    'return rs.map((r) => r.topic + ":" + r.points.join("/")).join("\n");' +
    '\n\n反模式：多个无依赖的 agent() 禁止顺序逐个 await——顺序执行慢 N 倍，必须 parallel([...]) 一次并发。' +
    'agent()/parallel()/pipeline() 的失败位返回 null 不抛错，汇总前必须 .filter(Boolean) 或逐项判空。' +
    '\n\n子 agent prompt 写法：任务范围、输出格式/长度写具体；纯知识问答加负向约束（如「直接依据你的知识回答，不要读文件或联网搜索」）防止子 agent 乱逛。' +
    '\n\nagent(prompt, {schema}) 拿结构化输出（校验失败自动纠正重试）；budget({agents, minutes}) 收紧预算；' +
    'phase(title) 标记阶段；agent(..., {phase: "阶段名"}) 给单个 agent 归属阶段——并行时用 opts 标阶段，不要为标阶段而顺序执行。' +
    'save_as 把本次 script 存为命名脚本（description 写成首行注释，列表按「名字 — 描述」展示），之后用 name 复用；' +
    '查看已存脚本：列 <cwd>/.step-code/workflows/ 目录，或不带参数调用本工具。' +
    '每次运行脚本自动存档并在结果返回 script_path：失败后编辑该文件用 script_path 重跑（不重发全文），与 resume_from_run_id（已成功子任务走缓存）可叠加。' +
    'run_in_background=true 后台异步（立即返回 task_id，终态自动通知；v1 限制：task_stop 只标记 killed，不真正 abort 执行中的子 agent）。',
  schema,
  async execute(input, ctx) {
    if (ctx.runSubagent === undefined) {
      return fail('当前上下文不支持 dynamic_workflow（需要子 agent 能力）。');
    }

    // 参数约束：script_path 从 cwd 内文件读脚本（与 script/name 同给属歧义，拒绝）；save_as 必须配 script；
    // script/name/script_path 都不给时列出可用脚本（发现入口）；max_agents 硬顶。
    let script = input.script;
    if (input.script_path !== undefined) {
      if (script !== undefined || input.name !== undefined) {
        return fail('script_path 与 script/name 同给存在歧义，三者只给一个。');
      }
      const abs = resolvePath(ctx.cwd, input.script_path);
      const root = resolve(ctx.cwd);
      if (abs !== root && !abs.startsWith(root + sep)) {
        return fail(`script_path 必须位于 cwd 内（收到 ${input.script_path}）。`);
      }
      try {
        script = await readFile(abs, 'utf-8');
      } catch {
        return fail(`script_path 文件不存在或读取失败：${abs}`);
      }
    }
    if (input.save_as !== undefined && script === undefined) {
      return fail('save_as 必须配 script（保存的是本次现写的脚本）。');
    }
    if (script === undefined && input.name === undefined) {
      // 零参数调用 = 脚本发现：列出当前可用命名脚本 + 用法提示（非错误，治盲猜 name 探测）。
      const available = formatScriptList(await ScriptStore.list(ctx.cwd));
      return ok(
        `当前可用命名脚本：${available}\n` +
          `存储目录：${ScriptStore.dir(ctx.cwd)}\n` +
          `用法：script 现写编排脚本执行；name 复用已存脚本；script + save_as 把现写脚本存为命名脚本；script_path 从 cwd 内文件读脚本执行。`,
      );
    }
    if (input.max_agents !== undefined && input.max_agents > HARD_MAX_AGENTS) {
      return fail(`max_agents 硬顶 ${HARD_MAX_AGENTS}（收到 ${input.max_agents}）。`);
    }

    // name 按名加载：未命中返回错误并列出当前可用脚本（便宜的自发现能力）。
    if (script === undefined) {
      const loaded = await ScriptStore.load(ctx.cwd, input.name!);
      if (loaded === undefined) {
        const available = formatScriptList(await ScriptStore.list(ctx.cwd));
        return fail(
          `未找到命名脚本「${input.name}」。当前可用脚本：${available}。\n` +
            `存储目录：${ScriptStore.dir(ctx.cwd)}（可用 save_as 把现写脚本存进来）。`,
        );
      }
      script = loaded;
    }

    // save_as：把本次 script 存为命名脚本（同名覆盖更新）；description 写成首行注释。
    let savedPath: string | undefined;
    if (input.save_as !== undefined) {
      try {
        savedPath = await ScriptStore.save(ctx.cwd, input.save_as, script, input.description);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    // 包 {output, ok} promise：前台直接 await，后台交 startTask（同 spawn_agent 后台模式）
    const run = async (): Promise<{ output: string; ok: boolean }> => {
      try {
        const r = await runDynamicWorkflow({
          script: script!,
          args: input.args,
          maxAgents: input.max_agents,
          resumeFromRunId: input.resume_from_run_id,
          runSubagent: ctx.runSubagent!,
          maxConcurrent: ctx.subagentMaxConcurrent ?? 4,
          signal: ctx.signal,
          cwd: ctx.cwd,
          onWorkflowStep: ctx.onWorkflowStep,
        });
        const meta = `dynamic_workflow 完成（runId: ${r.runId}，用 ${r.agentsUsed} 个子 agent${r.journalHits > 0 ? `，缓存命中 ${r.journalHits} 次` : ''}）`;
        const saved = savedPath !== undefined ? `\n脚本已保存：${savedPath}（之后可用 name: "${input.save_as}" 复用）` : '';
        const archived = `\n脚本存档：${r.scriptPath}（可编辑后用 script_path 重跑）`;
        const logs = r.logs.length > 0 ? `\n\n脚本日志：\n${r.logs.join('\n')}` : '';
        return { output: `${meta}：${saved}${archived}\n\n${r.report}${logs}`, ok: true };
      } catch (e) {
        return { output: formatFailure(e), ok: false };
      }
    };

    if (input.run_in_background === true) {
      if (ctx.background === undefined) {
        return fail('当前上下文不支持后台任务。');
      }
      try {
        const id = ctx.background.startTask(`dynamic_workflow·${input.description ?? input.name ?? '编排'}`, run(), undefined, { kind: 'workflow' });
        return ok(
          `已在后台启动 dynamic_workflow（task_id=${id}）。终态会自动收到通知，也可用 task_output 查询。` +
            `注意：task_stop 只标记 killed，不会真正中断已在运行的子 agent。`,
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    const r = await run();
    return r.ok ? ok(r.output) : fail(r.output);
  },
};
