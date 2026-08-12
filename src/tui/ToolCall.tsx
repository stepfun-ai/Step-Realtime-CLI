import { Box, Text } from 'ink';
import type { DisplayItem, SubagentToolEvent } from './types.js';
import { useSpinnerFrame, BRAILLE_FRAMES } from './useSpinnerFrame.js';
import { DynamicWorkflowPanel } from './DynamicWorkflowPanel.js';
import { t } from '../i18n.js';

/** 工具入参的单行摘要（折叠态标题行与 ExpandViewer 条目标题共用口径）。 */
export function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // 优先展示最能代表操作对象的字段（skill 工具的操作对象是技能名，否则卡片只剩工具名、看不出激活了哪个）
  for (const key of ['path', 'pattern', 'command', 'skill']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 80 ? `${v.slice(0, 80)}…` : v;
    }
  }
  return '';
}

function statusMark(status: 'running' | 'ok' | 'error'): { symbol: string; color: string } {
  switch (status) {
    case 'running':
      return { symbol: '⏳', color: 'yellow' };
    case 'ok':
      return { symbol: '✓', color: 'green' };
    case 'error':
      return { symbol: '✗', color: 'red' };
  }
}

const EXPANDED_MAX_LINES = 200;
const DEFAULT_COLLAPSED_ERROR_LINES = 4;
/** 运行中滚动窗口：最多保留最近 3 条子工具调用。 */
const SUBAGENT_VISIBLE_TOOLS = 3;

/**
 * 折叠态是否真的藏了内容（Ctrl+O 全屏查看器的条目筛选口径，与 ResultBody 折叠分支一一对应）：
 * 成功且非 diff 的输出整段折叠成一行提示 → 可展开；错误输出超过预览行数 → 可展开；
 * diff 结果与短错误输出折叠态已完整显示 → 不算；running / 无结果体不算。
 */
export function hasCollapsedBody(
  item: Extract<DisplayItem, { kind: 'tool' }>,
  errorPreviewLines = DEFAULT_COLLAPSED_ERROR_LINES,
): boolean {
  if (item.status === 'running') return false;
  const result = item.result;
  if (result === undefined || result === '') return false;
  const lines = result.split('\n');
  if (item.status === 'error') return lines.length > errorPreviewLines;
  return !hasDiffHeader(lines);
}

/**
 * 结果里是否含 diff 摘要头（+N -M path）。edit 工具的真实输出首行是
 * 「已编辑 path（替换 N 处）。」、diff 头在第二行（73cd43d 起即是此形态），
 * 故扫前两行而非只看首行——早前只测 lines[0] 的判定与 edit 实际输出从同
 * 一个 commit 起就错位，diff 分支从未对真实 edit 结果生效过。
 */
export function hasDiffHeader(lines: readonly string[]): boolean {
  return lines.slice(0, 2).some((l) => /^[+-]\d+ /.test(l));
}

/** diff 数据行：4 位右对齐行号 + 空格 + 标记（+/-/空格）。用于按行上色。 */
const DIFF_ROW_RE = /^\s*\d+ ([+\-]) /;

/** 渲染一行工具输出，按 diff 语义上色：+ 绿、- 红、省略/展开提示暗色、diff 摘要头青色，其余常色。 */
function renderResultLine(line: string, key: number, fallbackColor: string): React.ReactElement {
  const m = DIFF_ROW_RE.exec(line);
  if (m !== null) {
    return (
      <Text key={key} color={m[1] === '+' ? 'green' : 'red'}>
        {line}
      </Text>
    );
  }
  // 省略/截断提示行（以若干空格 + … 开头）
  if (/^\s*…/.test(line)) {
    return (
      <Text key={key} color="gray">
        {line}
      </Text>
    );
  }
  // diff 摘要头（+N -M path）
  if (/^(\+\d+ )?(-\d+ )?\S/.test(line) && /^[+-]\d+ /.test(line)) {
    return (
      <Text key={key} color="cyan">
        {line}
      </Text>
    );
  }
  return (
    <Text key={key} color={fallbackColor}>
      {line}
    </Text>
  );
}

/** 渲染一条嵌套子工具调用（带 ↳ 前缀）。 */
function SubagentToolLine({ ev }: { ev: SubagentToolEvent }): React.ReactElement {
  const symbol = ev.status === 'ok' ? '✓' : ev.status === 'error' ? '✗' : '⏳';
  const color = ev.status === 'ok' ? 'green' : ev.status === 'error' ? 'red' : 'yellow';
  return (
    <Text>
      <Text color="gray">{'  ↳ '}</Text>
      <Text color={color}>{symbol}</Text>
      <Text color="cyan">{` ${ev.name}`}</Text>
    </Text>
  );
}

