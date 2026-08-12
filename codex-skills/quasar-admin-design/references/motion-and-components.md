# Quasar Motion and Components

## Contents

- Elastic cursor
- Route transitions
- Segmented toggle
- Search field
- Action chips
- Settings surface
- Tooltip

## Elastic Cursor

Render a fixed 50px container with `pointer-events: none`, `will-change: transform`, and `mix-blend-mode: difference`. Center a white cursor shape inside it.

Use three shapes:

- dot: 15x15px circle
- action ring: 40x40px transparent circle with a 2px white border
- text caret: 4x24px with 2px radius

On pointer movement:

1. Track the physical target position.
2. In follow mode, interpolate the visual position toward the target. A factor around `0.18` per animation frame reproduces the soft lag without the source's interval timer.
3. Compute `dx`, `dy`, and `distance` between the physical and visual positions.
4. Set angle with `atan2(dy, dx)`.
5. Stretch the dot along the travel direction:

```ts
const stretch = clamp(
  Math.pow(distance / (follow ? 15 : 5), 0.25),
  1,
  2.5
);
const squash = Math.cbrt(1 / stretch);
```

6. Rotate by the angle, apply `scaleX(stretch)` and `scaleY(squash)`.
7. Shrink the dot to 10x10px while pressed.

Derive shape from the hovered semantic target:

- `input`, `textarea`, contenteditable: caret
- `button`, `a`, interactive role, explicit `data-cursor="action"`: ring
- canvas and noninteractive text: dot

Use the source easing `cubic-bezier(0.1, 0.28, 0.45, 0.75)` for shape changes. Disable the enhancement for `(pointer: coarse)` and `(prefers-reduced-motion: reduce)`. Keep the native cursor when the enhancement is disabled.

## Route Transitions

Assign a depth to each view. A deeper destination advances; a shallower destination returns.

Forward:

```css
.slide-forward-enter-from {
  opacity: 0;
  transform: translateX(120px);
}

.slide-forward-leave-to {
  opacity: 0;
  transform: translateX(-120px);
}
```

Back:

```css
.slide-back-enter-from {
  opacity: 0;
  transform: translateX(-120px);
}

.slide-back-leave-to {
  opacity: 0;
  transform: translateX(120px);
}
```

Use `125ms cubic-bezier(0.08, 0.58, 0.58, 1)` with `mode="out-in"`. Use a 350ms opacity fade when depth is unknown. Reduce the travel distance on narrow screens if 120px feels like a full-page swipe. Remove translation under reduced motion.

## Segmented Toggle

Structure:

- semantic group with an accessible name
- one button per option
- `aria-pressed` on the selected option
- explicit disabled state

Geometry:

- track: inline flex, 6px padding, 6px gap, 12px radius
- option: 4px vertical and 8-10px horizontal padding, 8px radius, 14px type
- selected: blue-500, white, weight 500
- idle: secondary or tertiary text, transparent background
- disabled group: 40% opacity and no pointer action

Do not animate layout. Animate background and color over 100-180ms.

## Search Field

Use a 56px inline-flex field with:

- 16px radius
- 0.5px neutral border
- 16px left and 8px right padding
- 8px inner gap
- 24px leading icon
- bold full-width input
- 32px arrow action

Keep the overlay and input backgrounds identical. Apply depth shadow only when sticky at the viewport edge.

## Action Chips

Use 44px mobile and 48px desktop height, 16px radius, 16px horizontal padding, and an 8px icon-label gap. Keep the selected chip blue and white. Keep idle chips on the overlay background. On hover, add the large surface shadow or a restrained `translateY(-1px)` without changing layout.

## Settings Surface

Use one 24px-radius overlay with 24px group gaps. Place back action left and title centered. Each setting is a plain flex row:

- title: 14-16px main text
- subtitle: 12px secondary text
- control aligned right

Use a single divider before a named experimental group. Keep the experimental heading as text plus a Boxicons flask glyph.

## Tooltip

Use white bold text on `rgb(0 0 0 / 60%)`, 8px radius, 4px backdrop blur, and the 16x32 shadow. Add an 8px CSS triangle. Provide the same information through accessible text or `aria-describedby`.
