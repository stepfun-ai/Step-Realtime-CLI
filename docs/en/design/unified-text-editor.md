# Unified Single-Line Text Editor (TextEditField)

> Design decision record. Rule: **all single-line text inputs in this repo must use
> `src/tui/TextEditField.tsx`, except for the exemptions listed below.** Before adding
> a new input, check whether this component fits; if it genuinely cannot, add an
> exemption entry here with the rationale first — only then is a bespoke implementation
> allowed.

## Background

Before unification, single-line inputs fell into three tiers:

1. **The main `PromptInput`**: full-featured (edit keys, cursor, paste folding);
2. **Three copies sharing the `promptEdit` kernel**: `QuestionPrompt`'s Other input,
   `FirstRunSetup`'s EditableInput, `ProviderWizard`'s text steps — same kernel, but
   key dispatch and inverse-cursor rendering hand-written three times;
3. **Primitive search boxes**: `ModelPicker` / `SkillPicker` / `SessionPicker`
   (search + rename) / `ProviderWizard` pick step — append-only with backspace-at-end,
   no cursor, no edit keys.

Tier 3 was a user-visible defect (one typo meant deleting the whole query), and the
three copies were a maintenance hazard — fixes had already drifted between them.

## Component Contract

`TextEditField` provides:

- Controlled value `{ text, cursor }` (cursor in code points), value-style `onChange`;
- Full edit-key set via `promptEdit` (←→/Home/End/Ctrl+←→/Ctrl+W/U/K/Backspace/Delete);
- Single-line semantics: all `\r`/`\n` stripped before insertion (pasted keys/URLs
  would otherwise break TOML parsing — a historical FirstRunSetup bug);
- Bracketed-paste bulk insertion;
- Inverse-cursor rendering (empty text shows an inverse space; the placeholder's
  first CJK glyph is never inversed — it becomes unreadable);
- `onInterceptKey` parent hook: returning true skips built-in editing for that key.

### Key Ownership Rules

Ink input events are **broadcast**: every active `useInput` handler receives the same
keypress — there is no stopPropagation. Therefore:

- `TextEditField` never consumes Enter/Esc/↑↓/Tab — they belong to the parent;
- When a parent needs an edit key for itself (SessionPicker's Delete-to-delete,
  `r`-to-rename, QuestionPrompt's ←→ question switching), it **must** go through
  `onInterceptKey`. Handling it in a parallel `useInput` would double-process the key.

### Same-Tick Value Consistency

Internally the component mirrors the latest value in `valueRef` with optimistic
write-back: keypresses arriving within the same macrotask (fast typing, consecutive
`stdin.write` in tests) run before React's batched flush, and a value-style `onChange`
reading a stale props closure would drop characters — the same class of bug as
PromptInput's `selfChangeRef`. All handlers (keys/paste) read from the ref and
write back immediately after emitting.

## Migrated Inputs

| Location | Notes |
|---|---|
| `QuestionPrompt` Other free text | — |
| `ProviderWizard` text steps (id/baseUrl/apiKey/…) | — |
| `ProviderWizard` pick-step search | Formerly tier 3 |
| `FirstRunSetup` EditableInput | Shell (title/hint/border) kept, kernel replaced |
| `ModelPicker` search | Formerly tier 3 |
| `SkillPicker` search | Formerly tier 3 |
| `SessionPicker` search | Formerly tier 3; Delete/Ctrl+D and `r` via onInterceptKey |
| `SessionPicker` rename draft | Formerly tier 3 |

## Exemptions and Rationale

### 1. `PromptInput` (main input) — component-level exemption; kernel already shared

- **Multi-line editing**: pasted text may contain `\n`, rendered per-line with line
  height feeding the dynamic-frame budget (`computePromptRows`); `TextEditField` is
  single-line by design;
- **Deeply coupled key dispatch**: slash-menu completion, history navigation, queue
  recall, and paste folding form a linear priority chain with text editing — splitting
  the editor out would push this chain across component boundaries;
- **No duplicated kernel**: editing actions already come from `promptEdit.ts`, and the
  inverse-cursor rendering follows the same idiom, so there is no drift to eliminate.

Re-evaluate if `TextEditField` ever gains multi-line support.

### 2. Single-key confirmations (y/n, approvals) — not text input

`ApprovalPrompt`, SessionPicker delete confirmation, etc. recognize single keys and
produce no editable text.

### 3. List navigation (↑↓/Enter) — not text input

Picker list movement and tab switching are navigation, owned by each component.

中文版：[../../../zh/design/unified-text-editor.md](../../../zh/design/unified-text-editor.md)
