# Plan — #191 Atmospheric depth: washes and edge glows

Branch: `feat/tv/191-volumetric-depth`

## Motivation

Issue #190 asks for volumetric depth across the UI. The original spec (Gemini)
was written without access to this codebase, so its concrete details (hexes,
"floating sidebar", "drop shadows") do not match Tova's actual design. The
owner's mockups (`mockups/Gemini_Generated_Image_*.jpg`) show the real intent,
and they are **not** about elevation/shadow:

- **Broad atmospheric gradient washes** over the flat background — a large,
  very soft, primary-tinted glow suffusing the central region (warm copper in
  one mockup, cool teal in the other; the hue is theme-ambient, the treatment
  is identical).
- **Sharp, tight glow rings around element borders** — a high-contrast "lit
  edge" hugging the composer and other key surfaces, sitting flush against the
  existing 1px border.
- **Surfaces stay flat and bordered.** The intentional light borders are
  preserved; nothing floats, nothing casts a drop shadow.

The distinction matters: an earlier attempt implemented shadows + subtle rims
and was visually invisible and wrong in kind. This plan targets light, not
elevation.

## Decisions

- **Depth = a three-layer light model** (owner steer), not elevation:

  | Layer | Treatment | Reads as |
  | --- | --- | --- |
  | **Chat column** | *Recessive* radial bloom + dark vignette + inset frame at top/bottom seams | volume / "room to fill", sunk *behind* the chrome |
  | **Solid panels** (sidebar, composer) | *Solidity* gradient — top-lit → bottom-shaded wash of the panel's own surface colour | physical slab you could tap |
  | **Interactive buttons** (Admin, New Chat) | Subtle edge glow, same family as the composer but lighter | lit control, nearer than the column |

  Sidebar is the calibration anchor: its current strength is the target; the
  chat column and composer are dialed *relative* to it.
- **Two gradient kinds, both token-driven:** `--c-wash` (recessive radial +
  vignette) and `--c-panel-surface` (solidity linear). Hue derives from
  `--c-primary` / the panel surface via `color-mix`; no raw hex in components.
- **Light borders are sacred** (owner steer): the base 1px `border-border`
  stays; glows are additive (box-shadow on top of the border).
- **Theme expression differs:** dark leans on glow + recession; light leans on
  soft shadow/vignette with a fainter bloom (a bright primary bloom is illegible
  on light). Both themes get the same three-layer *structure*.
- **Intensity knobs** for the final "volume down" pass: `--wash-strength` and
  `--edge-glow-strength` (currently turned up so the effect is visible while
  building; to be reduced to a subtle default at the end, holding the sidebar
  as the reference strength).

## Done

- [x] Token layer in `src/client/src/index.css`: knobs; per-theme `--c-wash`
      (recessive), `--c-panel-surface` (solidity), `--c-edge-glow`
- [x] Utilities: `.ambient-wash`, `.panel-surface`, `.recessed-frame`,
      `.edge-glow`, `.edge-glow-subtle`, `.edge-glow-strong`
- [x] Chat interface: column wash + recessed frame; composer solidity + strong
      edge glow; example chips edge glow; New Chat + Admin subtle edge glow
- [x] Sidebar: solidity gradient (calibration anchor)
- [ ] Light-theme calibration: vignette/bloom balanced for light (currently
      muddy; needs its own values)
- [ ] Final volume-down pass: reduce knobs to a subtle default, sidebar as ref
- [ ] Roll out: profile, admin, asset library, login
- [ ] Visual verification against `mockups/` in both themes via Playwright
- [ ] Theme test: wash/glow/panel tokens resolve per theme; light borders kept
- [ ] Gate: `npm run ci` green

## Open questions

- Whether profile/admin panels take the *solid* gradient or the *recessive*
  wash. Panels that are mostly interactive chrome should be solid; the admin
  content tables may be better recessive. Decide per surface during rollout.

## Follow-ups

- None; tuning stays in CSS variables (no user-facing settings surface).
