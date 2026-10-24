---
name: Tumbler admin
description: The one page a person uses to see and steer a secrets broker.
colors:
  ground: "#fafaf9"
  ink: "#1c1917"
  muted: "#78716c"
  rule: "#e7e5e4"
  edge: "#8f8984"
  teal: "#0f766e"
  amber: "#b45309"
  red: "#b91c1c"
  ground-dark: "#1c1917"
  ink-dark: "#f5f5f4"
  muted-dark: "#a8a29e"
  rule-dark: "#44403c"
  edge-dark: "#78716c"
  teal-dark: "#2dd4bf"
  amber-dark: "#f59e0b"
  red-dark: "#f87171"
typography:
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
  heading:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  column-label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
  mono:
    fontFamily: "ui-monospace, monospace"
    fontSize: "12px"
    lineHeight: 1.4
rounded:
  control: "6px"
  chip: "999px"
spacing:
  cell: "8px"
  gap: "8px"
  block: "12px"
  page: "16px"
  section: "40px"
components:
  button-primary:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.ground}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button:
    backgroundColor: "transparent"
    textColor: "{colors.teal}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.teal}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.teal}"
    rounded: "{rounded.chip}"
    padding: "2px 10px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
---

# Design System: Tumbler admin

## Overview

**Creative North Star: "The Quiet Ledger"**

The admin page is a ledger kept by a locksmith: rows of what exists, who holds it, and what happened,
on warm stone paper with one teal ink for the things you can act on. It is an Operate surface used
rarely and deliberately, so it earns trust through plainness and precision rather than expression.
Every name and date is legible at a glance; the only color that asks for attention is amber, and
amber means something needs you soon.

Density is a feature here. One page holds keys, grants, tokens and the audit trail, so the owner can
answer "what can reach what" without navigating. The ledger leads; the person-only actions sit one
disclosure away under the table they change. The page uses the platform's own sans and monospace,
which the CSP requires (no external resources can load) and which an Operate page permits.

**Key Characteristics:**
- Warm stone neutrals, one teal action color, amber for attention, red only on a destructive control
  under the pointer or focus.
- System sans for everything; monospace only for code, tokens and pasted `.env` text.
- Flat: depth comes from hairline rules, never shadows.
- Tables are the structure; on a phone each row becomes a labelled record.
- Every action says what it will do before, and what it did after.

## Colors

A restrained stone palette with a single accent, mirrored for dark mode by `prefers-color-scheme`.
The page declares `color-scheme: light dark`, so native controls (checkbox, date picker, select)
follow the theme, and `accent-color`, caret and selection come from teal.

### Primary
- **Ledger Teal** (`teal`, dark `teal-dark`): every actionable control (buttons, disclosures, nav
  links, focus rings). Never decoration.

### Secondary
- **Expiry Amber** (`amber`, dark `amber-dark`): something needs the owner soon: a key or token
  expiring within a week, an expired key (rotate it), import lines that overwrite or fail, the
  shown-once token box, the "replaces the value" note, a section that failed to load.
- **Delete Red** (`red`, dark `red-dark`): a Delete or Revoke control under the pointer or keyboard
  focus, and the status line when an action failed. Never at rest.

### Neutral
- **Stone Paper** (`ground`, dark `ground-dark`): the page ground.
- **Ink** (`ink`, dark `ink-dark`): body text and values.
- **Faded Ink** (`muted`, dark `muted-dark`): column labels, descriptions, hints, placeholders, ended
  rows, destructive controls at rest.
- **Hairline** (`rule`, dark `rule-dark`): table rules and section dividers.
- **Field Edge** (`edge`, dark `edge-dark`): the border of inputs and the status line; at least 3:1
  against the ground (3.3:1 light, 3.7:1 dark).

**The One Ink Rule.** Teal marks what can be clicked, and nothing else.

**The Attention Rule.** Amber means "needs you soon" and always comes with words ("in 3 days",
"expired 2026-10-22"), never color alone. An expired key is amber because it still needs rotating; an
expired or revoked token is faded, because nothing is left to do. The nav says it before the tables
do: "Keys 10, 2 need you", the count in amber.

A key's expiry is a calendar date, good through that day: it counts in whole days where the owner
is ("today", "tomorrow", "in 3 days"). It turns amber, and counts in the nav, a week before: at "in 7
days". A token's expiry is a moment, so it counts in hours and minutes.

## Typography

**Body Font:** system-ui (with sans-serif)
**Mono Font:** ui-monospace (with monospace)

**Character:** The platform's own sans, set small and even; the page reads like a well-kept table,
not a brochure.

### Hierarchy
- **Title** (700, 20px): the page name, once.
- **Heading** (700, 16px): section names (Keys, Grants, Tokens, Audit).
- **Body** (400, 14px, 1.5): table cells, help text, controls. Prose stops at 60ch.
- **Column label** (500, 14px, Faded Ink): table headers and field labels (field labels in Ink).
- **Hint** (400, 13px, Faded Ink): the line under a field that says what it takes.
- **Mono** (400, 12–13px): pasted `.env` text, config JSON (in the fields and in the hints), commands
  such as `tumbler put NAME`, a new token.

**The Unbroken Date Rule.** Dates and times never wrap inside the value and use tabular numerals.
Times are always `YYYY-MM-DD HH:MM UTC`; dates are `YYYY-MM-DD`. In a phone record, where a column is
narrow, the time may go under its date (and "expired" before it), but no part breaks.

## Layout

