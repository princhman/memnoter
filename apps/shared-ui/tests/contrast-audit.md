# Shared UI contrast audit

## Dark palette revision

Deepened surfaces and reduced bright text/accent tokens while preserving the previous pass's readable text, highlight hues, selection ink, and meaningful state indicators. Inputs and outline buttons retain their muted fill, slightly lighter than dialogs. The unchecked switch uses a dedicated `--switch-track: oklch(0.60 0 0)` rather than the decorative input-border token, preserving its previous light-theme appearance and dimming the dark track.

Light theme changes only: `--border` `oklch(0.64 0 0)` → `oklch(0.922 0 0)`; `--input` `oklch(0.60 0 0)` → `oklch(0.922 0 0)`.

Dark tokens (before means the preceding uncommitted contrast pass):

| Token | Before | After |
| --- | --- | --- |
| `--background` | `#191919` | `#111111` |
| `--link` | `oklch(0.84 0.08 277)` | `oklch(0.73 0.08 277)` |
| `--foreground` | `oklch(0.985 0 0)` | `oklch(0.90 0 0)` |
| `--card` | `oklch(0.205 0 0)` | `oklch(0.18 0 0)` |
| `--card-foreground` | `oklch(0.985 0 0)` | `oklch(0.90 0 0)` |
| `--popover` | `oklch(0.26 0 0)` | `oklch(0.23 0 0)` |
| `--popover-foreground` | `oklch(0.985 0 0)` | `oklch(0.90 0 0)` |
| `--secondary` | `oklch(0.274 0.006 286.033)` | `oklch(0.25 0.006 286.033)` |
| `--secondary-foreground` | `oklch(0.985 0 0)` | `oklch(0.90 0 0)` |
| `--muted` | `oklch(0.269 0 0)` | `oklch(0.25 0 0)` |
| `--muted-foreground` | `oklch(0.76 0 0)` | `oklch(0.72 0 0)` |
| `--accent` | `oklch(0.31 0 0)` | `oklch(0.28 0 0)` |
| `--accent-foreground` | `oklch(0.985 0 0)` | `oklch(0.90 0 0)` |
| `--destructive` | `oklch(0.82 0.10 22.216)` | `oklch(0.77 0.10 22.216)` |
| `--border` | `oklch(0.65 0 0)` | `oklch(1 0 0 / 10%)` |
| `--input` | `oklch(0.68 0 0)` | `oklch(1 0 0 / 15%)` |
| `--sidebar` | `#202020` | `#171717` |
| `--sidebar-foreground` | `oklch(0.985 0 0)` | `oklch(0.90 0 0)` |
| `--sidebar-primary` | `oklch(0.80 0.10 277.117)` | `oklch(0.69 0.10 277.117)` |
| `--sidebar-accent` | `oklch(0.269 0 0)` | `oklch(0.25 0 0)` |
| `--sidebar-accent-foreground` | `oklch(0.985 0 0)` | `oklch(0.90 0 0)` |

Resolved sRGB: body `#fafafa` → `#dedede`, muted `#b1b1b1` → `#a4a4a4`, link `#bdc6ff` → `#9ba4da`. Page `#191919` → `#111111`, sidebar `#202020` → `#171717`, dialog/popover `#242424` → `#1d1d1d`.

## Rendered ratios

Before → after, measured by WebKit after compositing. Highlight+link ranges cover all five persisted highlight hues on each surface.

| Dark surface | Body | Muted | Link | Highlight+link |
| --- | --- | --- | --- | --- |
| Page | 16.84 → 14.04 | 8.20 → 7.58 | 10.62 → 7.84 | 7.34–7.84 → 5.25–5.60 |
| Sidebar | 15.61 → 13.33 | 7.60 → 7.19 | 9.84 → 7.44 | 7.08–7.57 → 5.10–5.44 |
| Dialog/popover | 14.87 → 12.53 | 7.24 → 6.76 | 9.38 → 7.00 | 6.93–7.41 → 4.94–5.28 |

## Regression contract

Production CSS and literal TSX color recipes are rendered in Playwright WebKit through Vite on seven surfaces, including normal/hover/focus/focus-visible states. The matrix covers five highlight hues, selection nesting, selected cells, headings, code, math, clozes, and the actual editor DOM. Real shared Input, outline Button, and checked/unchecked Switch components supplement the matrix; switch thumbs and tracks are measured separately.

Text remains ≥4.5:1 (large text ≥3:1). Focus rings, control accents, rail dashes, and both switch states retain ≥3:1. Decorative dividers, borders, and input outlines no longer require 3:1: WCAG 1.4.11 does not require those outlines when a control is identifiable otherwise through its fill/label. Inactive controls remain the only text exemption. Image pixels, gradients, and unmodelled sibling overlays remain outside the ancestor-compositing contract.

The limiting muted sample is yellow-highlighted cloze content at 4.51:1; yellow-highlighted selected table headers reach 4.58:1. Dark switch tracks/thumbs reach at least 4.27:1. No text checks were dropped.

## Validation

- Focused contrast test: PASS, 9,262 rendered samples, zero failures.
- Full `npm test`: FAIL, 247 passed / 13 failed. Failures span folder-import (2), import-integration (8), outline-refresh (1), search-integration (1), and text-selection (1). The failed search process was terminated after it kept retrying IPC calls against cleared mocks; the runner then exited 1. Contrast passed within the full run.
- `npm run build`: FAIL in concurrently edited `src/lib/markdown-paste.ts:147,154` (TS2345, `string | number` passed to `string`); no out-of-scope repair attempted.
- `git diff --check`: PASS.

Reproduce from `apps/shared-ui`: `CONTRAST_REPORT=/tmp/contrast.json node --experimental-strip-types --test tests/contrast.test.mjs`, `npm test`, `npm run build`.

Only App.css theme tokens, the generic Switch, and contrast test/fixture/report files were edited in this revision. Existing component/selection fixes and concurrent folder-import work were preserved. No commits, branches, or worktrees were created.
