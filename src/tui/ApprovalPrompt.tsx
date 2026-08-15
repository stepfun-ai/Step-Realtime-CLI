import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { t } from '../i18n.js';
import { wrappedRows } from '../chat/liveBudget.js';

export interface ApprovalRequest {
  name: string;
  input: unknown;
}

/** 审批结果回传：allow 是否允许，forSession 是否本会话都允许，feedback 拒绝时附带的反馈文本（无反馈为 undefined）。 */
export type ApprovalResolve = (allow: boolean, forSession: boolean, feedback?: string) => void;

function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ['command', 'path', 'pattern']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 120 ? `${v.slice(0, 120)}…` : v;
    }
  }
  return '';
}

/** 按工具定制的审批标题 key；不在表内的工具回退到通用标题 approval.title。 */
const TITLE_KEYS: Record<string, string> = {
  bash: 'approval.title.bash',
  write_file: 'approval.title.write',
  edit_file: 'approval.title.edit',
};

/**
 * bash 危险命令模式表：正则 + 警告文案 key。
 * 宁保守勿误报，只覆盖明确危险的形态；命中后在命令上方红标一行警告。
 */
const DANGER_PATTERNS: ReadonlyArray<{ pattern: RegExp; warnKey: string }> = [
  // rm 递归强制删除：rm -rf / rm -fr / rm --recursive --force 等
  {
    pattern:
      /\brm\s+(?:-{1,2}[\w-]+\s+)*(?:-[\w-]*(?:r[\w-]*f|f[\w-]*r)[\w-]*|--recursive\b[^|;]*--force|--force\b[^|;]*--recursive)/,
    warnKey: 'approval.danger.rmRf',
  },
  // 以 root 权限执行
  { pattern: /\bsudo\b/, warnKey: 'approval.danger.sudo' },
  // 远程脚本直接管道执行：curl/wget ... | sh / bash / zsh
  { pattern: /\b(?:curl|wget)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, warnKey: 'approval.danger.pipeShell' },
  // dd 写块设备：dd of=/dev/sdX
  { pattern: /\bdd\b[^|;]*\bof=\/dev\//, warnKey: 'approval.danger.ddDevice' },
  // 格式化文件系统：mkfs / mkfs.ext4
  { pattern: /\bmkfs(?:\.\w+)?\b/, warnKey: 'approval.danger.mkfs' },
  // 开放全部权限：chmod [-R] 777
  { pattern: /\bchmod\s+(?:-\S+\s+)*777\b/, warnKey: 'approval.danger.chmod777' },
  // 重定向写裸设备：> /dev/sdX / nvme / mmcblk 等
  { pattern: />\s*\/dev\/(?:sd|hd|vd|nvme|mmcblk|disk)/, warnKey: 'approval.danger.rawDevice' },
  // fork 炸弹：:(){ :|:& };:
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}/, warnKey: 'approval.danger.forkBomb' },
];

/** 命中危险模式表返回警告文案 key 列表（保持表内顺序）；未命中返回空数组。 */
function dangerWarnings(command: string): string[] {
  const keys: string[] = [];
  for (const { pattern, warnKey } of DANGER_PATTERNS) {
    if (pattern.test(command)) keys.push(warnKey);
  }
  return keys;
}

/** 预览折叠时最多显示的行数。 */
const PREVIEW_LIMIT = 10;

/** 预览行：text 为整行文本，color 仅 diff 的 -/+ 行着色（红/绿），其余走默认灰。 */
interface PreviewLine {
  text: string;
  color?: 'red' | 'green';
}

/** edit 的紧凑 diff：剥掉公共前后缀行，中段旧行标 -、新行标 +。O(n)，不做 LCS。 */
function buildDiffLines(oldStr: string, newStr: string): PreviewLine[] {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const lines: PreviewLine[] = [];
  for (const line of a.slice(pre, a.length - suf)) lines.push({ text: `- ${line}`, color: 'red' });
  for (const line of b.slice(pre, b.length - suf)) lines.push({ text: `+ ${line}`, color: 'green' });
  return lines;
}

/** write 的内容预览：带行号的原始内容行。 */
function buildWriteLines(content: string): PreviewLine[] {
  return content.split('\n').map((line, i) => ({ text: `${String(i + 1).padStart(3)} │ ${line}` }));
}

/** 按工具构建预览行；bash/其它工具无预览返回 null。 */
function buildPreview(req: ApprovalRequest): PreviewLine[] | null {
  if (req.input === null || typeof req.input !== 'object') return null;
  const obj = req.input as Record<string, unknown>;
  if (req.name === 'edit_file' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
    return buildDiffLines(obj.old_string, obj.new_string);
  }
  if (req.name === 'write_file' && typeof obj.content === 'string') {
    return buildWriteLines(obj.content);
  }
  return null;
}

