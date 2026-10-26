# Alder landing page audit

Prepared October 26, 2026 · Based on alder-landing-prototype.html

## Scope and limits

This audit covers the page file as it stands now, plus axe and Chromium runs at 390 px and 1440 px wide. Two limits apply:

- The image and font files were not available in the test environment, and the animation library did not load. Real page speed and the scroll animations could not be measured.
- The automated contrast check was unreliable because elements were mid-animation, so the contrast numbers below are calculated from the palette.

## Fix before launch

1. **Placeholders are still live.** `{{name}}`, `{{tel}}`, `{{email}}`, `{{brand}}`, `{{area}}`, `{{address}}`, `{{hours}}`, `{{year}}`, `{{rating}}`, `{{roofs}}` and `{{warranty}}` all appear. They are in the page title, the meta description, the `tel:` links and some image alt text. Privacy and Terms are `href="#"`. A privacy page matters because the form collects names, phone numbers and addresses.
2. **Trust content must be real.** The 4.8★ from 314 reviews, 276+ roofs, 20-year warranty, reviewer names and before/after photos are all placeholders. It is not certain the photos are real projects. The four review photos show charcoal roofs, yet two have alt text saying "Storm damage" and "Leak repair". Invented reviews or non-real before/afters on a live site are a legal and Google risk.

## SEO and sharing

- Missing: canonical link, Open Graph and Twitter tags, `theme-color`, and structured data.
- Add `RoofingContractor` data and FAQ markup. Add rating markup only once the numbers are real.
- Later, consider one page per service area. A single page limits local search.

## Performance

- **GSAP and ScrollTrigger load from a CDN** with no integrity check. Self-host them, or check whether CSS and IntersectionObserver can replace them.

## Accessibility

- **Invalid list:** `<ol class="steps">` contains a `<span class="line">` directly. Move the line outside the list.
- **Heading order:** the footer uses `<h4>` with no `<h3>` before it.
- **Tap targets on phones:** footer links are about 16 px tall and the header phone link is 28 px. Aim for 40 px or more.
- **Not checked:** whether the before/after divider works with the keyboard. This needs a manual test.
- **Already good:** skip link, focus styles, reduced-motion support, labelled form fields.

## Conversion

- Add a sticky "Call / Free estimate" bar on mobile. Most roofing leads come from phones.
- Add real proof beyond the page: a link to the Google reviews, license number, manufacturer certifications, a real crew photo and a service-area map.
- Add storm and insurance-claim questions to the FAQ.

## Cleanup

The preview adds `data-page-node-id` attributes everywhere, and the third and fourth before/after images share the same ids. Strip them when exporting.

## If you only do five

1. Add the sticky call bar on mobile.
