# Alder Roofing Landing Page: Session History & Handoff

> **For any AI agent continuing this work:** read this whole file first. Sections 1-3 say where we are and what to do next. Sections 4-6 hold implementation rules that are **not built yet**. Section 7 explains why each finished section was designed the way it was. Match the existing tone: plain, human, specific, premium.
>
> **This file is a live worklog. Update it as you go.** Treat it as your own worklog, not a one-time summary. Whenever the user makes a decision, we finish a section, or the focus changes, edit this file right away: update the Progress Tracker (section 3), the Open Items, the rationale (section 7, only once a section is finished), and add a dated line to the Update Log (section 10). Keep it concise, and don't record details of finished work such as image prompts. Then give the user the updated file so the next agent can continue from it.
>
> **Last updated:** Oct 21, 2026 | **Current focus:** estimate modal, scrollbars and static build are done; next is a browser test pass, then removing the debug panel and wiring the real form endpoint

---

## 0. How the Agent Should Behave (read this before replying)

The user expects a smart, socially aware partner who anticipates needs, not one who waits to be told every detail. **Don't wait to be asked for the obvious next thing. Just include it.**

**Assets: provide them automatically**
- **Image needed** (the user says so, or we decide a section needs one): give the image-generation prompt in the same reply, without being asked. Match the project: warm early-morning or daytime light (**never sunset**), realistic and photographic, correct framing for the section (state the aspect ratio), and a calm/darker area where text overlays. Say whether a real client photo would be better and warn about common AI errors (hands, harnesses, ropes, tools, faces) to check.
- **Video needed:** give the video-generation prompt in the same reply: duration, camera move, subject motion, lighting, loop-friendliness, "no text/logos", and a note about file size and a still poster/fallback. Remember that free video tools are weak, so mention the animated-image fallback when relevant.
- **Icon needed:** give the icon concept right away, plus **several search keywords** so the user can search the icon library, e.g. for "confidential / secret": `secret`, `secure`, `vault`, `lock`, `safe`, `shield`. Suggest 4-8 keywords per icon, including synonyms and metaphors, and name a recommended style (outline, consistent stroke weight) so the set stays consistent. Do this for each icon in a list (feature cards, process steps, etc.).

**Content: don't make the user spell it out**
- When proposing a new section, include in the same reply: its purpose, light/dark style, layout, **ready-to-use copy**, any image/video/icon needs (with prompts/keywords), and the motion behavior. Flag what needs client confirmation (claims, numbers, services).
- Keep copy plain, human, and specific, written like one person talking to another. Avoid template phrases ("reliable roofing services and exceptional workmanship").
- Any number, name, or claim you write is a placeholder until verified. Say so, and add it to section 6.

**Implementation: think ahead**
- For each section, mention what is needed for responsive behavior, reduced motion, no-JS fallback, lazy loading, and accessibility (contrast, text size, alt text), and record it in section 4 if it isn't built yet.
- Respect the layout system (section 2): spacing comes from the main container's `gap`, not per-section padding.
- **Motion rules:** split-text is for titles and subtitles only (plus the footer text, by request). Flags/labels, buttons, cards (testimonials, FAQ), the before/after block and the footer each use their own reveal (`data-rv` system, 5 explorations each, chosen by `html[data-a-flag|btn|card|ba|ft]`). A flag is animated as ONE component (square + text). Clip-path reveals never combine with opacity or blur. Every image gets a clip-path wipe automatically (any `<img>`, `.photo`, `.cta-img`, including ones added later; opt out with `data-no-reveal`; hero slider, header, menu, modal and before/after are skipped).
- Any scrollable overlay (modal body, mobile menu) needs `data-lenis-prevent`. `lenis.stop()` also blocks wheel and touch scrolling inside it otherwise.
- Warn about problems you notice (tiny or low-contrast text, misaligned edges, repeated messaging, inconsistent patterns) even if the user didn't ask about them.

**Collaboration**
- Give a clear recommendation with reasons, and push back honestly when the user's idea is weaker than an alternative. Say what is data and what is judgment.
- If the user sends a screenshot, review what you actually see and be specific. If you can't verify something (a live site, a connector), say so plainly.
- Don't ask unnecessary questions. If something is ambiguous, state your assumption and continue. Ask at most one question at the end, usually "what's next?".
- Keep the user's rule: update this file after every meaningful decision.