/** 提取 bash 命令文本（仅 bash 工具需要危险模式匹配），取不到返回空串。 */
function bashCommand(req: ApprovalRequest): string {
  if (req.name !== 'bash' || req.input === null || typeof req.input !== 'object') return '';
  const v = (req.input as Record<string, unknown>).command;
  return typeof v === 'string' ? v : '';
}

/** 四个审批选项：允许一次 / 本会话都允许 / 拒绝 / 拒绝并写评论，分别对应按键 y/a/n/f 和数字 1/2/3/4。 */
const OPTIONS: ReadonlyArray<{ labelKey: string; result: [boolean, boolean]; requiresFeedback?: boolean }> = [
  { labelKey: 'approval.option.allowOnce', result: [true, false] },
  { labelKey: 'approval.option.allowSession', result: [true, true] },
  { labelKey: 'approval.option.deny', result: [false, false] },
  // 第 4 项选中后不立即提交，先进入 feedback 模式收集拒绝原因，result 在提交时才用
  { labelKey: 'approval.option.denyWithFeedback', result: [false, false], requiresFeedback: true },
];

/** 组装拒绝原因：有反馈时拼上反馈文本，模型可据此调整；无反馈保持原样。 */
export function denyReason(feedback?: string): string {
  return feedback !== undefined && feedback !== '' ? `用户拒绝了该操作，反馈：${feedback}` : '用户拒绝了该操作';
}

/**
 * 估算审批框渲染行数（供 App 计算动态区高度预算，滚动跳顶修复）。
 * 结构：marginTop 1 + 边框 2 + 标题（折行）+ 危险警告 N（折行）+ 参数摘要（折行）
 * + 预览（折叠态 ≤ PREVIEW_LIMIT 逻辑行，逐行折行；可折叠时 +1 提示行）+ 选项 4（折行）+ 底部提示（折行）。
 * termCols 用于精确计算长命令/长预览行的折行（内宽 = 列数 − 边框 2 − paddingX 2）；
 * 缺省时退化为每逻辑行 1 行（测试/非 TTY 场景），与旧结构估算等价。
 * 注：Ctrl+E 展开预览行数无界（用户显式动作），此处按折叠态估算；展开态下可能偶发一帧超高。
 */
export function estimateChromeRows(req: ApprovalRequest, termCols?: number): number {
  const innerWidth = termCols === undefined ? undefined : termCols - 4;
  const titleKey = TITLE_KEYS[req.name];
  const title = titleKey !== undefined ? t(titleKey) : t('approval.title', { name: req.name });
  let rows = wrappedRows(title, innerWidth);
  for (const k of dangerWarnings(bashCommand(req))) {
    rows += wrappedRows(t(k), innerWidth);
  }
  const arg = summarizeInput(req.input);
  if (arg !== '') rows += wrappedRows(arg, innerWidth);
  const preview = buildPreview(req);
  if (preview !== null && preview.length > 0) {
    for (const line of preview.slice(0, PREVIEW_LIMIT)) {
      rows += wrappedRows(line.text, innerWidth);
    }
    if (preview.length > PREVIEW_LIMIT) {
      rows += wrappedRows(t('approval.preview.more', { shown: PREVIEW_LIMIT, total: preview.length }), innerWidth);
    }
  }
  OPTIONS.forEach((opt, i) => {
    rows += wrappedRows(`▶ ${i + 1}. ${t(opt.labelKey)}`, innerWidth);
  });
  rows += wrappedRows(t('approval.hint.select'), innerWidth);
  return 1 + 2 + rows;
}

/**
 * 工具执行前的审批对话。竖向编号列表 + 选中高亮：
 * ↑↓ 移动选中（循环回卷）、Enter 确认当前项、数字 1/2/3/4 或字母 y/a/n/f 直选、Esc 等同拒绝。
 * 第 4 项「拒绝并写评论」选中后进入 feedback 模式：该选项行变内联输入，Enter 带反馈拒绝、
 * ↑/↓ 退出 feedback 模式并移动选中、Esc 任何时刻直接拒绝（不带反馈）。
 * 进阶能力：
 * - 标题按工具定制（bash/write_file/edit_file 各有专用问句，其它工具回退通用形态）；
 * - bash 命令命中危险模式时，命令摘要上方渲染红色加粗警告行；
 * - write_file/edit_file 的待写入/待修改内容默认只显示前 PREVIEW_LIMIT 行，
 *   Ctrl+E 展开/收起（仅内容超限时提示该键；App 审批态已让出按键，无冲突）。
 * 组件自持 useInput；宿主（App）在审批态让出全部按键给本组件（与 QuestionPrompt 同一模式）。
 */
