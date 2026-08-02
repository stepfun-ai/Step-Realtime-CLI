import { Box, Text, useInput, useStdout } from 'ink';
import { useEffect, useState } from 'react';
import type { BackgroundTask, TaskStatus } from '../agent/background/manager.js';
import { t } from '../i18n.js';
import { formatDuration } from './duration.js';
import { OffsetViewport } from './OffsetViewport.js';

/** 打开期间重读 background.list() 的轮询间隔（数据本地，成本可忽略）。 */
const POLL_MS = 1000;
/** 左栏任务列表的列宽上下限与占比（小/大终端都拿到合理宽度）。 */
const LIST_COL_MIN = 26;
const LIST_COL_MAX = 40;
const LIST_COL_RATIO = 0.32;
/** Detail 栏的框高（含上下边框）。内容 = 标题(1) + 至多 7 行字段（exitCode 仅 process 有、agentType 仅 subagent 有，二者不同时出现）。 */
const DETAIL_FRAME_ROWS = 10;
/** 三栏布局的最小列宽；低于此退化为单列堆叠布局。 */
const MIN_3COL_WIDTH = 60;
/** 单列退化布局里输出 tail 预览的行数。 */
const TAIL_PREVIEW_LINES = 8;

/** TasksViewer 依赖的后台任务数据源（BackgroundManager 的公开只读/控制子集，结构化类型便于测试 mock）。 */
export interface TasksViewerSource {
  list(): BackgroundTask[];
  stop(id: string): boolean;
  suppressNotification(id: string): void;
}

/** 过滤器四态：failed 桶涵盖 failed+killed（killed 含超时与被停，manager 语义如此，不细分）。 */
type TasksFilter = 'all' | 'running' | 'completed' | 'failed';
const FILTER_CYCLE: readonly TasksFilter[] = ['all', 'running', 'completed', 'failed'];
const FILTER_LABEL: Record<TasksFilter, string> = {
  all: 'tasksViewer.filterAll',
  running: 'tasksViewer.filterRunning',
  completed: 'tasksViewer.filterCompleted',
  failed: 'tasksViewer.filterFailed',
};

/** 四种状态的图标与颜色（killed 涵盖超时与被停，manager 语义如此，不细分）。 */
const STATUS_STYLE: Record<TaskStatus, { icon: string; color: string }> = {
  running: { icon: '●', color: 'cyan' },
  completed: { icon: '✓', color: 'green' },
  failed: { icon: '✗', color: 'red' },
  killed: { icon: '■', color: 'yellow' },
};

function matchFilter(task: BackgroundTask, filter: TasksFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'running':
      return task.status === 'running';
    case 'completed':
      return task.status === 'completed';
    case 'failed':
      return task.status === 'failed' || task.status === 'killed';
  }
}

/** 任务时长：运行中 = now - startedAt（随 1s tick 刷新），终态 = endedAt - startedAt。 */
function taskDuration(task: BackgroundTask): string {
  const start = Date.parse(task.startedAt);
  const end = task.endedAt !== undefined ? Date.parse(task.endedAt) : Date.now();
  if (Number.isNaN(start)) return '';
  return formatDuration(Math.max(0, end - start));
}

/** Detail 的 Time 行：运行中 = 已运行时长；终态 = 结束于多久前（相对时间）。 */
function taskTime(task: BackgroundTask): string {
  const start = Date.parse(task.startedAt);
  if (Number.isNaN(start)) return '';
  if (task.status === 'running') {
    return t('tasksViewer.timeRunning', { rel: formatDuration(Math.max(0, Date.now() - start)) });
  }
  if (task.endedAt !== undefined) {
    const end = Date.parse(task.endedAt);
    if (!Number.isNaN(end)) {
      return t('tasksViewer.timeFinished', { rel: formatDuration(Math.max(0, Date.now() - end)) });
    }
  }
  return '';
}

/** 列表行（三栏与单列布局共用）：指针 + 状态图标 + id + 状态词 + label + 时长。 */
function TaskRow({ task, selected }: { task: BackgroundTask; selected: boolean }): React.ReactElement {
  const style = STATUS_STYLE[task.status];
  return (
    <Text wrap="truncate" inverse={selected}>
      {selected ? '>' : ' '} <Text color={selected ? undefined : style.color}>{style.icon}</Text> {task.id}{' '}
      {t(`background.status.${task.status}`)} · {task.command} · {taskDuration(task)}
    </Text>
  );
}

