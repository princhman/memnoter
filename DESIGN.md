# Design

The user's UI taste, for every platform (desktop, Windows, iPad, iPhone).
Folder-specific rules stay in `apps/shared-ui/AGENTS.md` and `apps/ios/AGENTS.md`.
Each rule records the user's words and the date in a comment.

## Spacing & layout

- **A new control that does the same job as an existing one reuses that
  component, its size and its states.** Saved images and crops use
  `ImageActionsMenu`; desktop popups use `DropdownMenuItem` density; create and
  rename dialogs use `DialogHeader` and the existing field spacing. iPhone and
  iPad share the same SwiftUI controls and actions (`FormattingBar`, the
  module/section picker) and only adapt placement.
  Why: a new variant reads as "much fatter than our usual sized buttons or rows".
  <!-- 2026-11-15: "make the menu to look like on the image edit … reuse component"; "reuse the components between devices as much as possible" -->
- **Breadcrumbs use one grammar: `Module / Section › Item`, with `/` between
  nested headings** (`file-breadcrumb.tsx`, `TabletBreadcrumb.swift`, the Cmd+K
  footer). Show at most the last two heading crumbs; earlier ones go behind a
  clickable ellipsis. The path follows the primary view: a side PDF never
  replaces it. Never show the same label twice.
  Why: "Logic / Notes > Logic, which is completley and utterly stupid".
  <!-- 2026-11-15: "no it should be / not - between them"; 2026-11-16: "show only last 2" -->
- **Group toolbar actions by what they act on.** Unrelated groups get space or
  separate capsules (`TabletGlassRow` / `TabletGlassPill` on iOS).
  Why: "the title is too close, makes it look like it means going back to the title".
  <!-- 2026-11-05: "seperate actions buttons and sidebar buttons into 2 menus different blobs" -->
- **A menu command stays on one line.** The menu is as wide as its labels, not
  its trigger, and capped to the viewport. Hints never squeeze a label.
  Why: "how am i supposed to read".
  <!-- 2026-11-14: "I do not want to see items wrapping like that stupidly" -->
- **A title truncates only when it really overflows.** Never give iPad the
  iPhone width cap. Back, overflow and close controls always stay in view.
  Why: "there is no need for it to be reduced".
  <!-- 2026-11-16: "because of the clamping with ... on iphone very often title is reduced where it should not be" -->

## Typography

- **With chapter numbering on, section names show the same number in the
  editor, sidebar, Contents and Cmd+K, all from `headingNumbers`.** Never show a
  generic `H` badge in navigation (the heading-level picker keeps H1–H6).
  Why: "that H is completely useless".
  <!-- 2026-11-16: "if chapter numbering is enabled show it there instead of H" -->

## Motion

- **Temporary UI never moves content, changes the scroll position or makes a
  control blink.** This covers selection bars, sheets, draft or resume rows and
  saving states. Put a status on the object itself or in a fixed-size slot.
  Why: the "editor behind it jiggles".
  <!-- 2026-11-08: "I do not like how these bars appear … and how everything shifts"; 2026-11-15: "what jiggles the page is resume unsaved drawing"; "done button blinks every time I edit" -->

## Interaction

- **The most-used actions stay visible; an ellipsis holds only secondary
  ones.** Never move a control into an overflow menu because the bar got
  narrower. Anything desktop reveals on hover needs a visible touch path on
  iPad and iPhone.
  Why: "making most frequent user journey obvious, while keeping design super minimal and simple".
  <!-- 2026-11-15: "do not fucking hide it in the elipsis, think about which ones will be used most"; 2026-11-03: "some of the actions are hidden behind hover and that is not good" -->
- **Every pane, sheet or fullscreen view keeps a visible way to close it or go
  back**, and only one per job: no X next to a toggle that does the same.
  Why: "and then I am stuck".
  <!-- 2026-11-15: "the thing with closing right sidebar dissappears and then I am stuck" -->
- **Two visible controls never do the same thing.** Right-click and keyboard
  shortcuts are fine as alternate routes.
  Why: each control's purpose stays clear and a small bar keeps room for other actions.
  <!-- 2026-11-08: "I do not like how both title and elipsis opens the same menu"; 2026-11-15: "now on worksheet I have 2 back buttons" -->
- **An icon shows what it does or where it goes.** Two different actions never
  share one glyph with only a tooltip to tell them apart.
  <!-- 2026-11-08: "without hover i would not guess"; "make it clear that this will open as a sidebar in the note" -->
- **Use a modal for an input only when the user needs nothing else on the
  screen.** When the input depends on what is around it (a worksheet answer
  needs its question), edit it inline.
  Why: "you need the whole context of the question".
  <!-- 2026-11-17: "remove the modal, go back to inline"; 2026-11-21: "make the input field modal, when additional context from the screen is not needed" -->
- **Desktop list reorder: drag from the row itself, no grip.** The row preview
  follows the pointer, also over folders and other containers. The drop never
  snaps back while saving. A folded row opens after 2 s of hover over a valid
  drop target (`sidebar-modules.tsx` is the reference).
  Why: a dedicated grip "is a lot of space waste".
  <!-- 2026-11-08: "can you preview the row the same way"; 2026-11-14: "no need for dragging icon"; 2026-11-16: "open after 2 seconds hover" -->
- **Section pickers go one level at a time.** Opening a module shows top-level
  headings; drilling shows the next level with a way back; search may match
  deeper headings with their path.
  Why: "it is hard to navigate when it is large and massive document".
  <!-- 2026-11-14: "show only top sections with ability to go deaper" -->
- **Reload or reopen restores the last view:** module, Notes or Questions,
  open worksheet and sidebar visibility, stored apart from the document.
  Why: reopening resumes the task the user left.
  <!-- 2026-11-15: "preserve the opening state, everytime it reloads worksheet gets closed" -->

## Copy

- **Never repeat what the header already says.** No second title, no
  display-only recaps (`2 out of 9 answered`, `Card`, `New`). Keep counts the
  user acts on, such as backlinks and due counts.
  Why: "it is a uselsess information".
  <!-- 2026-11-14: "question bank is not needed there" -->
- **Never show passive success text like `Saved`.** Show pending, unsaved and
  error states only.
  Why: "everything is always saved locally".
  <!-- 2026-11-15: "everything is always saved locally so no reason to show saved" -->
- **Name a command by its result, and use the same name in its button, tooltip
  and shortcut list** (`Quote region`, not `Select region`).
  <!-- 2026-11-14: "select region name is ambigious, call it quote region" -->
- No em dashes or middle-dot separators in UI copy, mockups or PR copy
  (`scripts/lint-style.mjs` checks the code).
