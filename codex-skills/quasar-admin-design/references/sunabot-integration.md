# Sunabot Integration

## Read Before Editing

Read:

- `AGENTS.md`
- `docs/specs/index.md`
- `docs/specs/05-admin-console.md`
- `docs/specs/07-code-map.md`
- `docs/specs/08-validation.md`
- the target view, its composables, current UI components, and visual tests

Check `git status` before editing. Preserve unrelated worktree changes.

## Integration Boundary

- Keep the existing AppShell, authentication gate, navigation, theme persistence, fonts, and global color tokens unless the request explicitly changes them.
- Scope Quasar values under a feature root such as `.quasar-scope`.
- Reuse `useTheme()` for light, dark, and system behavior.
- Reuse Boxicons already loaded by `apps/admin-web/src/main.ts`.
- Keep operational data and API behavior separate from visual components.
- Add a route-level demo without changing existing pages when visual approval is still pending.
- Promote scoped tokens into `apps/admin-web/src/assets/main.css` only after explicit product approval.

## Component Placement

Place reusable visual pieces under:

```text
apps/admin-web/src/components/<feature>/
```

Keep page composition under:

```text
apps/admin-web/src/views/
```

Prefer:

- a dedicated cursor component
- a semantic segmented control
- a page-local token scope
- route-driven panel state

Avoid:

- copying Quasar's Pinia store
- copying its external search endpoint
- loading CSS or icons from a CDN
- hiding the native cursor outside the feature root
- replacing global Sunabot red semantics with blue
- using blue for health, error, warning, or success status

## Copy Rules

Use final product copy only. Keep visible text to names, states, actions, and results. Do not expose design notes, source explanations, token descriptions, implementation details, or test labels in the UI.

## Validation

Run at minimum:

```bash
npx vitest run <focused-test>
npm run check
npm run build:web
npm run test:visual
```

For a scoped demo, a focused visual spec may run before the full matrix. Inspect captured PNGs at 390, 768, 1440, and 1920 widths in both light and dark modes. Verify:

- no document, body, or page-shell horizontal overflow
- the AppShell and bottom navigation remain usable
- the large watermark does not reduce text contrast
- route controls remain visible and keyboard reachable
- segmented controls retain selected, focus, and disabled states
- custom cursor is absent on coarse pointers and reduced motion
- no console error comes from the new surface
