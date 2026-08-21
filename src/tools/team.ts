/**
 * team 工具集：多 agent 团队模式的模型侧入口。
 * 规则全在 TeamStore；这里只做参数校验、调用者边界与 worker 委派。
 *
 * 调用者边界：plan/spawn/merge/teardown/init 仅主 agent（team 协调者）可用；
 * send/inbox/status 主 agent 与 worker 均可用。
 */
import { z } from 'zod';

import { initTeam } from '../agent/team/mode.js';
import type { TeamMission } from '../agent/team/types.js';
import { fail, ok, type ToolDef } from './types.js';

/** 协调类工具仅主 agent 可调（子 agent 深度 >0 硬拒）。 */
function coordinatorOnly(ctx: { depth?: number }): string | null {
  return (ctx.depth ?? 0) > 0 ? '该工具只能由 team 协调者（主 agent）调用。' : null;
}

function fmtMission(m: TeamMission): string {
  const deps = m.deps.length > 0 ? `，依赖 ${m.deps.join('、')}` : '';
  return `${m.id} [${m.status}] ${m.title}（${m.kind}，范围 ${m.scope.join('、')}${deps}）`;
}

// ---------------------------------------------------------------- init

const initSchema = z.object({
  dir: z.string().optional().describe('团队档案目录（注意：不是基准仓！想指定基准仓请用 repo 参数）。可选，绝对路径；跨仓协作时指定到仓库外的独立位置，缺省在基准仓的 .teams/。'),
  repo: z.string().optional().describe('基准仓库绝对路径（可选；缺省为当前目录所在仓库——想在别的目录指挥某个仓时给出）。'),
  base: z.string().optional().describe('基准分支（可选；缺省为基准仓当前分支——开发不在当前分支上时显式给出，任务工作间从它开、收编合回它）。'),
});

