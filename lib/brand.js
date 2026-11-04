// lib/brand.js — brand tokens for email rendering.
//
// Reads ONLY lib/brand.generated.json (written by scripts/sync-brand.mjs at
// build time). It NEVER reads index.html at runtime, so a slow or missing page
// template can never change what an email looks like. Asset paths are prefixed
// with process.env.SITE_URL for emails (https origin, no trailing slash); the
// siteUrlPath field is the path segment below the origin.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = path.join(ROOT, 'lib', 'brand.generated.json');

const data = JSON.parse(fs.readFileSync(GENERATED, 'utf8'));

function siteUrl() {
  const raw = String(process.env.SITE_URL || '').replace(/\/+$/, '');
  return /^https:\/\//.test(raw) ? raw : '';
}

function assetUrl(p) {
  const base = siteUrl();
  if (!base) return p;
  const rel = p.replace(/^\/+/, '');
  return base + '/' + rel;
}

/** The generated brand object, with absolute asset URLs resolved for email. */
export function getBrand() {
  const logo = data.logo ? {
    onDark: assetUrl(data.logo.onDark),
    onLight: assetUrl(data.logo.onLight),
    height: data.logo.height || 36,
  } : null;
  // Inline logos as base64 data URIs so the email never depends on the site
  // still serving the file (a stale deployment 404s the remote URL and shows a
  // broken-image glyph — the reason for the "logo is broken" bug report).
  let logoInline = null;
  if (data.logo) {
    const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel)); } catch { return null; } };
    const dark = read(data.logo.onDark), light = read(data.logo.onLight);
    if (dark || light) logoInline = {
      onDark: dark ? 'data:image/png;base64,' + dark.toString('base64') : assetUrl(data.logo.onDark),
      onLight: light ? 'data:image/png;base64,' + light.toString('base64') : assetUrl(data.logo.onLight),
    };
  }
  const fonts = {
    heading: data.fonts.heading,
    body: data.fonts.body,
    fallback: data.fonts.fallback,
    headingStack: data.fonts.headingStack,
    bodyStack: data.fonts.bodyStack,
    faces: (data.fonts.faces || []).map((f) => ({
      family: f.family, weight: f.weight, style: f.style,
      file: f.file, url: assetUrl('/assets/fonts/' + f.file),
    })),
  };
  return {
    name: data.name,
    siteUrlPath: data.siteUrlPath,
    colors: { ...data.colors },
    fonts,
    logo,
    logoInline,
  };
}
