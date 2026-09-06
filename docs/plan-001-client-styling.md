# Plan — Client styling migration (Tailwind v4 + shadcn/ui)

## Motivation

The client mixed inline styles, `styles/*.css` utility classes, and ad-hoc component CSS.
Icon/text vertical alignment inside buttons was fragile and hard to debug because styles
were repeatedly overwritten at different layers. A utility-first layer with a proper
component primitive library removes the override ambiguity and gives consistent,
center-aligned buttons by construction (`[&_svg:size-4]` + fixed button height).

## Decisions

- **Tailwind v4** via `@tailwindcss/vite` (no tailwind.config; theme lives in CSS).
- **shadcn/ui (new-york)** primitives, vendored under `src/client/src/components/ui/`
  (`Button`, `Input`, `Card`). Aliases `@/*` wired in `vite.config.ts` and both
  `tsconfig*.json`. `components.json` is present so `shadcn add <component>` works.
- **Fonts** (self-hosted via Fontsource, no Mac/system font dependence):
  - Headings: Raleway (`@fontsource-variable/raleway`)
  - Body: Roboto (`@fontsource-variable/roboto`)
  - Mono/code: JetBrains Mono (`@fontsource-variable/jetbrains-mono`)
- **Theme tokens** live in `src/client/src/index.css` (`@theme` + dark-mode
  `prefers-color-scheme` overrides). The old `styles/variables|base|components.css`
  were removed; only segment-specific CSS remains (`.markdown-body` in `index.css`).

## Done

- Tailwind v4 + Vite plugin installed and configured.
- `Sidebar`, `ChatWindow`, `Login`, `App` rewritten with Tailwind/shadcn utilities;
  all inline styles removed.
- shadcn `Button` (with `variant`/`size`), `Input`, `Card` primitives added.
- Login test updated expectation preserved (CardTitle renders an `h3`).

## Follow-ups (suggested GitHub issues)

- Add remaining shadcn primitives on demand (Dialog for delete confirmation, ScrollArea for chat).
- Consider class-variance-based chat bubble variants instead of ternaries in ChatWindow.
- The sidebar session row is still a plain button; make it a dedicated primitive if it repeats.