/** Detail 栏内容：固定行序，无值的字段（kind/agentType/exitCode/Time 解析失败）整行省略。 */
function DetailLines({ task }: { task: BackgroundTask }): React.ReactElement {
  const rows: Array<{ label: string; value: string; color?: string }> = [
    { label: t('tasksViewer.detail.id'), value: task.id },
    { label: t('tasksViewer.detail.status'), value: t(`background.status.${task.status}`), color: STATUS_STYLE[task.status].color },
  ];
  if (task.kind !== undefined) rows.push({ label: t('tasksViewer.detail.kind'), value: t(`tasksViewer.kind.${task.kind}`) });
  if (task.agentType !== undefined) rows.push({ label: t('tasksViewer.detail.agentType'), value: task.agentType });
  rows.push({ label: t('tasksViewer.detail.description'), value: task.command });
  const time = taskTime(task);
  if (time !== '') rows.push({ label: t('tasksViewer.detail.time'), value: time });
  if (task.exitCode !== undefined) rows.push({ label: t('tasksViewer.detail.exitCode'), value: String(task.exitCode) });
  rows.push({ label: t('tasksViewer.detail.duration'), value: taskDuration(task) });
  return (
    <>
      {rows.map((r) => (
        <Text key={r.label} wrap="truncate">
          <Text color="gray">{r.label}: </Text>
          <Text color={r.color}>{r.value}</Text>
        </Text>
      ))}
    </>
  );
}

/**
 * /tasks 后台任务浏览器：弹层（同 ExpandViewer 的接管方式——替换动态区与输入槽，只留 StatusBar）。
 * 三栏布局：左任务列表、右上 Detail（id/状态/类别/描述/相对时间/退出码/时长）、右下输出尾部预览；
 * 标题行带 filter 状态与分状态计数（计数始终基于过滤前全量，Tab 切换不抖动），底栏键位提示。
 * 列宽 < MIN_3COL_WIDTH 或非 TTY（maxRows 缺省）时退化为单列堆叠布局。
 *
 * 刷新：1s tick 重读 list()——运行中任务的输出增长只有周期重读能看到（终态事件覆盖不了），
 * settle 状态翻转也在 1s 内自然捕获；r 手动刷新。任务本就内存态，不为浏览器新增持久化。
 *
 * 键位：↑↓/jk 选择；Tab 循环过滤（ALL→运行中→已完成→失败/终止）；Enter/o 打开完整输出滚动查看
 * （复用 OffsetViewport 偏移窗口，Esc/q 返回列表）；s 停止（y/n 确认，终态任务提示已是终态，
 * 停止后 suppressNotification 防「自己杀的任务还弹通知」噪音）；q/Esc 关闭。
 *
 * 输出是 64KB 字节级尾部环形缓冲（manager 侧截断），预览首行可能是残行，不修齐。
 */
