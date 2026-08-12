---
name: quasar-admin-design
description: Reproduce the Quasar FE visual language in Vue, Tailwind, or CSS interfaces, especially Sunabot admin pages. Use for Quasar-inspired light/dark color tokens, zinc surface hierarchy, thin borders, rounded controls, Boxicons, search and chip layouts, segmented toggles, elastic difference-blend cursors, directional route transitions, responsive adaptation, and visual validation.
---

# Quasar Admin Design

Build a restrained operational interface from the Quasar FE design language while preserving the target product's semantics, accessibility, and existing architecture.

## Workflow

1. Inspect the target page, its global tokens, layout shell, component conventions, responsive breakpoints, and current tests.
2. Read [references/design-system.md](references/design-system.md) before choosing colors, radii, spacing, typography, borders, shadows, or icons.
3. Read [references/motion-and-components.md](references/motion-and-components.md) before implementing the cursor, route motion, segmented toggles, search controls, chips, settings rows, or tooltips.
4. Read [references/sunabot-integration.md](references/sunabot-integration.md) when working in Sunabot.
5. Define a visual thesis, content plan, and interaction thesis before editing UI code.
6. Scope Quasar tokens to the new surface. Do not silently replace an established product-wide theme.
7. Implement the smallest complete component set. Prefer semantic buttons, links, labels, inputs, sections, and headings.
8. Add light, dark, mobile, keyboard, reduced-motion, and click-outside behavior where relevant.
9. Run type checks, focused tests, production build, and screenshot validation at the target project's required viewports.

## Composition Rules

- Use one calm gray canvas, one dominant content column, and one purposeful identity watermark or illustration.
- Use blue only for active selection and primary execution. Keep routine status and structure neutral.
- Prefer one large surface or cardless sections with dividers. Do not create nested card mosaics.
- Keep the first working viewport operational: search, navigation, state, and actions should appear before explanatory copy.
- Use short interface labels that state names, states, actions, and results.
- Preserve the target product's existing font unless the task explicitly requests an identity redesign.
- Reuse Boxicons for interface glyphs and original product SVGs for third-party brand marks. Do not approximate brand marks with generic glyphs.

## Token Bootstrap

Copy or adapt [assets/quasar-admin-tokens.css](assets/quasar-admin-tokens.css) into the target's local stylesheet. Rename the scope class when necessary and map only the tokens the page uses.

Keep the canonical ladder:

- surface radius: 24px
- field and chip radius: 16px
- segmented container radius: 12px
- selected segment and tooltip radius: 8px
- desktop surface padding: 32px
- mobile surface padding: 20px 24px
- field border: 0.5px
- section divider: 1px
- action height: 44-48px

## Interaction Rules

- Make the custom cursor an enhancement for fine pointers. Disable it for coarse pointers and reduced motion.
- Change the cursor shape by affordance: dot for canvas, ring for actions, caret for editable text.
- Use directional route motion: deeper routes enter from the right; shallower routes enter from the left.
- Keep route travel near 120px and duration near 125ms. Use opacity with translation.
- Use 6px padding and 6px gaps in segmented controls. Keep selected segments 8px radius with a blue fill.
- Keep hover motion short and visible without shifting surrounding layout.

## Delivery Gate

- Confirm there is no horizontal overflow at the required viewport matrix.
- Confirm light and dark themes preserve surface separation and readable contrast.
- Confirm every custom interactive element has a semantic role, accessible name, keyboard focus, and disabled state.
- Confirm reduced motion removes nonessential animation without hiding content.
- Confirm popup menus close on outside click and Escape.
- Confirm source extraction remains a design reference; do not copy unrelated business logic, content, tracking, or external service calls.