A single centered column (max 1120px, 16px padding) of sections in a fixed order, Keys, Grants,
Tokens, Audit, with a section nav under the title that carries the live counts. Each section is a
table, then its actions as a stack of named disclosures ("Add a key or replace a value", "Import a
.env", "Move a scope", "Create a token") separated by hairlines; the table's last rule is the first
disclosure's top line, so no two rules ever stack. Forms are a grid of labelled fields
(min 200px columns, 12px gap) with a hint under each field and the buttons last. The token form is one
column 62ch wide above 640px: Name and Expires side by side, then Reads, May mint and May write, each
with its chips and hint at the field's width, then Operator and the button.

Below 640px each table row becomes a labelled record: the name on its own line, then label-over-value
pairs in two equal columns, then the row's actions. A key name elsewhere in a record takes the full
width, and words never break mid-name: a long audit name breaks after the key name's colon, a plus or a
comma, never inside a scope such as `workers:write` or a name such as `huddles-prod/dev`; a permission
group of several words may wrap between them. An empty
cell says "none" rather than disappearing, so every record keeps its fields on the same side. The audit becomes log lines: the action and when;
then who, and the project after a muted "in"; then the names. Above 640px a table that is still too wide scrolls inside its own
container; the page itself never scrolls sideways.

## Elevation & Depth

Flat. No shadows anywhere; structure comes from 1px hairline rules under rows and between
disclosures, and 1px Field Edge borders on inputs and the status line.

**The Hairline Rule.** Depth is a 1px rule, never a shadow.

## Shapes

Controls have gently rounded corners (6px). Preset chips are full pills (999px). Nothing else is
rounded.

## Components

### Buttons
- **Shape:** gently rounded (6px).
- **Primary:** filled Ledger Teal with Stone Paper text; the one action that completes a form (Save,
  Preview, Move, Create token, Save changes).
- **Default:** teal outline and text; secondary choices beside a primary (Copy as "Bearer …").
- **Quiet:** teal text, no border; row actions that open an editor (Set value, Edit) and Cancel.
- **Destructive:** Faded Ink text, no border at rest; Delete Red text on a red tint under hover or
  focus. Every destructive control names its target for assistive tech ("Delete global/GITHUB_PAT").
- **Busy:** once its request is on its way (after any confirm), the button says what is running
  ("Saving…", "Checking with openai…", "Previewing…", "Creating…", "Deleting…") at full color with a
  progress cursor, and its form is inert (its fields and other buttons faded; its note stays readable)
  until the reply, so nothing sends twice and Cancel can't look like it stops a save that is already sent.
- **Hover:** a 10% teal tint (primary: teal deepened 15% toward ink), only where the pointer can
  hover, so a tap never leaves a control tinted (or a Delete red). **Focus:** a 2px teal ring,
  2px offset.
- **Touch:** on coarse pointers buttons, fields and disclosures are at least 44px tall, chips 40px,
  and a checkbox is 20px with a 44px label row. A checkbox never shrinks; its hint goes under it.

### Chips
- **Style:** the default button as a pill (2px 10px, 12px text). They fill a field with a preset;
  the field stays editable, and the chip that matches the field shows as pressed (filled teal).

### Inputs / Fields
- **Style:** transparent ground, 1px Field Edge border, 6px radius, 6px 8px padding, a visible label
  above and a hint below; placeholders are examples, never the label.
- **Set value** says what carries over before it saves: the expiry (with how far off it is, and that
  the date can change) and the check that will test the new value. Left empty, Config keeps an
  existing key's check.
- **Focus:** the border turns teal with a 2px teal ring. **Read-only** (a locked name, scope or kind
  while replacing a value, the shown-once token): dashed border, ink text.

### Tables
- **Style:** full width, collapsed borders, a hairline under each row, Faded Ink column labels; the
  action column has a hidden "Actions" header. Ended rows (revoked, expired) are Faded Ink.
- **Wrapping:** above 640px column labels, the name column and a date with how far off it is
  ("2026-10-26 01:25 UTC, in 36 h") never wrap; the other columns take the wrapping. Row actions sit on the row's first line of text.
- **Empty:** one row that says what will appear there and how to add the first one.

### Status line
- **Style:** fixed at the bottom center, max 600px, Stone Paper ground, 1px Field Edge border, and an
  8px Stone Paper margin (an outline, not a shadow) so rows behind it end cleanly; Delete Red border and
  text for a failure. Success clears itself after six seconds; a failure stays until dismissed. The
  same text goes to a polite (failure: assertive) live region.
- **A failure** names the action and what the server said. A refusal (the request was wrong) changed
  nothing, so its reason is the next step and an open editor keeps what was typed. A server or network
  failure may have half-happened, so the tables reload and the line says the state it left and what to
  do: "Could not delete global/AWS_REGION: internal error. It is still stored; try again." If the reload
  fails too, it says to reload, after copying a token still shown once.

### Shown-once box
- **Style:** 12px padding, 1px Expiry Amber border, 6px radius, placed right under "Create a token".
  It names the token, holds it in a read-only mono field that wraps to show all of it, offers Copy and
  Copy as "Bearer …", and stays until "I have stored it"; until then a second token can't be created
  and leaving the page asks first. On create it scrolls into view above the status line and takes
  focus.

## Do's and Don'ts

### Do:
- **Do** keep every value write-only: no control may reveal a saved value.
- **Do** say what an action will change before it runs (the import plan, the "Replaces the value
  of …" note, confirms that name what ends and that it can't be undone) and what changed after (the
  status line).
- **Do** use Expiry Amber only for things that need the owner soon, always with words.
- **Do** keep forms as `method="post"`.

### Don't:
- **Don't** load external fonts, images or scripts; the CSP forbids them.
- **Don't** add shadows or a second action color; red is for destruction in progress only.
- **Don't** use teal for anything that isn't a control.
- **Don't** use `alert()` for results; use the status line.