/**
 * 渲染子工具调用块（运行中滚动窗口 / 终态全量）。
 *
 * running 且 events 超过窗口：显示计数行 + 最近 3 条；
 * running 且 events 在窗口内：全部显示；
 * expanded（Ctrl+O）：全部显示；
 * 终态：全部显示。
 */
function SubagentToolBlock({
  events,
  running,
  expanded,
}: {
  events: SubagentToolEvent[];
  running: boolean;
  expanded: boolean;
}): React.ReactElement {
  if (events.length === 0) return <></>;
  const visible = running && !expanded && events.length > SUBAGENT_VISIBLE_TOOLS
    ? events.slice(-SUBAGENT_VISIBLE_TOOLS)
    : events;
  const collapsedCount = running && !expanded && events.length > SUBAGENT_VISIBLE_TOOLS
    ? events.length - SUBAGENT_VISIBLE_TOOLS
    : 0;
  return (
    <Box flexDirection="column">
      {collapsedCount > 0 ? (
        <Text color="gray">{`  ↳ ${t('toolCall.subagentCollapsed', { count: collapsedCount })}`}</Text>
      ) : null}
      {visible.map((ev, i) => (
        <SubagentToolLine key={`${ev.name}-${i}`} ev={ev} />
      ))}
    </Box>
  );
}

/**
 * 渲染一次工具调用：名称 + 入参摘要 + 状态。
 * spawn_agent 工具在运行中嵌套显示子工具调用（滚动窗口），成功后坍缩回一行，
 * 失败时保留尾部现场；expanded=true（全屏查看器/测试场景）时展开完整嵌套历史。
 */
export function ToolCall({
  item,
  expanded,
  errorPreviewLines = DEFAULT_COLLAPSED_ERROR_LINES,
}: {
  item: Extract<DisplayItem, { kind: 'tool' }>;
  expanded: boolean;
  /** 错误输出折叠态预览行数（默认 4，clamp [1, 20] 由调用方保证）。 */
  errorPreviewLines?: number;
}): React.ReactElement {
  const running = item.status === 'running';
  // running 时转圈（80ms），非 running 时不起定时器；同一 re-render 也顺带刷新已运行秒数。
  const spinner = useSpinnerFrame(running, BRAILLE_FRAMES);
  const mark = running ? { symbol: spinner, color: 'yellow' } : statusMark(item.status);
  const arg = summarizeInput(item.input);
  const elapsedSec =
    running && item.startedAt !== undefined ? Math.floor((Date.now() - item.startedAt) / 1000) : null;
  const result = item.result;
  const lines = result !== undefined && result !== '' ? result.split('\n') : [];
  const hasBody = lines.length > 0 && item.status !== 'running';
  const subagentEvents = item.subagentToolEvents;
  const isSpawnAgent = item.name === 'spawn_agent' && subagentEvents !== undefined && subagentEvents.length > 0;

  // dynamic_workflow 工具：运行中升级为动态阶段面板（phase 阶段序列 + 当前阶段高亮），
  // 完成后坍缩回一行摘要，结果体仍走原有折叠/Ctrl+O 机制。
  const dwf = item.dynamicWorkflow;
  if (dwf !== undefined) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={mark.color}>{mark.symbol} </Text>
          <Text color="cyan">{running ? t('dynamicWorkflow.title', { name: dwf.name }) : t('dynamicWorkflow.summary', { name: dwf.name, phases: dwf.phases.length })}</Text>
          {elapsedSec !== null ? <Text color="gray">{t('toolCall.elapsed', { s: elapsedSec })}</Text> : null}
        </Text>
        {running ? <DynamicWorkflowPanel state={dwf} /> : null}
        {hasBody ? <ResultBody lines={lines} isError={item.status === 'error'} expanded={expanded} errorPreviewLines={errorPreviewLines} /> : null}
      </Box>
    );
  }

  // spawn_agent 工具：三种终态渲染
  if (isSpawnAgent) {
    const totalToolCount = subagentEvents.length;
    // 成功坍缩（Rule 2）
    if (item.status === 'ok' && !expanded) {
      const durationSec = item.startedAt !== undefined ? Math.floor((Date.now() - item.startedAt) / 1000) : 0;
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={mark.color}>{mark.symbol} </Text>
            <Text color="cyan">{item.name}</Text>
            {item.subagentType !== undefined || item.description !== undefined ? (
              <Text color="gray">
                {` [${[item.subagentType, item.description].filter(Boolean).join(' · ')}]`}
              </Text>
            ) : null}
            <Text color="gray">{` ${t('toolCall.subagentSuccess', { s: durationSec, count: totalToolCount })}`}</Text>
          </Text>
        </Box>
      );
    }
    // 运行中 / 失败 / 展开：渲染嵌套子调用
    const showErrorPreview = item.status === 'error' && hasBody;
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={mark.color}>{mark.symbol} </Text>
          <Text color="cyan">{item.name}</Text>
          {item.subagentType !== undefined || item.description !== undefined ? (
            <Text color="gray">
              {` [${[item.subagentType, item.description].filter(Boolean).join(' · ')}]`}
            </Text>
          ) : null}
          {elapsedSec !== null && item.status !== 'ok' ? <Text color="gray">{t('toolCall.elapsed', { s: elapsedSec })}</Text> : null}
        </Text>
        <SubagentToolBlock events={subagentEvents} running={running && !expanded} expanded={expanded} />
        {showErrorPreview ? (
          <Box marginLeft={2} flexDirection="column">
            <ResultBody lines={lines} isError={true} expanded={expanded} errorPreviewLines={errorPreviewLines} />
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={mark.color}>{mark.symbol} </Text>
        <Text color="cyan">{item.name}</Text>
        {/* spawn_agent：角色名 + 任务简述用灰色显示，形如 "spawn_agent [general-fast · 修复登录页样式]" */}
        {item.subagentType !== undefined || item.description !== undefined ? (
          <Text color="gray">
            {` [${[item.subagentType, item.description].filter(Boolean).join(' · ')}]`}
          </Text>
        ) : null}
        {/* skill 名用黄色而非常规参数灰：技能激活会改变后续行为，比读写路径更需要一眼认出激活了哪个 */}
        {arg !== '' ? <Text color={item.name === 'skill' ? 'yellow' : 'gray'}>{`  ${arg}`}</Text> : null}
        {elapsedSec !== null ? <Text color="gray">{t('toolCall.elapsed', { s: elapsedSec })}</Text> : null}
        {/* 前台 bash 运行中提示可转后台：发现性入口，仅 running 时显示 */}
        {running && item.name === 'bash' ? <Text color="gray">{t('toolCall.bashBackgroundHint')}</Text> : null}
      </Text>
      {hasBody ? <ResultBody lines={lines} isError={item.status === 'error'} expanded={expanded} errorPreviewLines={errorPreviewLines} /> : null}
    </Box>
  );
}

