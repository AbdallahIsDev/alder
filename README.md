# Alder Roof Systems — Landing Page

Single-page marketing site for a roof replacement contractor. Swiss / International
Typographic Style, light mode, GSAP + ScrollTrigger + Lenis.

```
Roofing-2/
├── index.html            ← everything: markup, SEO meta, JSON-LD, image alt prompts
├── assets/
│   └── img/*.svg         ← solid-colour placeholder mockups (replace these)
├── site.webmanifest
├── robots.txt
└── sitemap.xml
```

## Run it

```bash
python -m http.server 8791
# → http://127.0.0.1:8791/index.html
```

A server is needed (not `file://`) so the deferred scripts and lazy images behave
as they will in production.

---

## Replacing the placeholder images

Image 01 (the hero, `hero-roofscape.jpg`) is **real photography**, already
swapped in and already carrying a descriptive `alt`. Images 02–08 are still
**solid-colour SVGs** standing in for real photography. To swap one in, change a
single attribute — the `src` — and then rewrite its `alt`, which currently holds
the generation prompt.

Each image also has a `<!-- ██ IMAGE 0N — LABEL ██ -->` comment above it.

| # | File | Placeholder | Final size | Used in |
|---|------|-------------|-----------|---------|
| 01 | `hero-roofscape.jpg` | **done — real photo** | — | Hero |
| 02 | `craftsman-portrait.svg` | 1600×2000 | 2000×2500 | Manifesto |
| 03 | `install-detail.svg` | 1800×2250 | 1800×2250 | Services Fig. 01 |
| 04 | `crew-install.svg` | 2600×1733 | 2600×1733 | Services Fig. 02 |
| 05 | `project-shingle.svg` | 1800×2250 | 1800×2250 | Project 01 |
| 06 | `project-metal.svg` | 1800×2250 | 1800×2250 | Project 02 |
| 07 | `project-flat.svg` | 1800×2250 | 1800×2250 | Project 03 |
| 08 | `project-storm.svg` | 1800×2250 | 1800×2250 | Project 04 |

```html
<!-- before -->
<img src="assets/img/project-shingle.svg" alt="IMAGE PROMPT — PHOTOGRAPH: …" …>

<!-- after -->
<img src="assets/img/project-shingle.jpg" alt="A 1970s two-storey house after a full shingle replacement …" …>
```

When you replace an image, **rewrite the `alt` to describe the actual photo** —
for images 02–08 the current values are prompts, not descriptions, and shipping
them as alt text hurts SEO and screen-reader UX. The hero's `alt` is already a
real description.

Also replace: `assets/img/og-cover.jpg` (1200×630, referenced by the OG/Twitter
meta and JSON-LD), and the `logo-512.png` / `apple-touch-icon.png` paths in the
head.

---

## Image prompts

All eight prompts are inline in the `alt` attribute of each `<img>` in
`index.html`. Copy from `IMAGE PROMPT —` to the end of the attribute. They specify
subject, angle, light, palette, lens/format, explicit exclusions (no text, no
logos, no people where unwanted), and target aspect ratio.

---

## SVG versions

The preloader roof elevation is versioned. Snapshots live in
`.preview/versions/` with a `manifest.json` index.

| id | name | paths | accent ticks | sha | status |
|----|------|-------|--------------|-----|--------|
| v1 | version 1 | 20 | 3 | `d0189a8d` | **CURRENT — live** |
| v2 | version 2 | 41 | 24 | `9334f7d8` | archived, rejected |
| v3 | version 3 | 72 | 7 | `4ab03fd3` | archived, rejected |

**"go to version one" means v1** — the archived 20-path snapshot, not the live
`index.html`. v1 is the final version; iteration was stopped at Abdallah's
instruction ("v1 is definitely better, no more iterations on this svg").

- v2 added 21 accent tick paths (shingle courses, ridge/eave ticks, sills,
  jambs, flashing, vent stack, gutter hangers). Rejected — read as heavy.
