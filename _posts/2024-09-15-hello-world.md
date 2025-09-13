---
title: "Hello, world (or: why this site looks like Windows 95)"
date: 2024-09-15 10:00:00 +0000
tags: [meta, jekyll]
---

Somewhere to dump notes. Production postmortems, opinions about
tooling that get repeated in Slack often enough to deserve a
permalink, the occasional bit of postgres or kubernetes pathology
worth being able to find again in two years when it bites someone
else. So: a blog. About time.

<!--more-->

## Why Windows 95?

The short version: I'm tired of how modern desktop UX has gone, and
this is a small protest in CSS.

The look pulls me past the screen too. The whole
late-90s/early-2000s media palette. CRT glow, VHS scanlines, the
soft chroma bleed of a tape recording, glossy WordArt logos
slapped onto everything from CD-ROM splash screens to magazine
ads. Same feel, same comfort. For weekend amusement I keep a
Windows 98 SE install in QEMU inside a Distrobox container on my
Steam Deck, browsing [Protoweb][protoweb] through Netscape
Communicator. It's silly. It also loads pages in under 100 ms.

Mobile-first flat design moved into desktop software around 2012
and never left. Material, Metro, Fluent, and whatever the current
Apple language is called this quarter. Hamburger menus on a 27-inch
monitor. Affordances erased in the name of "clean", which is to
say: you can no longer tell what is clickable without hovering;
tooltips disappeared because they were "cluttered"; the dropdown
that used to be a dropdown is now a slide-out panel three layers
deep. Settings move between releases on the assumption that nobody
had memorised where they were, and as somebody who operates
production systems for a living, I had memorised where they were.
The result is software that looks like a marketing site and
operates like one too. Consistent and cozy beats slick and
rearranged every quarter.

Older UI got plenty of things right that the industry has agreed
to forget. Title bars tell you what window you're in. Buttons look
like buttons. Menus stay where you put them. Keyboard navigation
works because the focus ring is actually visible. The visual
vocabulary is small and closed, which means there is no sprint
spent fiddling with gradients instead of writing. So:
[98.css][98css], vendored locally, no JS framework, no design
system, no animation budget. Mostly text on grey.

This is a DevOps blog. Most posts are long-form notes on production
failures, postgres migrations gone sideways, kubelet internals,
things learned the hard way and worth writing down before they're
forgotten. The chrome is meant to get out of the way of that.

## What's under the hood

Plain Jekyll, no theme gem, hand-built layouts. [98.css][98css] is
vendored locally so the cloud build doesn't depend on a CDN that
might disappear. Two plugins, both on the GitHub Pages allowlist
([jekyll-seo-tag][seo] and [jekyll-sitemap][sitemap]) so the local
build matches what GitHub serves. Icons are real
[Win95/XP `.ico` files][icons], not SVGs faking it.

JavaScript footprint is roughly nothing. A clock in the taskbar
and a start-menu toggle. With JS off, the clock stops and
everything else works.

The font setup is the one bit of actual fussiness. Window chrome
(title bars, taskbar, top nav) renders in Pixelated MS Sans Serif
at 11–12 px with `image-rendering: pixelated` and font smoothing
off; rounded antialiasing on a chunky pixel font looks wrong. Post
content drops back to Tahoma/Verdana with smoothing on, like a
Notepad/WordPad-era text window. Two stacks, one site, on purpose.

## Smoke test

Mostly here so a Jekyll upgrade or a `_sass` change that breaks
rendering surfaces immediately. Skip otherwise.

A bulleted list:

- Item one.
- Item two with `inline_code`.
- Item three.

A code block:

```bash
#!/usr/bin/env bash
set -euo pipefail
for ns in $(kubectl get ns -o name); do
  echo "Checking ${ns}..."
  kubectl --namespace="${ns#namespace/}" get pods \
    --field-selector=status.phase=Running
done
```

A blockquote:

> Software is a gas. It expands to fill its container.
> Containers should therefore be small.

A table:

| Tool        | Use case             | Mood          |
|-------------|----------------------|---------------|
| `kubectl`   | All of it            | Resigned      |
| `terraform` | State you can name   | Cautious      |
| `pulumi`    | State you can debug  | Hopeful       |
| `awk`       | Text in a pinch      | Affectionate  |

A keystroke: <kbd>Ctrl</kbd>+<kbd>R</kbd> reloads the page.

If the syntax highlighting, table borders, blockquote tooltip-yellow,
and `<kbd>` chrome all render right, the theme is fine. Click the
X in the title bar to close the window.

[98css]: https://github.com/jdan/98.css
[seo]: https://github.com/jekyll/jekyll-seo-tag
[sitemap]: https://github.com/jekyll/jekyll-sitemap
[icons]: https://github.com/trapd00r/win95-winxp_icons
[protoweb]: https://protoweb.org/