function ResultBody({
  lines,
  isError,
  expanded,
  errorPreviewLines = DEFAULT_COLLAPSED_ERROR_LINES,
}: {
  lines: string[];
  isError: boolean;
  expanded: boolean;
  /** 错误输出折叠态预览行数（默认 4）。 */
  errorPreviewLines?: number;
}): React.ReactElement {
  if (expanded) {
    const shown = lines.slice(0, EXPANDED_MAX_LINES);
    const truncated = lines.length > EXPANDED_MAX_LINES;
    return (
      <Box flexDirection="column" marginLeft={2}>
        {shown.map((line, i) => renderResultLine(line, i, isError ? 'red' : 'gray'))}
        {truncated ? (
          <Text color="gray">{t('toolCall.tooLong', { shown: EXPANDED_MAX_LINES, total: lines.length })}</Text>
        ) : null}
      </Box>
    );
  }

  // 折叠态
  if (isError) {
    const preview = lines.slice(0, errorPreviewLines);
    const more = lines.length - errorPreviewLines;
    return (
      <Box flexDirection="column" marginLeft={2}>
        {preview.map((line, i) => renderResultLine(line, i, 'red'))}
        {more > 0 ? <Text color="gray">{t('toolCall.moreLines', { count: more })}</Text> : null}
      </Box>
    );
  }
  // 成功且含 diff（前两行内有 +N/-M 摘要头，edit 实际形态是 summary 行 + diff 头）：直接展示 diff 主体，不折叠成一行
  if (hasDiffHeader(lines)) {
    const shown = lines.slice(0, EXPANDED_MAX_LINES);
    const truncated = lines.length > EXPANDED_MAX_LINES;
    return (
      <Box flexDirection="column" marginLeft={2}>
        {shown.map((line, i) => renderResultLine(line, i, 'gray'))}
        {truncated ? (
          <Text color="gray">{t('toolCall.tooLong', { shown: EXPANDED_MAX_LINES, total: lines.length })}</Text>
        ) : null}
      </Box>
    );
  }
  // 成功且有输出：只给一行折叠提示
  return (
    <Box marginLeft={2}>
      <Text color="gray">{t('toolCall.collapsed', { count: lines.length })}</Text>
    </Box>
  );
}