- v3 rebuilt the house as an **oblique/cabinet projection** so it reads as 3D:
  facade drawn true with depth receding up-right, visible side wall and roof
  plane, windows with casing + reveal + sill + muntins, panelled door,
  clapboard siding. Rejected — at real preloader size 10 of 29 detail paths
  rendered under 4px, so the realism was invisible while tripling the file size.

Inspector page: `.preview/inspect-v1-<stamp>.html`.

To restore a version into the page, replace the `<svg class="pre__plan">` block
in `index.html` with the contents of `.preview/versions/<id>.svg`.

## SEO

- **Title / meta description** — head of `index.html`, written for "roof
  replacement contractor" intent with a phone number and a concrete claim.
- **JSON-LD `@graph`** — `RoofingContractor`, `WebSite`, `WebPage`, `Service`
  (with an `OfferCatalog`), and `FAQPage` with all six FAQ answers. Validate at
  validator.schema.org before launch.
- **OG / Twitter cards** — 1200×630 `og-cover.jpg`.
- `robots.txt`, `sitemap.xml`, `site.webmanifest` included.
- Semantic landmarks: one `h1`, `section[aria-labelledby]` throughout,
  `aria-expanded` on accordion triggers, `aria-live` on the form success state.

### Before you go live

1. Replace every placeholder: phone `(555) 018-4400`, email, address, licence
   number, pricing, review counts, ratings, and all project case details. **Every
   number on this page is invented placeholder content.**
2. Point the canonical/OG URLs at the real domain (search `alderroof.com`).
3. Validate JSON-LD and run Lighthouse.
4. Write real alt text (see above).

---

## Motion

All animation is progressive enhancement — initial hidden
states are applied at runtime via `gsap.set()`, never in CSS, so if the scripts are
blocked or `prefers-reduced-motion` is set the page renders fully readable.

| Feature | Implementation |
|---|---|
| Smooth scroll | Lenis, driven by the GSAP ticker |
| Preloader | Ink field; a **front elevation of a house with a 6:12 gable roof draws itself** — all 20 paths animate in a single ~1.05 s tween via `strokeDashoffset`, so the whole house appears at once. 0.42 s hold, then the two ink halves part along an 8vw **diagonal** seam. Total ≈ 3 s. **No text in the drawing** — the elevation is the drawing; only the readout below is typographic. Geometry is derived from the pitch, not eyeballed: the two slopes are asserted to mirror at ±0.500, the drawing is the drawing is bounds-checked inside the viewBox. The percentage is **derived from the draw duration**, so it can never read ahead. 4.5 s failsafe for backgrounded tabs. `data-ph` (0–4) is retained as documentation and as a hook if you ever want to re-stagger the build. |
| Header | Permanently pinned, always visible; only the hairline appears past 80px |
| Hero | Flex split (label + h1 / subtitle + CTAs, 48px column gap), word→line mask reveals, image scale-in + clip, scroll-out parallax (18% travel, covered by a 42% overscan) |
| Scroll reveals | `[data-reveal]`, `[data-reveal-stagger]`, self-drawing rules |
| Text splits | Words grouped into line masks by measured `offsetTop` |
| Counters | `data-count`, tabular numerals, locale-formatted |
| Projects rail | Pinned horizontal scroll (desktop), touch-scroll (mobile) |
| Marquee | Seamless duplicated track, velocity-based |
| Nav | Sticky, hairline past 80px, progress bar |
| Micro-interaction | None. Button hover states, magnetic pull and the `ph` prompt-on-hover overlay were all removed — the page is now still on hover, not animated. |

Two deliberate structural details: `.pcard--tail` is a spacer that guarantees the
rail overflows the viewport (four cards can otherwise sum to almost exactly the
viewport width, giving the pin zero distance), and the UI initialisers carry
`._wired` guards because `initUI()` and `boot()` can both reach them.

---

## Verified in-browser

Checked at 1920×953 and 390×844: 60 ScrollTriggers registered, pinned rail
travels 0 → −289 px tracking progress, all 8 images load, counters reach
`12,400+ / 4.9★ / 50yr / 24hr`, accordion toggles one item at a time, form blocks
empty and malformed email input then shows the success state, mobile menu
opens/closes, and `prefers-reduced-motion: reduce` yields static content with real
figures.