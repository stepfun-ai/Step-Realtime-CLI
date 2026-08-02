import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { t } from '../i18n.js';

/** 渠道管理面板的单行数据（由 App 从 [providers] + 内置预设的合并视图装配）。 */
export interface ProviderManagerRow {
  /** 渠道 id（自定义渠道或内置预设名）。 */
  id: string;
  /** 协议类型（自定义渠道取 type；预设行取预设的 protocol）。 */
  type: string;
  baseUrl?: string;
  /** 归属别名数（config.models 中 entry.provider === id 的条目数）。 */
  aliasCount: number;
  /** 内置预设独有行（自定义渠道与预设同名时遮蔽预设，该行不出现）。 */
  builtin: boolean;
  /** 是否当前生效渠道（行尾 ← 当前 标记）。 */
  current: boolean;
}

/** 每页展示的行数（含末尾 CTA 行，对齐 ModelPicker/SessionPicker 分页惯例）。 */
const PAGE_SIZE = 10;

/**
 * /provider 无参唤起的渠道管理面板（替换输入区的弹层，同 ModelPicker 挂载模式）。
 * 列表 = config [providers] 自定义渠道 + 内置预设的合并视图，末尾固定一行 CTA「+ 新增渠道」。
 * 键位：↑↓ 移动（clamp 不循环）；Enter 渠道行=切换、CTA 行=新增；A=新增；
 * D=删除（仅自定义渠道，先进入内联 [y/N] 确认子状态，确认期间只响应 y/n/Esc，
 * 提示语替换 footer；预设行给不可删提示）；Esc 确认态下先退出确认、否则关闭。
 * 组件自持 useInput；宿主（App）在面板打开期间让出全部按键。
 * 切换/删除的实际语义（别名解析、预设重建、落盘摘除）都在 App 侧回调里完成。
 */
export function ProviderManager({
  rows,
  onSwitch,
  onAdd,
  onDelete,
  onClose,
}: {
  rows: ProviderManagerRow[];
  /** Enter 命中渠道行：id + 是否内置预设行（自定义/预设的切换语义由 App 决定）。 */
  onSwitch: (id: string, builtin: boolean) => void;
  /** Enter 命中 CTA 行或按 A：进入新增向导（App 开 ProviderWizard）。 */
  onAdd: () => void;
  /** 删除确认子状态中按 y：App 走 removeProviderConfig 落盘摘除。 */
  onDelete: (id: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [sel, setSel] = useState(0);
  // 删除确认子状态：待删渠道 id；非 null 时只响应 y/n/Esc
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 行内提示（预设行不可删等），下一次任意按键清除
  const [notice, setNotice] = useState<string | null>(null);

  // 末尾固定 CTA 行：总行数 = 渠道行 + 1
  const total = rows.length + 1;
  const clampedSel = Math.min(sel, Math.max(total - 1, 0));
  const pageStart = Math.floor(clampedSel / PAGE_SIZE) * PAGE_SIZE;
  const pageRows = rows.slice(pageStart, Math.min(pageStart + PAGE_SIZE, rows.length));
  // CTA 行下标 = rows.length，落在当前页窗口内才渲染
  const ctaOnPage = rows.length >= pageStart && rows.length < pageStart + PAGE_SIZE;
  const confirmRow = confirmId !== null ? rows.find((r) => r.id === confirmId) : undefined;

  useInput((input, key) => {
    // 删除确认子状态：只认 y / n / Esc，其余按键忽略（防误删）
    if (confirmId !== null) {
      if (input === 'y' || input === 'Y') {
        const id = confirmId;
        setConfirmId(null);
        onDelete(id);
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setConfirmId(null);
        return;
      }
      return;
    }
    if (notice !== null) setNotice(null);
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      const row = rows[clampedSel];
      if (row === undefined) {
        onAdd();
      } else {
        onSwitch(row.id, row.builtin);
      }
      return;
    }
    // ↑↓ clamp 移动：越界停住不循环
    if (key.upArrow) {
      setSel((i) => Math.max(i - 1, 0));
      return;
    }
    if (key.downArrow) {
      setSel((i) => Math.min(i + 1, total - 1));
      return;
    }
    if (input === 'a' || input === 'A') {
      onAdd();
      return;
    }
    if (input === 'd' || input === 'D') {
      const row = rows[clampedSel];
      if (row === undefined) return; // CTA 行无删除对象
      if (row.builtin) {
        setNotice(t('providerManager.cannotDeleteBuiltin'));
        return;
      }
      setConfirmId(row.id);
      return;
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t('providerManager.title')}
      </Text>
      {pageRows.map((r, i) => {
        const active = pageStart + i === clampedSel;
        return (
          <Text key={r.id} color={active ? 'cyan' : 'white'} inverse={active}>
            {active ? '› ' : '  '}
            {r.id}
            {'  '}
            <Text color="gray">
              type={r.type} · {r.baseUrl ?? t('app.provider.noBaseUrl')} ·{' '}
              {t('providerManager.aliasCount', { count: r.aliasCount })}
              {r.builtin ? ` · ${t('providerManager.builtinTag')}` : ''}
            </Text>
            {r.current ? <Text color="green">{` ${t('providerManager.current')}`}</Text> : null}
          </Text>
        );
      })}
      {ctaOnPage && (
        <Text color={clampedSel >= rows.length ? 'cyan' : 'white'} inverse={clampedSel >= rows.length}>
          {clampedSel >= rows.length ? '› ' : '  '}
          {t('providerManager.cta')}
        </Text>
      )}
      {total > PAGE_SIZE && (
        <Text color="gray">
          {t('sessionPicker.pageInfo', {
            start: pageStart + 1,
            end: Math.min(pageStart + PAGE_SIZE, total),
            total,
          })}
        </Text>
      )}
      {confirmId !== null ? (
        <Text color="red">
          {t('providerManager.deleteConfirm', { id: confirmId, count: confirmRow?.aliasCount ?? 0 })}
        </Text>
      ) : notice !== null ? (
        <Text color="yellow">{notice}</Text>
      ) : (
        <Text color="gray">{t('providerManager.hint')}</Text>
      )}
    </Box>
  );
}