export function ApprovalPrompt({
  req,
  onResolve,
}: {
  req: ApprovalRequest;
  onResolve: ApprovalResolve;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const arg = summarizeInput(req.input);
  const titleKey = TITLE_KEYS[req.name];
  const dangerKeys = dangerWarnings(bashCommand(req));
  const preview = buildPreview(req);
  const previewCollapsible = preview !== null && preview.length > PREVIEW_LIMIT;

  /** 选中第 4 项并进入 feedback 模式。 */
  const enterFeedback = (): void => {
    setSelected(OPTIONS.length - 1);
    setFeedbackMode(true);
  };

  useInput((input, key) => {
    // Esc 任何时刻直接拒绝（不带反馈）
    if (key.escape) {
      onResolve(false, false);
      return;
    }
    // Ctrl+E 展开/收起预览（仅内容超限时才有意义；feedback 模式下同样可用，不影响字符输入）
    if (key.ctrl && input === 'e') {
      if (previewCollapsible) setPreviewExpanded((v) => !v);
      return;
    }
    if (feedbackMode) {
      if (key.upArrow) {
        setFeedbackMode(false);
        setSelected((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
        return;
      }
      if (key.downArrow) {
        setFeedbackMode(false);
        setSelected((i) => (i + 1) % OPTIONS.length);
        return;
      }
      if (key.return) {
        // 约定：空反馈等同普通拒绝，第三参传 undefined（而不是空串）
        const text = feedbackText.trim();
        onResolve(false, false, text === '' ? undefined : text);
        return;
      }
      if (key.backspace || key.delete) {
        setFeedbackText((s) => s.slice(0, -1));
        return;
      }
      // 其余可打印字符追加到反馈文本（忽略 Ctrl/Meta 组合键）
      if (!key.ctrl && !key.meta && input !== '') {
        setFeedbackText((s) => s + input);
      }
      return;
    }
    if (key.upArrow) {
      setSelected((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setSelected((i) => (i + 1) % OPTIONS.length);
      return;
    }
    if (key.return) {
      const opt = OPTIONS[selected]!;
      if (opt.requiresFeedback === true) {
        enterFeedback();
        return;
      }
      onResolve(...opt.result);
      return;
    }
    // 数字键 1/2/3 直选立即执行；4 不直接拒绝而是进 feedback 模式
    if (/^[1-4]$/.test(input)) {
      const opt = OPTIONS[Number(input) - 1]!;
      if (opt.requiresFeedback === true) enterFeedback();
      else onResolve(...opt.result);
      return;
    }
    // 字母键 y/a/n 直选立即执行（保留原有肌肉记忆）；f 进 feedback 模式
    if (input === 'y') onResolve(true, false);
    else if (input === 'a') onResolve(true, true);
    else if (input === 'n') onResolve(false, false);
    else if (input === 'f') enterFeedback();
  });

  // 预览显示行：折叠态取前 PREVIEW_LIMIT 行；展开态全量
  const previewShown = preview !== null ? (previewExpanded ? preview : preview.slice(0, PREVIEW_LIMIT)) : [];

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        {titleKey !== undefined ? (
          t(titleKey)
        ) : (
          <>
            {t('approval.title', { name: '' })}
            <Text color="cyan">{req.name}</Text>
          </>
        )}
      </Text>
      {dangerKeys.map((k) => (
        <Text key={k} color="red" bold>
          {t(k)}
        </Text>
      ))}
      {arg !== '' ? <Text color="gray">{arg}</Text> : null}
      {previewShown.length > 0 ? (
        <>
          {previewShown.map((line, i) => (
            <Text key={i} color={line.color ?? 'gray'}>
              {line.text}
            </Text>
          ))}
          {previewCollapsible ? (
            <Text color="gray">
              {previewExpanded
                ? t('approval.preview.collapse', { total: preview!.length })
                : t('approval.preview.more', { shown: PREVIEW_LIMIT, total: preview!.length })}
            </Text>
          ) : null}
        </>
      ) : null}
      {OPTIONS.map((opt, i) => {
        const active = i === selected;
        return (
          <Text key={i} color={active ? 'cyan' : 'white'} bold={active}>
            {active ? '▶ ' : '  '}
            {`${i + 1}. ${t(opt.labelKey)}`}
            {feedbackMode && active ? ` ${feedbackText}▏` : ''}
          </Text>
        );
      })}
      <Text color="gray">
        {feedbackMode ? t('approval.hint.feedback') : t('approval.hint.select')}
      </Text>
    </Box>
  );
}
