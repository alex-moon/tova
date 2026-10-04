# Plan — #219 UI tweaks

## Motivation

Issue [#219](https://github.com/alex-moon/tova/issues/219) reports four UI problems:

1. **Admin models view — recent endpoint errors**: the "Last message" cell holds long error
   text inline, so rows grow absurdly tall (especially on mobile). The error text should live
   in a separate, expandable cell below the main row.
2. **Files view — preview on mobile**: the master/detail layout stays side-by-side on narrow
   screens, so the preview pane is squeezed off-screen. It should slide over the list on mobile
   with a back button.
3. **Files view — dropzone click target**: only the small "choose files" link opens the picker.
   The whole dropzone should be clickable.
4. **Files view — dropzone disabled after upload**: once upload rows are present, the dropzone
   prompt (and its click affordance) disappears, so a second upload cannot be started by clicking.

## Decisions

- **Errors table**: turn the "Last message" column into a per-row expandable detail. Use a
  details/summary-style toggle button in the row; the message renders in its own full-width
  sub-row so it no longer forces row height. Keep source data and test ids intact.
- **Mobile preview**: use the existing Tailwind breakpoint approach (no new hook). At `md` and
  above keep master/detail; below `md`, show the list full width and, when a file is selected,
  overlay the preview as a slide-over with a back button that clears `selected`.
- **Dropzone**: make the whole box a clickable element (button/role), keep the file `input`
  hidden and driven by ref. Wire the existing `onDrop` too.
- **Re-enable after upload**: upload rows are informational; always render the clickable prompt
  (or keep the box clickable) so another upload can begin immediately.

## Done

- [x] Admin errors: expandable error-message cell
- [x] Files: mobile slide-over preview with back button
- [x] Files: whole dropzone clickable
- [x] Files: dropzone stays clickable after upload
- [x] Playwright mobile verification
- [x] `npm run ci` green

## Follow-ups

- None yet.
