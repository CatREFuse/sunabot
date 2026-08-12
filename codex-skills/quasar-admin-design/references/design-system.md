# Quasar FE Design System

## Contents

- Source map
- Visual character
- Color hierarchy
- Borders and shadows
- Radius and spacing
- Typography
- Icons and brand marks
- Responsive behavior

## Source Map

The canonical implementation was inspected in `/Users/tanshow/Developer/quasar_fe` and compared with `https://quasar.catrefuse.com/`.

Primary source files:

- `src/index.css`: light/dark surfaces and text hierarchy
- `src/App.vue`: global typography, declared accent, watermark, and route transition selection
- `src/components/SearchBar.vue`: 56px field, 0.5px border, 16px radius
- `src/components/EngineListLabel.vue`: chip geometry and active treatment
- `src/views/Preference.vue`: 24px surface radius, 32px desktop padding, and grouped settings
- `src/widgets/multi-toggle.vue`: segmented control geometry
- `src/widgets/dot-cursor.vue`: cursor shapes, blend mode, velocity stretch, and easing
- `src/css/transition.scss`: route direction, travel, duration, and easing
- `src/widgets/tooltip.vue`: tooltip material
- `src/widgets/box-icon.vue`: Boxicons sizing ladder

## Visual Character

Use a soft zinc canvas with a brighter overlay, a large low-contrast identity watermark, bold primary labels, and one clean blue selection color. Keep depth concentrated in the primary overlay; routine chips remain flat until hover. Let generous whitespace and rounded geometry carry the personality.

## Color Hierarchy

### Light

| Role | Value | Typical use |
| --- | --- | --- |
| Canvas | `#f4f4f5` / zinc-100 | Page background |
| Overlay | `#ffffff` | Search field and primary surface |
| Raised control | `#f4f4f5` / zinc-100 | Segmented control track |
| Main text | `#27272a` / zinc-800 | Titles, values, input text |
| Secondary text | `#71717a` / zinc-500 | Descriptions and metadata |
| Tertiary text | `#a1a1aa` / zinc-400 | Disabled and low-priority text |
| Accent | `#3b82f6` / blue-500 | Selected chip, segment, execution |
| Field border | `#e4e4e7` / zinc-200 | Search field only |
| Watermark | `#e4e4e7` at low opacity | Identity background |

### Dark

| Role | Value | Typical use |
| --- | --- | --- |
| Canvas | `#18181b` / zinc-900 | Page background |
| Overlay | `#27272a` / zinc-800 | Search field and primary surface |
| Raised control | `#3f3f46` / zinc-700 | Segmented control track |
| Main text | `#ffffff` | Titles, values, input text |
| Secondary text | `#a1a1aa` / zinc-400 | Descriptions and metadata |
| Tertiary text | `#52525b` / zinc-600 | Disabled and low-priority text |
| Accent | `#3b82f6` / blue-500 | Selected chip, segment, execution |
| Field border | `#3f3f46` / zinc-700 | Search field only |
| Watermark | `#27272a` at low opacity | Identity background |

The source declares `#4994ec` as an accent variable, while visible controls use Tailwind blue-500 (`#3b82f6`). Prefer the rendered blue-500 value for fidelity.

## Borders and Shadows

- Keep most chips and surfaces borderless.
- Use `0.5px solid` only on search-like fields: zinc-200 in light, zinc-700 in dark.
- Use `1px` neutral dividers between settings groups.
- Use the main depth shadow only on the large overlay: `0 25px 50px -12px rgb(0 0 0 / 25%)`.
- Apply the same shadow to a sticky search field only after it reaches the viewport edge.
- Use `drop-shadow(0 16px 32px rgb(0 0 0 / 16%))` for a floating tooltip.
- Avoid decorative outlines around every region.

## Radius and Spacing

| Element | Radius |
| --- | --- |
| Primary settings surface | 24px |
| Search field and action chip | 16px |
| Segmented control container | 12px |
| Selected segment and tooltip | 8px |
| Caret cursor | 2px |
| Dot, ring, and switch pills | Full |

Use an 8pt grid with 4px exceptions:

- primary desktop padding: 32px
- primary mobile padding: 20px horizontal and 24px vertical
- group gap: 24px
- search inner gap: 8px
- search padding: 16px left, 8px right
- chip gap: 8px
- chip horizontal padding: 16px
- segmented padding and gap: 6px
- selected segment padding: 4px 8px
- action chip height: 44px mobile, 48px desktop
- search height: 56px

## Typography

The source stack is `Avenir, "Pingfang SC", Helvetica, sans-serif`.

Use these weight roles:

- 700: brand, search input, chip label, primary group heading
- 500: selected segmented option and utility emphasis
- 400: settings labels and body copy

Use 16px for primary UI text, 14px for controls, and 12px for secondary descriptions. In an established application, preserve its current interface font and reproduce the size, weight, and spacing hierarchy.

## Icons and Brand Marks

- Use Boxicons for navigation, settings, arrows, labs, and routine interface actions.
- Use the source size ladder: 16px, 20px, 24px, 32px, 48px, 64px.
- Use 24px for routine controls and 32px for primary arrow actions.
- Keep interface icons monochrome and inherit text color.
- Use original SVGs for product and service logos.
- Preserve multicolor service logos. For monochrome marks, use a white variant or a controlled brightness/invert filter in dark mode.
- Keep icon containers square, centered, and overflow-hidden.
- Do not use color dots as a status language.

## Responsive Behavior

- Center the main content around 512-764px on desktop; expand only when the operational content needs more columns.
- Use twelve-column or grid alignment for the outer canvas, but keep the dominant work surface visually singular.
- Reduce brand width from about 240px desktop to 160px mobile.
- Wrap chips naturally with 12-16px gaps.
- Hide the custom cursor on coarse pointers.
- Move fixed footer metadata out of the primary mobile viewport.
- Keep touch targets at least 44px.
