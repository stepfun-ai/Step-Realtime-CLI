import { Box, Text } from 'ink';
import { useRef } from 'react';
import { useSpinnerFrame, BRAILLE_FRAMES } from './useSpinnerFrame.js';
import { pickWorkingVerb, pickRandomTip } from './workingTips.js';
import { formatElapsed } from './elapsed.js';
import { t } from '../i18n.js';

/**
 * 忙碌态状态行（独立块，挂在输入框正上方）：
 *
 *   ⠋ 处理中… (12s · ↓ 585 tokens)
 *   · 提示：↑/↓ 回溯输入历史
 *
 * 状态词不声称「思考」（见 workingTips 的 WORKING_VERBS 注释）：思考态由上方 ThinkingPreview
 * 的「思考中…」标题表达，只在真的收到 thinking_start 后出现。
 *
 * 设计要点（消除旧版「spinner 与文字挤在输入框行内、换帧时文字抖动」）：
 * - spinner 独占行、与输入框分离（column 布局 + marginTop），换帧不挤压其他元素。
 * - glyph 用固定宽度容器（Box width={2}）包住，braille 帧渲染宽度差异不推移右侧文字。
 * - 状态词 mount 时随机取一次、整轮固定（useRef 存），不随帧变、不闪。
 * - 帧、elapsed、token 全在 useSpinnerFrame 触发的同一次 re-render 里派生，不各刷各的。
 * - elapsed 由 startedAt 现算（useSpinnerFrame 每 80ms 重渲带动秒级刷新）；token 为本轮 output 估算。
 *
 * 只在 busy 时挂载（App 侧条件渲染），active 恒为 true → spinner 起 80ms 时钟。
 */
export function WorkingStatus({
  startedAt,
  outputTokens,
}: {
  /** 本回合忙碌起始时间戳（App 在 busy 上升沿设）。 */
  startedAt: number;
  /** 本轮已产出的 output token（估算，0 时不显示 token 段）。 */
  outputTokens: number;
}): React.ReactElement {
  const frame = useSpinnerFrame(true, BRAILLE_FRAMES);
  // 状态词与 tip mount 时各取一次、整轮固定（useRef 惰性初始化，不随重渲变）
  const verbRef = useRef<string>('');
  if (verbRef.current === '') verbRef.current = pickWorkingVerb();
  const tipRef = useRef<string>('');
  if (tipRef.current === '') tipRef.current = pickRandomTip();

  const elapsed = formatElapsed(Date.now() - startedAt);
  // 括号内字段用 ' · ' 分隔：elapsed 恒显示；token > 0 才显示
  const parts = [elapsed];
  if (outputTokens > 0) parts.push(t('workingStatus.tokens', { count: outputTokens }));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {/* glyph 定宽 2 列：帧渲染宽度差异不推移右侧文字 */}
        <Box width={2}>
          <Text color="yellow">{frame}</Text>
        </Box>
        <Text wrap="truncate">
          <Text color="yellow" bold>{`${verbRef.current}…`}</Text>
          <Text color="gray">{` (${parts.join(' · ')})`}</Text>
        </Text>
      </Box>
      {tipRef.current !== '' ? (
        <Text color="gray" wrap="truncate">
          {t('input.tipPrefix', { tip: tipRef.current })}
        </Text>
      ) : null}
    </Box>
  );
}