---

## 1. Project Overview

- **What:** Premium, Awwwards-level landing page for a roofing company. Demo brand name: **Alder** (Iowa & Upper Midwest). Will be presented to a real client, so **no placeholder content may remain in the final version**.
- **Goal:** Look high-end and unique (not a generic template), earn homeowners' trust fast, and drive "Get a Free Estimate" conversions.
- **Constraint:** Everything must be free (free AI image tools, no paid video). Design is currently **static only**.
- **Tools notes:** Design is made in Paper (paper.design). Claude cannot connect to it (no connector found). Work from screenshots, pasted exported code, or copied design values.

## 2. Design System (decided)

| Item | Decision |
|---|---|
| Overall theme | **Light page with dark cinematic sections.** Dark masthead (nav + hero + stats), then light sections. Not full dark mode (market data shows light is preferred ~3:1 and theme doesn't change conversion much; audience is homeowners, often older, on mobile, in daylight) |
| Page background | White / warm off-white (`#F7F4EF` for cards) |
| Dark color | Charcoal (~`#1C1F24`) |
| Accent | **Red-orange** (CTA arrow tiles, badge squares, `+`, `★`, `yr`, `%`). Blue was considered as the "most trusted" roofing color but was rejected for being generic. Use the exact hex already in the CSS |
| Typography | Clean grotesque sans (Inter-style), tight tracking on headings |
| Spacing system | Main container is a **flex column with `gap` between sections**. Sections have **no own top/bottom padding**. Hero + Stats are wrapped in a `.masthead` with `gap: 0` and one shared dark background |
| Min text size | Small labels/microcopy at least **13-14px**, contrast at least 4.5:1 |
| Buttons | White primary button with accent arrow tile; secondary is outlined/dark. Reuse everywhere |
| Image rules | Warm, early-morning/daytime light. **No sunset** (crews don't work at sunset, it would imply slow work). Replace AI images with real client photos in the final version |

## 3. Progress Tracker

| Section | Status |
|---|---|
| Header / Nav | Done (static) |
| Hero | Done (static). Slider/animations not built |
| Stats band | Done (static). Counters not built |
| **About** | **In progress.** Layout and copy done; empty space under text still being resolved |
| Services | Design approved; static build done (v3). Images + content final pass pending |
| How We Work | Final design built, awaiting review |
| Projects | Planned |
| Reviews | Planned |
| FAQ | Planned |
| Final CTA / Footer | Done (CTA image-left; footer option 3). Every estimate button opens the modal |
| Estimate modal | Done: frosted-glass, 4 steps, animated steps and height, sending / thank-you / failed states, UI-only (no backend). Needs a browser test |
| Template config + static build | Done: `BIZ` object + `build-static.js` (see log). Needs a test with a real client config |
| Custom scrollbars | Done (square, ink track, accent on hover; modal and menu included). Not yet checked in a real browser |
| Responsive behavior | **Not built** |
| Animations / JS | Split-text, image reveals, counters, menu and modal done. Reveal explorations for flags, buttons, cards, before/after and footer are live in the debug panel: **user to pick 1-5 for each, then delete the others and the debug rows** |
| Reduced motion, no-JS, SEO, performance | **Not built** (rules in sections 4-6) |

**Pending decisions / open items**
- Test in real browsers (Chrome, Safari, Firefox, a phone): modal wheel/touch scroll with Lenis, scrollbar look and gutter while the modal is open, frosted blur, focus order.
- The estimate modal is a UI-only showcase: it never sends, stores or logs anything. If a real provider is wanted later, replace `deliver()` in the modal script, or define `window.estimateDeliver(data)` before it (return a promise; reject to show the failed state).
- Modal validation is US-style (5-digit ZIP, 10-digit phone). Loosen it for non-US clients.
- Delete the debug panel and its script block before the client sees the page.
- About: how to fill the empty space under the paragraph (recommended: three "how we work" notes, see 8). Font size 28px (recommended) vs 32px (current).
- Hero images 2 and 3: still need to be generated or converted to **morning light** (existing image 1 is golden-hour/sunset-toned and should be edited to morning).
- Trust label **"Proud Stone"** in hero: unclear what it refers to. If not a real credential a homeowner recognizes, remove it.
- Hero H1 is currently Title Case; sentence case ("The roof is the house.") reads more human. Style choice, not decided.
- All numbers/names below are placeholders to be replaced with client-verifiable facts.

## 4. Implementation Rules (NOT BUILT YET)

### Hero
- **Content:** badge "Roof Replacement Across Iowa & the Upper Midwest"; H1 "The roof is the house. We treat it that way."; subtitle (about 30 words, in-house crew, clear written price that doesn't change); primary CTA "Get a Free Estimate"; secondary "See Our Recent Roofs"; microcopy "Free, no obligation. We'll reply within one business day."; small muted trust labels inside hero: Licensed and Insured, Locally Owned (+ "Proud Stone", see open items).
- **Height:** hero fills the first viewport only, using **`dvh`** (user's decision). If the background visibly jumps while scrolling on mobile, use `100svh` as the base and `dvh` as an enhancement. The Stats band must **not** be in the first viewport (would crop the image on desktop, crowd mobile).
- **Slider (3 images, crossfade):** order = (1) crew on half-finished roof, ~9s; (2) close-up of hands laying shingle, ~7s; (3) finished roof from the ground with crew, ~7s. Crossfade ~1.5s. Slow Ken Burns zoom ~5%, alternating zoom-in / zoom-out per slide. Same bottom dark gradient on every slide so text stays readable. Cycle is ~22s so repeats are rarely seen.
- **Loading:** image 1 loads immediately (priority/preload, no lazy). Images 2-3 load after. Everything below the hero is lazy-loaded.
- **Mobile:** crop must keep the key subject (workers/roof) visible. Check headline and buttons over busy shingle texture. Consider showing a static image instead of animated zoom if performance suffers.
- **Reduced motion:** disable zoom and crossfade (show a static image).

### Stats band
- **Items (placeholders):** `276+` roofs completed; `4.8★` on Google, 314 reviews; `20yr` workmanship warranty; `100%` in-house crews. Small symbols (`+ ★ yr %`) are in the accent color.
- **Counters:** count up from 0 when the band **scrolls into view** (not on page load), all four finishing together. Use `font-variant-numeric: tabular-nums` so layout doesn't shift. The real final value must be in the HTML (works with no JS and for search engines). Skip animation for `prefers-reduced-motion`.
- **Verification:** the Google rating must link to the real profile and match the real count. Warranty must be a real written policy.
- **Mobile:** 4 stats become a 2x2 grid.

### About
- **Scroll-reveal text:** paragraph words start at ~20% opacity and fill to 100% as the user scrolls (GSAP ScrollTrigger, `scrub: true`, words split in spans, stagger). Keep the text as real HTML. Fallback for no-JS and reduced motion: full opacity.
- **Mobile:** image stacks **above** the text; the three notes stack to one column.

### Cross-cutting
- **Responsive:** build mobile first for hero and stats; test at 375px, 768px, 1280px+.
- **Reduced motion:** wrap all motion (slider zoom, crossfade, counters, scroll reveal, card fades) in `prefers-reduced-motion` handling.
- **No-JS:** all content visible and readable without JavaScript. Animations are enhancements only.
- **SEO/accessibility:** one `h1`; real text (not text in images); meaningful `alt` text; `tel:` link on phone number; compressed images (WebP/AVIF), explicit width/height to avoid layout shift; hero video not used (images only).
- **Performance:** hero first, lazy-load the rest, keep total animation lightweight.

## 5. Navigation & Header (done, static)
Links: **Services, How We Work, Projects, Reviews, FAQ**. Right side: phone `(555) 018-4400` (tel link; tap-to-call on mobile) and primary CTA "Get a Free Estimate" (same wording as hero button). Logo is a house/roof mark with "Alder." wordmark.

## 6. Placeholder Content That Must Be Replaced Before Client Presentation
Phone number, all stats numbers, Google rating and review count, warranty term, founder name and photo, the About story (use the real one), crew photos (replace AI with real), "Proud Stone" label, service list (confirm each is offered), "reply within one business day" promise, "photos at every stage" and other About notes (confirm they are real practices), the estimate thank-you steps (call or text to confirm, free inspection, written price within the reply time), and the "Four quick steps" / ZIP-area lines in the modal.

## 7. Why We Designed It This Way (finished sections only)

### Header / Navigation
- Five short links in the order visitors ask questions (what, how, proof, reviews, doubts). "Specifications" was replaced with "How We Work" because homeowners don't search for the word "specifications". "Reviews" was added because social proof is a major trust driver and should be one click away.
- Phone number and CTA are always visible: roofing leads are often urgent (leaks, storm damage), so calling or requesting an estimate must never need scrolling.

### Hero
- **Large full-width image first:** the first thing visitors process is the image, and it should explain the business without reading. Crew on a half-finished roof does that instantly (it's roofing, it's a real crew, work is in progress), and the finished/unfinished contrast gives natural visual interest. A clean photo of a finished roof was rejected because it was disconnected from the message and blended into the dark page.
- **Fade at the bottom** blends the photo into the dark content area so the text sits on the image instead of in a separate block, which feels like one cinematic composition (framed-image and hard-seam versions were rejected as boxed-in or stacked).
- **Reading order:** image, then H1 (the memorable line "The roof is the house. We treat it that way."), then subtitle (what makes Alder different, in plain words, jargon like "ventilation math" moved lower), then CTAs, then reassurance microcopy.
- **Why a slideshow of 3 images:** free substitute for video. Image 1 explains the business, image 2 shows craft and care, image 3 shows the finished result. Morning light, not sunset, to look believable and efficient.
- **Trust labels inside the hero** (licensed/insured, locally owned): understated reassurance without cluttering the CTAs.
- **Hero only in the first viewport:** keeps the image large and mobile uncrowded.

### Stats band
- Placed directly under the hero inside the same dark `.masthead` so it reads as one anchored block and avoids a white seam; it is a separate section only in code. The numbers stay below the fold on first load so the hero image stays large.
- **Items chosen** for credibility: roofs completed (experience), Google rating with count (third-party proof, chosen over a self-reported "client satisfaction %" because it's verifiable and says the same thing), workmanship warranty (risk reversal), 100% in-house crews (the brand's main differentiator, matches headline and subtitle). "0 subcontractors" was replaced with "100% in-house crews" so all four items share the same pattern: white number + accent-colored symbol, and so the counter can count **up** like the others.
- Accent-colored symbols draw the eye to the numbers.

## 8. Current Work & Next Steps

### About section (IN PROGRESS)
- **Decided:** separate section after Stats (not merged into Stats, not skipped). Light background. **Image on the LEFT, text on the right** (image-first reading order, matches mobile stacking and left edge of hero/stats). Template inspiration (muted-to-full scroll-reveal text, human photo, accent-colored details) but no "View Services" button (Services is right below).
- **Content so far:** label "About Alder" (raise to 13-14px); paragraph: "Alder started with one frustration: the person who sells your roof is rarely the person who builds it. So we do both. The people who inspect your roof, write your quote, and nail down the last shingle all work for us, and they'll be around if you ever need to call." (placeholder story, replace with the real one); caption "[Founder name], founder, and the Alder crew" (placeholder; better as a caption under the photo).
- **Open problem:** large empty space under the text beside the tall image. User considered 2-3 small images or one wide crop (all repeat the same crew photo, adding nothing). **Recommendation:** three short "how we work" notes in a 3-column row (stack on mobile), each with a hairline on top, accent number, bold title, 1-2 sentences, with the text column using `justify-content: space-between` so top aligns with image top and notes with image bottom:
  1. **A direct line to your project lead.** Their number is on your quote; you get them, not a call center.
  2. **Photos at every stage.** Decking, underlayment and flashing photographed before they're covered.
  3. **A clean site, every day.** Nightly magnet sweep, protected landscaping, final walkthrough.
- **Font size:** use `clamp(22px, 2.2vw, 28px)` (28px max) once the notes fill the space; 32px is too headline-like.
- If images are still wanted, use *different* shots (hands on shingle, finished driveway, quote on tablet), not crops of the same photo.
- **When About is finished:** add its rationale to section 7 and mark it Done in section 3.

### Services (STATIC BUILD DONE, awaiting images and content review)
- **Decision:** two-column grid of image-led cards. The full-width sticky-stack layout from the inspiration site was rejected: it forces one service per screen of scrolling, is fragile on mobile (and fights the fixed header), and doesn't scale beyond ~4 services. No data shows the stack converts better; it was judged on usability.
- **Card:** large image (3:2), title, 2-line description. No keyword chips (look like buttons, add noise), no per-card buttons (identical repeated CTAs are noise), no card background or border, description always visible (hover-only text fails on phones). Hover: slow 4% image zoom only on hover-capable devices. Cards are **not links yet**; if the client gets service pages, wrap each card in a link and add a small arrow beside the title.
- **One CTA below the grid:** "Not sure what you need? Get a free inspection."
- **Design for 4-8 services** (typical roofer range, general knowledge, not data). With an odd count, let the last card span both columns. Mobile: one column.
- **Images needed (AVIF+WebP, 1200x800 / 3:2 (1200x800 at 3:2), same constants as before):** `service-replacement`, `service-storm`, `service-repair`, `service-inspection`. Keep them simple close-ups with the same morning light, color, and detail level. Prefer real client photos.
- **Still to do:** check mobile, reduced motion and no-JS behavior, then add the rationale to section 7 once approved.

### After that
How We Work (avoid repeating About's three notes), Projects, Reviews, FAQ, final CTA, footer. Then implement everything in section 4.

## 9. Working Preferences (user)
- Wants detailed but honest answers; push back when something is wrong.
- Wants real-world reasoning and numbers where possible; flag when something is judgment, not data.
- Wants premium, personalized, non-template design with smooth animations.
- Wants this file updated after each meaningful decision. Keep it concise; leave out finished prompts and fine detail of completed work.

## 10. Update Log
- **Reviews FINAL:** exploration 2 (image left, content right) in row 1 (two feature cards, 4:5 images). Row 2 is now image / text-only / image (4 images total: 2x 4:5, 2x 3:2, solid placeholders until generated). Cream cards, 16px gap, no borders, text-only card uses the large quote size, avatars are round (`border-radius: 3rem`; the only radius on the site, by the user's choice). Debug row and script for reviews removed.
- **Reviews redesign (exploration):** hairline-separated 6-col grid: row 1 = two feature cards (review left + 4:5 final-result image; debug "Reviews" 1 = image right, 2 = image left), row 2 = three standard cards (plain / image-on-top 3:2 / plain). Every card has the full meta block: square coloured avatar with the first letter, name, service line, "Read full review" link (BIZ.google). Images are solid placeholders; user will ask for generation prompts next. Model/modal work was finished by the user (do not touch).
- **Oct 22, 2026 (animations):** **Phone field:** accepts any country, with or without a country code or `+` (also `00` prefixes, spaces, dots, dashes, brackets, Arabic-Indic and Persian digits, a trailing extension); rule is 7 to 15 digits; the number is never reformatted. **Mobile menu:** text now sits below an overflow mask at full opacity and slides up when the menu opens (links and the footer button and phone, staggered); it resets after the menu has closed. **Split-text** no longer touches flags, labels, trust points, micro text, stat labels or the signature. **Five explorations each** (debug rows Flags, Buttons, Cards, Before/after, Footer): Flags 1 fade up, 2 blur in, 3 clip wipe across, 4 clip rise, 5 square pops then text fades; Buttons 1 fade up, 2 slide from left, 3 clip wipe across, 4 blur and scale, 5 clip opens from centre; Cards (testimonials + FAQ) 1 fade up, 2 scale in, 3 clip rise, 4 blur and rise, 5 tilt up; Before/after 1 clip down, 2 clip across, 3 fade up then the divider sweeps in, 4 soft zoom, 5 blur and rise; Footer 1 sticky (footer waits behind the page and is uncovered as it scrolls away; falls back to normal flow if the footer is taller than the screen), 2 curtain up (clip), 3 fade up, 4 panel grows to full width, 5 static with a scroll-linked wordmark. All footer options also split the footer text into words, animate the "Alder." wordmark (letters or whole word, depending on the option), and animate the logo and social icons like buttons and the two trust points like flags. Switching an option replays it; Footer has a Jump button. **Images:** the CTA image and every other image now get the clip-path wipe automatically. **Footer legal row:** the placeholder "Iowa contractor reg. #000000" (it looked like a colour code) is gone and `BIZ.license` is removed; the row now says "Licensed and insured" and "Locally owned" like the hero. Checked with jsdom (stubbed GSAP and IntersectionObserver); **not opened in a real browser: check the sticky footer, the clip-paths and the menu on screen.** Fix: the footer's `ResizeObserver` now defers its layout changes one frame (it raised "ResizeObserver loop completed with undelivered notifications"). Rule: never change layout inside a ResizeObserver callback; wrap the work in `requestAnimationFrame`.
- **Oct 22, 2026:** **Themed dropdown for "How old is the roof?"** The browser's native list (white, unreadable options on the dark glass) is replaced by a custom listbox built in script from the hidden native `<select>` (still the data source, so reset and validation are unchanged). Square, frosted dark panel, accent bar and check on the selected option, chevron turns when open, opens upward when it would not fit inside the modal. Keyboard: arrows, Home/End, Enter/Space, type-ahead, Esc closes the list only, Tab closes it; ARIA combobox/listbox pattern; error state mirrors onto the trigger. **Debug panel:** the Estimate row (open + simulated failure) is removed; the failed state is now only reachable through a provider that rejects. Checked with jsdom; **not opened in a real browser** (the upward flip needs real layout).
- **Oct 21, 2026 (later):** **Estimate modal is now a UI-only showcase.** Fixed "Continue does nothing": inside a sandboxed iframe without `allow-forms` the browser cancels a real form submission before any handler runs, so the buttons are now `type="button"`, Enter is handled in script and `submit` is always cancelled. Removed the network path, `BIZ.formEndpoint`, the console log, the `estimate:submit` event and the spam-trap field; `deliver()` is the single place to connect a provider later. Subtitles removed from steps 1 to 4. Step indicator is only "Step n of 4" ("Request sent" after success). Continue is fully accent (background, arrow, no separate tile; white text; `--est-btn` can darken it if contrast is a concern, white on the accent is about 4.3:1). **Motion:** step changes use opacity + scale + blur (forward: current shrinks away, next grows in; backward: reversed), and the form box height animates between steps, for error messages, the failed alert and the success screen (Web Animations API; instant when reduced motion is on). Success screen: check mark draws in, content rises in sequence. Details: digits-only ZIP, errors linked to fields (`aria-describedby`), field shake and red group border on errors, press states on cards and buttons, white focus ring on Continue, spinner while sending. `build-static.js` no longer needs a BIZ stub. Checked with jsdom (instant and animated paths, static build); **not opened in a real browser.**
- **Oct 21, 2026:** **Estimate modal FINAL: variant 3** (dark overlay + blur, frosted-glass dialog, four segments + "Step n of 4 · Name"). Variants 1, 2, 4, 5, the debug Modal row and `data-modal` switching are gone. Added: choice cards with a square check marker, per-step lead lines, ZIP/phone/email checks, phone formats on blur, **sending** state (button disabled "Sending…", body inert, last segment pulses), **thank-you** screen (recap, what happens next, Close, call link), **failed** state (alert, answers kept, button "Try again", 15s timeout, non-2xx counts as failure), honeypot field, payload adds `claim` (boolean), `business`, `page`, `sentAt`. Page behind is `inert` while open. Fixed: modal body and mobile menu now have `data-lenis-prevent` (they could not scroll with Lenis stopped). Debug panel row "Estimate" = Open + Send ok / Next send fails (prototype only). **Scrollbars:** square, ink track, grey thumb, accent on hover; modal body uses a transparent track with a frosted thumb; `html` background is ink so the gutter stays dark while the page is locked; Firefox falls back to `scrollbar-color`; `scrollbar-gutter: stable` kept. **Static build:** `build-static.js` bakes `BIZ` into plain HTML (`--config client.json` overrides keys per client, `--out` sets the output; copies `assets/`). It also removes the load guard, drops empty social icons, and points the estimate buttons at an email link for no-JS visitors. Last two hardcoded client details (meta description, About text) are now `{{area}}` and new `{{base}}`. Checked with jsdom (flow, states, static output equals the live page); **not opened in a real browser.**
- **Oct 24, 2026 (decision + hand-off):** User chose **Modal 3** (dark overlay + blur, frosted-glass dialog, segmented progress). Hand-off (all four items done on Oct 21, see the entry above): (1) lock the modal to variant 3 and delete variants 1, 2, 4, 5 + debug row + `data-modal`/`data-est-modal` switching; (2) finish the rest of the onboarding (polish all 4 steps, submitting state, success screen, error/retry state); (3) custom scrollbar in the site theme (page, modal, menu), square (no radius), keeping `scrollbar-gutter: stable`; (4) static/no-JS build script (`build-static.js`) that bakes the `BIZ` values into plain HTML.
- **Oct 24, 2026:** **Template config:** all client-specific info now lives in one `BIZ` object (script right after the footer/modal): name, brand, phone (+ countryCode; the `tel:` link is derived from it), email, address, hours, service area, reply time, rating, reviews, roofs completed, warranty years, social URLs (empty = icon hidden), optional `formEndpoint`. HTML uses `{{tokens}}`; `html.biz-pending` hides the body until they are filled. **CTA:** version 1 removed; only the image-left/content-right version remains (image `cta-roof`, 5:3). **Type scale:** `--fs` = clamp(14px, .5vw + 8.4px, 18px) for small text (paragraphs, labels, flags), `--fs-sub` = clamp(12px, .5vw + 8.4px, 18px) for subtitles. **Estimate modal** (all `data-open-estimate` links): one 4-step flow (service, property, timing, contact) + success state, 5 presentations in the debug panel (Modal 1-5 + Open): 1 blur/light, 2 dark overlay/dark, 3 dark+blur glass, 4 right drawer with greyed page, 5 wide split with brand panel. Scroll lock uses `scrollbar-gutter: stable` (JS padding fallback), restores scroll position, Escape/focus trap. Submission is prototype-only: console + `estimate:submit` event + optional `BIZ.formEndpoint`. User still to choose the modal (1-5), then remove the others and the debug row.
- **Oct 23, 2026 (tuning):** Slider spring stiffness 70 to 200 (mass 1, critical damping ratio 1, ~0.3s settle, still no overshoot). CTA variant 2 mirrored: **image left, content right** (text starts near screen center), image ratio 5:3 (generate `cta-roof` at 5:3). Variant 1 unchanged (centered, ~630px). User choosing between CTA 1 and 2.
- **Oct 23, 2026 (later):** Based on the user's own edited file (their selections and style edits kept). Before/After slider now uses a **critically damped, time-based spring** (mass 1, stiffness 70, damping ratio 1): no overshoot or rubber-band, and it never crosses the target. **CTA:** only variants 1 (centered) and 2 (text left, image right) remain; both now use the **accent background** with white label dot, white text/phone, ink button tile; variants 3/4 and their debug buttons removed. Section default is variant 1. User still to choose between CTA 1 and 2, then delete the other and the debug row. Open item: the estimate button is `href="#"`; the page needs a real estimate form/booking/call path before launch.
- **Oct 23, 2026:** Header slides down on load; `text-wrap: balance` on everything. **Heading system:** `.sec-head.split` (50/50: label + H2 left, subtitle + optional CTA right, same as hero), `.center` (label, H2, subtitle, stacked), `.list` (label + two-line H2 left, e.g. FAQ). Applied to Services, Reviews (split), FAQ (list + new subtitle), How We Work (centered), CTA 3 (split). **FAQ:** borders removed, cream cards with padding on all sides, 12px gap. **Before/After:** counter removed; slider uses a spring (click or drag animates with weight); 5 arrow-button explorations + "Arrow hover" preview toggle in the debug panel (pick one, then remove the rest). **CTA:** options 4/5 (form, image bg) deleted; option 3 uses split heading layout on the darker accent (`--accent-d`) so white text passes contrast; new option 4 = centered version of 3; options now 1-4, currently showing 3. Remaining: user to pick CTA 1-4 and arrow style 1-5.
- **Oct 22, 2026 (fixes):** CTA debug switcher was hitting the hero buttons wrapper because both used class `.cta`; the CTA section class is now `.cta-sec` (never reuse `.cta`/`.bar`/`.rule`-style generic class names across sections). Header on screens up to 1024px now shows logo + menu button only; links, phone and CTA moved into a full-screen menu modal (clip-path slide-down, staggered links, Escape/focus trap/scroll lock, closes on link click).
- **Oct 22, 2026 (picks):** **Before & After FINAL:** variant 1 (drag slider) showing ONE pair at a time with prev/next arrows and a counter. **Reviews FINAL:** variant 1 (3-col card grid). **FAQ FINAL:** variant 2 (sticky heading + accordion), only one question open at a time. All other variants and their debug rows removed. Added **CTA** section (`#estimate`, before the footer) with 5 explorations in the debug panel: 1 dark centered band, 2 split with image, 3 accent panel, 4 mini estimate form, 5 image background. Added footer **social icons** (Facebook, Instagram, YouTube, Google reviews; links are `#` placeholders) under the brand blurb. New images: `cta-roof` (4:3, variant 2), `cta-bg` (wide, variant 5). The primary CTA button is `href="#"` until the real estimate form/page exists. Testimonials, FAQ answers, project names are still placeholders.
- **Oct 22, 2026:** Added 3 sections with 5 live-switchable explorations each (debug panel rows Before/after, Reviews, FAQ). **Before & After** (`#projects`): 1 drag sliders in a 3-up grid, 2 side-by-side rows, 3 hover/tap flip, 4 tabs + one large slider, 5 scroll-driven wipe. **Reviews** (`#reviews`): 1 card grid, 2 big-quote carousel, 3 editorial two-column, 4 auto marquee, 5 dark masonry wall. **FAQ** (`#faq`): 1 accordion, 2 sticky heading + accordion, 3 all-open cards, 4 master-detail, 5 dark large-type. Section order: ... How We Work, Before & After, Reviews, FAQ, Footer. **All testimonials, FAQ answers, project names/cities, and before/after images are placeholders.** Testimonials must be real, attributable reviews before launch. Needed images: `assets/images/ba-{1,2,3}-{before,after}` (AVIF+WebP, same 3:2 framing and angle per pair). Pick one of each, then delete the others and the debug rows.
- **Oct 21, 2026 (final picks):** **How We Work FINAL:** light section, centered label + heading, 4 steps in a row (stack on mobile) with left-aligned text; numbered squares (neutral light grey, dark number) on a thin line; scroll fills the line in accent and each square turns accent with a white number as the line reaches it. **Footer FINAL:** option 3 (brand + 3 columns + giant centered "Alder." wordmark + legal row). All other explorations and their debug rows removed. Footer contact, address, hours, license are placeholders.
- **Oct 21, 2026:** Added 5 live-switchable explorations of **How We Work** (1 current sticky-head + vertical line, 2 horizontal timeline, 3 light 2x2 cards, 4 editorial list, 5 sticky card stack) and a complete **Footer** with 5 explorations (1 classic 4-col, 2 CTA-first, 3 giant wordmark, 4 light, 5 centered minimal). Switch via the debug panel. Footer contact details, address, hours, and license number are placeholders. **Pick one of each, then delete the others and the debug rows.** Fixed the header bug (class `.bar` collision; step rule is now `.rule`) and the multi-square bug (`.trust > span`).
- **Oct 21, 2026:** Added **How We Work** (dark band, sticky heading left, 4-step list right: inspect and quote, plan the job, build it, walk it with you; scroll-scrubbed progress line, rules draw in, numbers light up). Steps are a true sequence, so numbering is used. Copy is draft: confirm steps, one-business-day quote, and warranty with the client. Added **split-text** (word masks sliding up, custom GSAP, on scroll; hero on load) to all site text except nav, buttons, stat numbers, and the About paragraph (it keeps its scroll-fade reveal). Reduced motion and no-JS show plain text. About anchor is now `#about`; `#how-we-work` is the new section.
- **Oct 20, 2026:** Services redesigned as a two-column image-led grid (see section 8); old bento cards removed. Based on the user's uploaded files (the user's edits, including Lenis smooth scroll and the debug panel, were kept).
- **Oct 19, 2026 (prototype v2):** Prototype HTML built (`alder-landing-prototype.html`: header, hero slider, stats, About, Services). v2 changes: images moved to `assets/images/*.avif/.webp` (AVIF first); fixed header; phone styled like CTA (no bg/border); CTA hover removed; logo text+dot grouped; H1 clamp max 64px, CTA/subtitle/founder 16px via clamp; flex `gap` over margins; Container/Full-width toggle (default full, **user to choose**); About "how we work" cards REMOVED (user disliked; content belongs in the future How We Work section), replaced by founder signature + CTA row. Image optimization handled by the user's local agent (hero: no resize; about-crew resized to 840px wide).
- **Oct 19, 2026 (latest):** Added section 0, "How the Agent Should Behave" (auto-provide image/video prompts and icon keywords, include copy and motion/responsive notes with every new section, be proactive and socially aware).
- **Oct 19, 2026 (later):** Added the "live worklog" instruction at the top so any agent, including a replacement agent, keeps updating this file.
- **Oct 19, 2026:** File created. Covers theme/colors, nav, hero, stats, About (in progress), implementation rules, rationale for finished sections, and next steps.