export function TasksViewer({
  background,
  maxRows,
  onClose,
}: {
  background: TasksViewerSource;
  /** 可用行高（含标题栏与底栏，调用方给）；undefined = 不窗口化（非 TTY / 测试环境）。 */
  maxRows?: number;
  onClose: () => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [tasks, setTasks] = useState<BackgroundTask[]>(() => background.list());
  const [filter, setFilter] = useState<TasksFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'output'>('list');
  /** 停止确认：非 null 时等待 y/n（存任务 id，防 tick 刷新后选中漂移杀错任务）。 */
  const [confirmStopId, setConfirmStopId] = useState<string | null>(null);
  /** 瞬态提示（已是终态 / 已停止 / 停止失败），下一次有效操作时保留，不自动消隐。 */
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = (): void => setTasks(background.list());

  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [background]);

  const filtered = tasks.filter((tk) => matchFilter(tk, filter));
  // 选中漂移兜底：过滤切换后选中 id 不在列表里则回落到首条
  const selectedIndex = Math.max(
    0,
    filtered.findIndex((tk) => tk.id === selectedId),
  );
  const selected = filtered[selectedIndex];

  // ---- 完整输出滚动模式（Enter/o 进入）：偏移窗口语义同 ExpandViewer ----
  const [offset, setOffset] = useState(0);
  const [natural, setNatural] = useState<number | null>(null);
  const viewRows = maxRows !== undefined ? Math.max(maxRows - 2, 1) : Number.MAX_SAFE_INTEGER;
  const total = natural ?? 0;
  const maxOffset = Math.max(0, total - viewRows);
  const clamped = Math.min(Math.max(offset, 0), maxOffset);
  const clampTo = (v: number): number => Math.min(Math.max(v, 0), maxOffset);

  useInput((key, meta) => {
    if (mode === 'output') {
      if (meta.escape || key === 'q') {
        setMode('list');
        setOffset(0);
        return;
      }
      if (meta.upArrow || key === 'k') setOffset((o) => clampTo(o - 1));
      else if (meta.downArrow || key === 'j') setOffset((o) => clampTo(o + 1));
      else if (meta.pageUp) setOffset((o) => clampTo(o - viewRows));
      else if (meta.pageDown) setOffset((o) => clampTo(o + viewRows));
      else if (meta.home || key === 'g') setOffset(0);
      else if (meta.end || key === 'G') setOffset(maxOffset);
      return;
    }

    // 停止确认态：只认 y/n/Esc，其余按键吞掉，防误触列表键位
    if (confirmStopId !== null) {
      if (key === 'y') {
        // 亲手杀的任务抑制终态通知（结果已在这里可见，再发 killed 通知是噪音）
        background.suppressNotification(confirmStopId);
        const stopped = background.stop(confirmStopId);
        setNotice(
          stopped
            ? t('tasksViewer.stopped', { id: confirmStopId })
            : t('tasksViewer.stopFailed', { id: confirmStopId }),
        );
        setConfirmStopId(null);
        refresh();
      } else if (key === 'n' || meta.escape) {
        setConfirmStopId(null);
      }
      return;
    }

    if (meta.escape || key === 'q') {
      onClose();
      return;
    }
    if (meta.tab) {
      setFilter((f) => FILTER_CYCLE[(FILTER_CYCLE.indexOf(f) + 1) % FILTER_CYCLE.length]!);
      return;
    }
    if ((meta.upArrow || key === 'k') && filtered.length > 0) {
      setSelectedId(filtered[Math.max(0, selectedIndex - 1)]!.id);
      return;
    }
    if ((meta.downArrow || key === 'j') && filtered.length > 0) {
      setSelectedId(filtered[Math.min(filtered.length - 1, selectedIndex + 1)]!.id);
      return;
    }
    if (key === 'r') {
      refresh();
      return;
    }
    if (selected === undefined) return;
    if (meta.return || key === 'o') {
      setMode('output');
      setOffset(0);
      return;
    }
    if (key === 's') {
      if (selected.status !== 'running') {
        setNotice(
          t('tasksViewer.alreadyTerminal', {
            id: selected.id,
            status: t(`background.status.${selected.status}`),
          }),
        );
        return;
      }
      setConfirmStopId(selected.id);
    }
  });

  // ---- 完整输出模式：标题 + OffsetViewport 偏移窗口 + 底栏（同 ExpandViewer 骨架）----
  if (mode === 'output' && selected !== undefined) {
    const lastRow = total === 0 ? 0 : Math.min(clamped + viewRows, total);
    const body =
      selected.output === '' ? (
        <Text color="gray">{t('tasksViewer.noOutput')}</Text>
      ) : (
        <Text>{selected.output}</Text>
      );
    return (
      <Box flexDirection="column">
        <Text color="gray" wrap="truncate">
          {t('tasksViewer.outputTitle', { id: selected.id, label: selected.command })}
        </Text>
        {maxRows !== undefined ? (
          <OffsetViewport
            offset={clamped}
            maxRows={viewRows}
            onNaturalHeight={(h) => setNatural((prev) => (prev === h ? prev : h))}
          >
            {body}
          </OffsetViewport>
        ) : (
          <Box flexDirection="column">{body}</Box>
        )}
        <Box justifyContent="space-between">
          <Text color="gray" wrap="truncate">
            {t('tasksViewer.outputFooter')}
          </Text>
          <Text color="gray">
            {t('tasksViewer.position', { start: total === 0 ? 0 : clamped + 1, end: lastRow, total })}
          </Text>
        </Box>
      </Box>
    );
  }

  // ---- 列表模式：标题行（filter + 分状态计数，计数基于过滤前全量）----
  const runningCount = tasks.filter((tk) => tk.status === 'running').length;
  const completedCount = tasks.filter((tk) => tk.status === 'completed').length;
  const failedCount = tasks.filter((tk) => tk.status === 'failed' || tk.status === 'killed').length;
  const header = t('tasksViewer.title', {
    filter: t(FILTER_LABEL[filter]),
    running: runningCount,
    completed: completedCount,
    failed: failedCount,
    total: tasks.length,
  });
  const noticeLine =
    confirmStopId !== null ? (
      <Text color="yellow">{t('tasksViewer.confirmStop', { id: confirmStopId })}</Text>
    ) : notice !== null ? (
      <Text color="yellow">{notice}</Text>
    ) : (
      <Text> </Text>
    );

  const cols = stdout?.columns;
  const threeCol = maxRows !== undefined && cols !== undefined && cols >= MIN_3COL_WIDTH;

  if (threeCol) {
    // ---- 三栏布局：行预算 = maxRows - 标题(1) - 提示行(1) - 底栏(1) ----
    const bodyRows = Math.max(maxRows - 3, 3);
    const listWidth = Math.max(LIST_COL_MIN, Math.min(LIST_COL_MAX, Math.floor(cols * LIST_COL_RATIO)));
    const listInner = Math.max(bodyRows - 2, 1);
    // 列表窗口：以选中项为中心切片（任务数超屏时保证选中可见）
    const start = Math.min(
      Math.max(0, selectedIndex - Math.floor(listInner / 2)),
      Math.max(0, filtered.length - listInner),
    );
    const visible = filtered.slice(start, start + listInner);
    const previewInner = Math.max(bodyRows - DETAIL_FRAME_ROWS - 2, 1);
    // 尾部行数预算 = 预览框内高 - 标题行(1)，超出的行被 ink 溢出裁剪会连标题一起挤掉
    const previewTail = Math.max(previewInner - 1, 1);
    const tailLines =
      selected === undefined || selected.output === ''
        ? []
        : selected.output.split('\n').slice(-previewTail);
    return (
      <Box flexDirection="column">
        <Text color="gray" wrap="truncate">
          {header}
        </Text>
        <Box flexDirection="row" height={bodyRows}>
          <Box width={listWidth} borderStyle="round" borderColor="gray" flexDirection="column">
            {filtered.length === 0 ? (
              <Text color="gray" wrap="truncate">
                {t('tasksViewer.empty')}
              </Text>
            ) : (
              visible.map((tk) => <TaskRow key={tk.id} task={tk} selected={tk.id === selected?.id} />)
            )}
          </Box>
          <Box flexGrow={1} flexDirection="column">
            <Box height={DETAIL_FRAME_ROWS} borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
              <Text color="gray">{t('tasksViewer.detailTitle')}</Text>
              {selected !== undefined ? (
                <DetailLines task={selected} />
              ) : (
                <Text color="gray">{t('tasksViewer.empty')}</Text>
              )}
            </Box>
            <Box flexGrow={1} borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
              <Text color="gray" wrap="truncate">
                {selected !== undefined ? t('tasksViewer.tailTitle', { id: selected.id }) : ' '}
              </Text>
              {selected !== undefined && selected.output === '' ? (
                <Text color="gray">{t('tasksViewer.noOutput')}</Text>
              ) : (
                tailLines.map((line, i) => (
                  <Text key={i} wrap="truncate" color="gray">
                    {line === '' ? ' ' : line}
                  </Text>
                ))
              )}
            </Box>
          </Box>
        </Box>
        {noticeLine}
        <Text color="gray" wrap="truncate">
          {t('tasksViewer.footer')}
        </Text>
      </Box>
    );
  }

  // ---- 单列退化布局（非 TTY / 窄终端）：列表 + 底部 tail 预览 ----
  const reserved = 1 + 1 + TAIL_PREVIEW_LINES + 1 + 1;
  const listRows = maxRows !== undefined ? Math.max(maxRows - reserved, 1) : Number.MAX_SAFE_INTEGER;
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(listRows / 2)),
    Math.max(0, filtered.length - listRows),
  );
  const visible = filtered.slice(start, start + listRows);
  const tailLines =
    selected === undefined || selected.output === ''
      ? [t('tasksViewer.noOutput')]
      : selected.output.split('\n').slice(-TAIL_PREVIEW_LINES);

  return (
    <Box flexDirection="column">
      <Text color="gray" wrap="truncate">
        {header}
      </Text>
      {filtered.length === 0 ? (
        <Text color="gray">{t('tasksViewer.empty')}</Text>
      ) : (
        visible.map((tk) => <TaskRow key={tk.id} task={tk} selected={tk.id === selected?.id} />)
      )}
      {selected !== undefined ? (
        <>
          <Text color="gray" wrap="truncate">
            {t('tasksViewer.tailTitle', { id: selected.id })}
          </Text>
          {tailLines.map((line, i) => (
            <Text key={i} wrap="truncate" color={selected.output === '' ? 'gray' : undefined}>
              {line === '' ? ' ' : line}
            </Text>
          ))}
        </>
      ) : null}
      {confirmStopId !== null ? (
        <Text color="yellow">{t('tasksViewer.confirmStop', { id: confirmStopId })}</Text>
      ) : notice !== null ? (
        <Text color="yellow">{notice}</Text>
      ) : null}
      <Text color="gray" wrap="truncate">
        {t('tasksViewer.footer')}
      </Text>
    </Box>
  );
}
