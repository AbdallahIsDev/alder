# sharp security update proposal

## Finding

Checked with `npm audit` on 2026-11-12: the direct dev dependency `sharp@0.34.5`
has one High finding inherited from libvips, libheif, and librsvg advisories:

- [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
- [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
- [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)

The audit range is `<=0.35.5-rc.1`; the reported fix is `sharp@0.35.5`. The
current manifest allows `^0.34.2`, so the fix is outside its range and npm marks
the update SemVer-major. It is not a lockfile-only fix.

## Reachability here

`sharp` is imported by image and brand build scripts and by `tests/brand.test.mjs`.
No deployed `api/` or `lib/` module imports it, so the vulnerable native libraries
are not part of the request-time function path. The build path can reach them while
processing repository-managed images and SVGs; no user-upload path was found.

## Upgrade plan

No dependency change was made because the available fix needs a `package.json`
range change. When that change is approved:

1. Update the sharp range and lockfile together, then run `npm ci`.
2. Run the image, brand, client-build, and full test checks.
3. Compare SHA-256 output hashes for `dist/index.html`, `dist/site.webmanifest`,
   `dist/robots.txt`, and `dist/sitemap.xml` against the pre-upgrade outputs.
4. Keep the upgrade only if dependency installation succeeds and all four hashes
   remain byte-identical; otherwise leave the dependency pinned and investigate the
   output differences.

No schema or application runtime change is involved.