export const teamInitTool: ToolDef<z.infer<typeof initSchema>> = {
  name: 'team_init',
  description:
    '初始化 team 团队模式：创建团队档案目录（任务清单/信箱/日志/工作间），进入团队模式。要求当前目录在 git 仓库内且已有至少一次提交，否则拒绝。幂等，已初始化时保留全部状态。仅协调者调用。',
  schema: initSchema,
  async execute(input, ctx) {
    const deny = coordinatorOnly(ctx);
    if (deny !== null) return fail(deny);
    if (ctx.team === undefined) return fail('当前上下文不支持 team。');
    try {
      const { store, created, base } = await initTeam(ctx.cwd, input.dir, input.repo, input.base);
      ctx.team.activate(store);
      return ok(
        `${created ? 'team 已初始化' : 'team 已初始化过——既有状态全部保留'}。基准仓：${store.repoRoot}，基准分支：${base}。档案目录：${store.dir}。\n` +
          '下一步：用 team_plan 拆分任务（写类任务的文件范围必须互斥），然后 team_spawn 逐任务派 worker，完成后 team_merge 收编。',
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

// ---------------------------------------------------------------- plan

const planSchema = z.object({
  missions: z
    .array(
      z.object({
        title: z.string().describe('任务标题。'),
        kind: z.enum(['build', 'survey']).describe('build 写代码（范围互斥）/ survey 只读调查。'),
        scope: z.array(z.string()).describe('允许改动的文件范围（相对仓库根的路径前缀，如 ["src/data/**"]）。survey 可空数组。'),
        deps: z.array(z.string()).describe('依赖的任务 id（如 ["M1"]）；依赖未合并前系统拒绝启动本任务。无依赖给空数组。'),
        repo: z.string().optional().describe('任务所属仓库（绝对路径，跨仓时给出；缺省为基准仓）。'),
      }),
    )
    .min(1),
});

export const teamPlanTool: ToolDef<z.infer<typeof planSchema>> = {
  name: 'team_plan',
  description:
    '拆分团队任务并登记任务清单。写类任务的文件范围两两互斥（重叠直接拒绝，需重新划分）；依赖必须引用已存在的任务。仅协调者调用。',
  schema: planSchema,
  async execute(input, ctx) {
    const deny = coordinatorOnly(ctx);
    if (deny !== null) return fail(deny);
    if (ctx.team === undefined) return fail('当前上下文不支持 team。');
    try {
      const missions = await ctx.team.getStore().plan(input.missions);
      return ok(`已登记 ${missions.length} 个任务：\n${missions.map(fmtMission).join('\n')}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

// ---------------------------------------------------------------- spawn

const spawnSchema = z.object({
  mission_id: z.string().describe('要启动的任务 id（如 "M1"）。'),
  subagent_type: z.string().optional().describe('worker 角色（缺省 general；只读调查用 explore，难题用 general-strong）。'),
  prompt: z.string().describe('任务的具体要求（技术方案、注意事项）。工作间路径与范围约束由系统自动附加。'),
});

/** worker 系统级任务说明：工作间硬约束 + 通信约定 + 完成后的汇报格式。 */
export function workerBriefing(m: TeamMission, worktreeAbs: string): string {
  return [
    `你是团队任务的执行 worker（名字 worker-${m.id}）。`,
    `任务 ${m.id}：${m.title}`,
    ``,
    `【硬约束】你的全部文件写操作必须发生在工作间内：${worktreeAbs}`,
    `写文件一律使用该目录下的绝对路径；不要写工作间之外的任何路径（系统会拦截）。`,
    `允许改动的文件范围（相对仓库根）：${m.scope.join('、')}。`,
    `分支 ${m.branch} 已在工作间就位，改动用 git -C "${worktreeAbs}" add/commit 提交到它。`,
    ``,
    `【绝对纪律——没有模糊空间】`,
    `① 文件改动：必须用写文件工具（write_file 等）落在工作间内。write guard 会硬拦工作间外的写工具调用，不可绕过。`,
    `② 禁止用 bash 在工作间外写文件。cat / sed / cp / tee / heredoc 重定向到工作间外路径都算。bash 不能绕过 write_file 的拦截——系统会扫描命令中的写入语法并拒绝，违规即终止。`,
    `③ git 操作（add / commit）只能在工作间内、提交到任务分支。禁止对基准仓主目录执行任何 git 写命令（git -C <主仓> commit、cd 主仓 && git commit 等）。`,
    `④ 验证脚本（node 脚本、临时文件）写在工作间内跑；需要对照主仓最新代码可以读，不能写。`,
    ``,
    `【通信】与其他 worker 或协调者协作：team_send 发信（from 填 worker-${m.id}）、team_inbox 收信（name 填 worker-${m.id}）。`,
    `发现不属于你范围的问题不要顺手改——发信给 team 说明。`,
    ``,
    `【完成后】提交全部改动，然后汇报：做了什么、改了哪些文件、风险点。`,
  ].join('\n');
}

export const teamSpawnTool: ToolDef<z.infer<typeof spawnSchema>> = {
  name: 'team_spawn',
  description:
    '为指定任务开出独立工作间（git worktree）并后台派生 worker。依赖未全部合并的任务会被系统拒绝启动。worker 的写操作被限制在工作间内。仅协调者调用。completed（审阅打回后返工 rework）和 blocked（worker 执行失败后重试 respawn）的任务允许重新启动：worktree 幂等重挂，任务分支上已有提交不丢。',
  schema: spawnSchema,
  async execute(input, ctx) {
    const deny = coordinatorOnly(ctx);
    if (deny !== null) return fail(deny);
    if (ctx.team === undefined) return fail('当前上下文不支持 team。');
    if (ctx.runSubagent === undefined) return fail('当前上下文不支持派生子 agent。');
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    if (ctx.signal?.aborted === true) return fail('当前回合已中断，未派生 worker。');

    try {
      // 门控 + 开工作间（依赖未满足在这里被 TeamError 拒掉）
      const m = await ctx.team.getStore().spawn(input.mission_id, `worker-${input.mission_id}`);
      const worktreeAbs = ctx.team.getStore().worktreePath(m);
      const briefing = `${workerBriefing(m, worktreeAbs)}\n\n【任务要求】\n${input.prompt}`;

      const bgCtrl = new AbortController();
      const store = ctx.team.getStore();
      const run = ctx
        .runSubagent({
          subagentType: input.subagent_type ?? 'general',
          prompt: briefing,
          depth: ctx.depth ?? 0,
          signal: bgCtrl.signal,
          description: `team ${m.id} ${m.title}`.slice(0, 40),
          // worker 的默认落点收进工作间 + 写操作 per-worker 硬隔离
          cwd: worktreeAbs,
          writeAllowRoot: worktreeAbs,
        })
        .then(async (r) => {
          // worker 收工：标 completed 等协调者审阅合并；失败标 blocked
          await store.setStatus(m.id, r.isError ? 'blocked' : 'completed').catch(() => undefined);
          return {
            output: `任务 ${m.id} ${r.isError ? '执行失败（已标 blocked）' : '完成（已标 completed，待审阅合并）'}。\n${r.summary}`,
            ok: !r.isError,
          };
        });
      const id = ctx.background.startTask(
        `team·${m.id} ${m.title}`.slice(0, 40),
        run,
        undefined,
        { kind: 'subagent', agentType: input.subagent_type ?? 'general' },
        { onStop: () => bgCtrl.abort() },
      );
      return ok(
        `任务 ${m.id} 已启动：工作间 ${worktreeAbs}，分支 ${m.branch}，后台 task_id=${id}。\n` +
          'worker 完成后会自动标记 completed；用 team_status 查看进展，team_merge 收编。',
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

// ---------------------------------------------------------------- send / inbox

const sendSchema = z.object({
  from: z.string().describe('发件人名字（worker 用 worker-<任务id>，协调者用 team）。'),
  to: z.string().describe('收件人名字，或 all 广播。'),
  subject: z.string().describe('一句话主题。'),
  body: z.string().describe('正文（Markdown）。'),
});

export const teamSendTool: ToolDef<z.infer<typeof sendSchema>> = {
  name: 'team_send',
  description: '团队信箱发信：给某个 worker / 协调者 / 全体成员留一条消息（落盘为 md 文件，可审计）。',
  schema: sendSchema,
  async execute(input, ctx) {
    if (ctx.team === undefined) return fail('当前上下文不支持 team。');
    try {
      const file = await ctx.team.getStore().send(input.from, input.to, input.subject, input.body);
      return ok(`已发送（${file}）。`);
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

const inboxSchema = z.object({
  name: z.string().optional().describe('收信人名字（缺省 team = 协调者看全部；worker 填自己的名字，只见发给自己的与广播）。'),
  limit: z.number().int().positive().optional().describe('最多返回多少条（缺省 20，newest-first）。'),
});

export const teamInboxTool: ToolDef<z.infer<typeof inboxSchema>> = {
  name: 'team_inbox',
  description: '团队信箱收信：读取发给指定名字的消息（newest-first）。',
  schema: inboxSchema,
  async execute(input, ctx) {
    if (ctx.team === undefined) return fail('当前上下文不支持 team。');
    try {
      const msgs = await ctx.team.getStore().inbox(input.name ?? 'team', input.limit ?? 20);
      if (msgs.length === 0) return ok('信箱为空。');
      return ok(
        msgs
          .map((m) => `【${m.sentAt}】${m.from} → ${m.to}：${m.subject}\n${m.body}`)
          .join('\n\n---\n\n'),
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

// ---------------------------------------------------------------- status

const statusSchema = z.object({});

export const teamStatusTool: ToolDef<z.infer<typeof statusSchema>> = {
  name: 'team_status',
  description: '查看团队全景：各任务状态、依赖关系、工作间与分支、基准分支。',
  schema: statusSchema,
  async execute(_input, ctx) {
    if (ctx.team === undefined) return fail('当前上下文不支持 team。');
    try {
      const store = ctx.team.getStore();
      const state = await store.load();
      const lines = [
        `基准分支：${state.base}（${state.repoRoot}）`,
        `档案目录：${store.dir}`,
        `任务 ${state.missions.length} 个：`,
        ...state.missions.map((m) => `  ${fmtMission(m)}${m.owner !== undefined ? `，执行者 ${m.owner}` : ''}`),
      ];
      return ok(lines.join('\n'));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

// ---------------------------------------------------------------- merge

const mergeSchema = z.object({
  mission_id: z.string().describe('要合并的任务 id。任务须为 completed 状态。'),
  reviewed_commit: z.string().describe('你审阅时的分支 tip commit（先 git rev-parse <branch> 拿到，审完 diff 后原样传入）。tip 若已移动会被拒绝并要求重审。'),
  force: z.boolean().optional().describe('跳过 typecheck 门（确认是环境差异等误报时用）。仅此一门可绕过，其余硬门不可 --force。'),
});

export const teamMergeTool: ToolDef<z.infer<typeof mergeSchema>> = {
  name: 'team_merge',
  description:
    '收编任务：过门禁后 --no-ff 合回基准分支。门禁含已审阅（tip 未移动）/ 依赖全部已合并 / diff 无范围外文件 / typecheck（build 任务在工作间跑 tsc --noEmit，非 TS 仓跳过）。仅协调者调用。合并前请先自行审阅 diff。',
  schema: mergeSchema,
  async execute(input, ctx) {
    const deny = coordinatorOnly(ctx);
    if (deny !== null) return fail(deny);
    if (ctx.team === undefined) return fail('当前上下文不支持 team。');
    try {
      const { conflictsWith, worktreeKept, typecheckSkipped } = await ctx.team
        .getStore()
        .merge(input.mission_id, input.reviewed_commit, input.force ?? false);
      const warn = conflictsWith.length > 0 ? `\n注意：本次改动波及未合并任务 ${conflictsWith.join('、')} 的范围——它们需要 rebase 后重审。` : '';
      const kept = worktreeKept ? `\n工作间保留：${worktreeKept}（有未提交改动，merge 后需手动处理）` : '';
      const skipped = typecheckSkipped ? '\ntypecheck 已跳过（非 TS 仓或无 typescript）。' : '';
      return ok(`任务 ${input.mission_id} 已合并到基准分支。${warn}${kept}${skipped}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

// ---------------------------------------------------------------- teardown

const teardownSchema = z.object({
  force: z.boolean().optional().describe('有未提交改动的工作间也删除（缺省 false = 保留，防数据丢失）。'),
  quit_only: z.boolean().optional().describe('应急通道：跳过状态读取与工作间清理，直接退出团队模式（teardown 反复失败、档案损坏时用；工作间残留需手动清理）。'),
});

export const teamTeardownTool: ToolDef<z.infer<typeof teardownSchema>> = {
  name: 'team_teardown',
  description: '收尾团队模式：清理工作间（dirty 默认保留），退出团队模式；档案目录（任务清单/信箱/日志）永久保留作审计。仅协调者调用。quit_only=true 是应急强退——teardown 失败时不要被困在团队模式里，用它先退出来。',
  schema: teardownSchema,
  async execute(input, ctx) {
    const deny = coordinatorOnly(ctx);
    if (deny !== null) return fail(deny);
    if (ctx.team === undefined) return fail('当前上下文不支持 team。');
    if (input.quit_only === true) {
      ctx.team.deactivate();
      return ok('已强制退出 team 模式（未读状态、未清工作间）。工作间与档案目录原样保留——手动清理，或重新 team_init 后再正常 teardown。');
    }
    try {
      const { removed, kept } = await ctx.team.getStore().teardown(input.force ?? false);
      ctx.team.deactivate();
      const keptLine = kept.length > 0 ? `\n保留：${kept.join('、')}` : '';
      return ok(`team 模式已退出。清理工作间 ${removed.length} 个。${keptLine}\n档案目录保留作审计。`);
    } catch (e) {
      return fail(
        `${(e as Error).message}\n` +
          '清理失败≠被困住：用 team_teardown(quit_only=true) 可跳过清理直接退出模式，工作间残留事后手动清。',
      );
    }
  },
};
