import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type React from 'react';
import { t } from '../i18n.js';
import { wrappedRows } from '../chat/liveBudget.js';
import { Markdown, measureMarkdownRows } from './Markdown.js';

/**
 * 计划确认框（exit_plan_mode 的审批 UI）。
 *
 * 从「绿框 + 计划正文纯文本平铺 + 只能按 y/n」升级为两点：
 *
 * 1. **正文走 Markdown 渲染**。模型产出的计划几乎总是 markdown（标题、列表、代码、表格），
 *    此前 `<Text>{plan}</Text>` 整段平铺，标题不加粗、列表不缩进、表格塌成一行；
 *    而同一份内容出现在对话消息里是正常渲染的，同一个终端里两套表现。
 * 2. **选项列表交互**，与 ApprovalPrompt / QuestionPrompt 同构（↑↓ 选择 + Enter 确认，
 *    数字键直选，同时保留 y/n 直按不破坏肌肉记忆）。其中「拒绝并说明如何修订」是新增能力：
 *    此前提示文案写着「反馈给模型修订」，但根本没有反馈通道，拒绝只回一句固定话术。
 *
 * 行数预算：本组件是弹层，占 chrome 固定部分，超限会触发 Ink 全量清屏（清空 scrollback）。
 * 故行数公式 `planBoxRows()` 与本组件同文件维护——公式写在 App.tsx 而渲染在组件里，
 * 是 AgentGroup 那次漏算一行就触发清屏的根因。
 */

/** 计划审批结果：approved 是否批准，feedback 拒绝时附带的修订意见（无则 undefined）。 */
export type PlanResolve = (approved: boolean, feedback?: string) => void;

interface PlanOption {
  /** 文案 key */
  key: string;
  /** 选中后是否先进入反馈输入而非立即提交 */
  requiresFeedback?: boolean;
  /** 直接提交时的结果 */
  approved: boolean;
}

const OPTIONS: PlanOption[] = [
  { key: 'plan.option.approve', approved: true },
  { key: 'plan.option.rejectWithFeedback', approved: false, requiresFeedback: true },
  { key: 'plan.option.reject', approved: false },
];

/**
 * 计划框渲染行数。与下方组件的 JSX 结构一一对应，改渲染必须同步改这里
 * （tests/tui/planBox.test.tsx 用真实渲染帧行数校验，漏改会失败）。
 *
 * 结构：marginTop 1 + 上下边框 2 + 标题（折行）+ 正文（markdown 测量）
 *       + 选项各 1 行（折行）+ 底部提示（折行）。
 * feedback 模式下选项行变成输入行，行数不变（同为每项 1 行）。
 *
 * width 为终端总宽；内宽扣掉边框 2 + paddingX 2 = 4 列。
 */
export function planBoxRows(plan: string, width?: number): number {
  const inner = width === undefined ? undefined : Math.max(1, width - 4);
  const optionRows = OPTIONS.reduce((n, o) => n + wrappedRows(t(o.key), inner), 0);
  return (
    1 + // marginTop
    2 + // 上下边框
    wrappedRows(t('app.plan.readyTitle'), inner) +
    measureMarkdownRows(plan, inner) +
    optionRows +
    wrappedRows(t('plan.hint'), inner)
  );
}

export function PlanBox({
  plan,
  onResolve,
  termWidth,
}: {
  plan: string;
  onResolve: PlanResolve;
  termWidth?: number;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');

  // 弹层内宽：边框 2 + paddingX 2 = 4。传给 Markdown 让表格按此宽度分配列宽，
  // 传错会让表格算错列宽从而溢出边框。口径与 planBoxRows 一致。
  const innerWidth = termWidth === undefined ? undefined : Math.max(1, termWidth - 4);

  /** 选中「拒绝并说明」并进入反馈输入。 */
  const enterFeedback = (): void => {
    setSelected(OPTIONS.findIndex((o) => o.requiresFeedback === true));
    setFeedbackMode(true);
  };

  const submit = (opt: PlanOption): void => {
    if (opt.requiresFeedback === true) enterFeedback();
    else onResolve(opt.approved);
  };

  useInput((input, key) => {
    // Esc 任何时刻直接拒绝（不带反馈），与 ApprovalPrompt 的 Esc 语义一致
    if (key.escape) {
      onResolve(false);
      return;
    }
    if (feedbackMode) {
      // 方向键退出反馈输入并移动选中（与 ApprovalPrompt 同）
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
        // 约定：空反馈等同普通拒绝，传 undefined 而非空串
        const text = feedbackText.trim();
        onResolve(false, text === '' ? undefined : text);
        return;
      }
      if (key.backspace || key.delete) {
        setFeedbackText((s) => s.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input !== '') setFeedbackText((s) => s + input);
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
      submit(OPTIONS[selected]!);
      return;
    }
    // 数字键直选
    if (/^[1-3]$/.test(input)) {
      submit(OPTIONS[Number(input) - 1]!);
      return;
    }
    // 字母键保留原有肌肉记忆：y 批准、n 拒绝、f 进反馈
    if (input === 'y') onResolve(true);
    else if (input === 'n') onResolve(false);
    else if (input === 'f') enterFeedback();
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>
        {t('app.plan.readyTitle')}
      </Text>
      <Markdown text={plan} width={innerWidth} />
      {OPTIONS.map((opt, i) => {
        const active = i === selected;
        const inFeedback = feedbackMode && opt.requiresFeedback === true;
        return (
          <Text key={opt.key} color={active ? 'green' : undefined} bold={active}>
            {active ? '→ ' : '  '}
            {`[${i + 1}] `}
            {t(opt.key)}
            {inFeedback ? `：${feedbackText}▌` : ''}
          </Text>
        );
      })}
      <Text color="gray">{t('plan.hint')}</Text>
    </Box>
  );
}
