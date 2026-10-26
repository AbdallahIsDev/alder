/* ============================================================================
   ALDER ROOF SYSTEMS — Motion layer
   GSAP + ScrollTrigger + Lenis smooth scroll
   ----------------------------------------------------------------------------
   Everything is progressive-enhancement safe: initial hidden states are set via
   gsap.set() at runtime, so a failed CDN or prefers-reduced-motion simply
   renders the fully-readable page instead of a blank one.
   ========================================================================== */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var hasGSAP = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var animate = hasGSAP && !reduced;

  var $  = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  /* Hero photo scroll parallax, as a percentage of image height. Must stay
     BELOW --hero-over (26%) in style.css: that overscan is the slack this
     travel moves into, and overrunning it shows a bare strip at the top. */
  var HERO_PARALLAX = 18;

  /* --------------------------------------------------------------------------
     0. Preloader — always runs so the page never flashes mid-paint
     -------------------------------------------------------------------------- */
  var pre = $('.pre');
  var preNum = $('[data-pre-num]');
  var preBar = $('[data-pre-bar]');
  var preLbl = $('[data-pre-lbl]');
  var preNote = $('[data-pre-note]');
  var prePlan = $('.pre__plan');
  // Roof section — no text elements, only paths, drawn by dash offset.
  var planPaths = prePlan ? $$('path', prePlan) : [];
  var panels = $$('.pre__panel');
  var booted = false;
  var preCleared = false;
  var preFailsafe = null;

  // Readout stages. Kept short because the draw is a single ~1s sweep —
  // many labels inside one second would flash past unreadable.
  var PRE_STAGES = [
    { at: 0,  lbl: 'Setting out',       note: 'Pitch 6:12' },
    { at: 45, lbl: 'Drawing elevation', note: 'Gable roof, front view' },
    { at: 85, lbl: 'Releasing estimate', note: 'Alder Roof Systems' }
  ];

  function setPre(p) {
    var v = Math.max(0, Math.min(100, p));
    if (preNum) preNum.textContent = String(Math.round(v)).padStart(3, '0');
    if (preBar && animate) preBar.style.transform = 'scaleX(' + (v / 100) + ')';
    if (preLbl && preNote) {
      for (var i = PRE_STAGES.length - 1; i >= 0; i--) {
        if (v >= PRE_STAGES[i].at) {
          if (preLbl.textContent !== PRE_STAGES[i].lbl) preLbl.textContent = PRE_STAGES[i].lbl;
          if (preNote.textContent !== PRE_STAGES[i].note) preNote.textContent = PRE_STAGES[i].note;
          break;
        }
      }
    }
  }

  function lockScroll(on) { doc.body.classList.toggle('is-locked', !!on); }

  // NOTE: this must NOT touch `booted` — boot() owns that flag. It used to set
  // it here, which made boot()'s own guard reject the very call that needed it
  // and silently disabled every scroll animation on the page.
  function killPreloader() {
    if (preCleared) return;
    preCleared = true;
    if (preFailsafe) { clearTimeout(preFailsafe); preFailsafe = null; }
    if (pre) pre.style.display = 'none';
    panels.forEach(function (p) { p.style.display = 'none'; });
    lockScroll(false);
  }

  function runPreloader() {
    if (!pre) { boot(); return; }

    if (!animate) {
      setPre(100);
      killPreloader();
      boot();
      return;
    }

    lockScroll(true);
    setPre(0);

    // Failsafe: rAF is suspended in a backgrounded tab, which would otherwise
    // freeze the preloader overlay on top of a scroll-locked page forever.
    // Must exceed the draw + hold + split sequence.
    preFailsafe = setTimeout(function () { killPreloader(); boot(); }, 4500);
    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) { killPreloader(); boot(); }
    });

    var obj = { p: 0 };
    var tl = gsap.timeline({ onComplete: function () { killPreloader(); boot(); } });

    // Every path draws at once, in a single tween. The five build phases
    // (data-ph) are kept in the markup as documentation and as a hook for
    // re-staggering later, but the visual is one simultaneous sweep.
    var DRAW_STEP = 1.05;
    var drawDuration = 0;

    if (planPaths.length) {
      planPaths.forEach(function (path) {
        var len = 0;
        try { len = path.getTotalLength(); } catch (e) { len = 0; }
        if (!len) return;
        gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });
      });

      drawDuration = DRAW_STEP;
      tl.to(planPaths, {
        strokeDashoffset: 0,
        duration: DRAW_STEP,
        ease: 'power2.inOut'
      }, 0.05);
    }

    // The readout spans exactly the drawing. Deriving it from drawDuration (and
    // not a hand-tuned parallel tween) is what keeps the percentage honest —
    // a fixed duration here races ahead and reads 100% while the plan is bare.
    var readoutDuration = Math.max(0.9, drawDuration);
    tl.to(obj, {
      p: 100,
      duration: readoutDuration,
      ease: 'none',
      onUpdate: function () { setPre(obj.p); }
    }, 0.05);

    // Hold on the finished elevation so it actually registers, then hand off.
    tl.to('.pre__stage', { opacity: 0, y: -18, duration: 0.3, ease: 'power2.in' }, '+=0.42');

    // Diagonal split: top panel lifts up-and-right, bottom drops down-and-left,
    // opening a diagonal seam that widens to clear the viewport.
    tl.to(panels, {
      yPercent: function (i) { return i ? 108 : -108; },
      xPercent: function (i) { return i ? -14 : 14; },
      duration: 0.92,
      ease: 'power4.inOut',
      stagger: 0.06
    }, '-=0.08');

    tl.to({}, { duration: 0.14 });
  }

  /* --------------------------------------------------------------------------
     1. Smooth scroll (Lenis) wired into the GSAP ticker
     -------------------------------------------------------------------------- */
  var lenis = null;

  function initSmoothScroll() {
    if (!animate) return;
    if (typeof window.Lenis !== 'function') return;

    lenis = new window.Lenis({
      duration: 1.15,
      easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
      smoothWheel: true,
      wheelMultiplier: 0.92,
      touchMultiplier: 1.7,
      lerp: 0.1
    });

    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
    gsap.ticker.lagSmoothing(0);
  }

  /* --------------------------------------------------------------------------
     2. Text splitting — word → line masks, so reveals read as Swiss set type
     -------------------------------------------------------------------------- */
  function splitLines(el) {
    if (el.dataset.splitDone === '1') return $$('.line-i', el);
    var raw = el.textContent.replace(/\s+/g, ' ').trim();
    var words = raw.split(' ');
    if (!words.length) return [];

    el.textContent = '';
    var frag = doc.createDocumentFragment();
    words.forEach(function (w, i) {
      var s = doc.createElement('span');
      s.className = 'w';
      s.textContent = w;
      frag.appendChild(s);
      if (i < words.length - 1) frag.appendChild(doc.createTextNode(' '));
    });
    el.appendChild(frag);

    // Group words into visual lines by offsetTop
    var ws = $$('.w', el);
    var groups = [], cur = null, lastTop = null;
    ws.forEach(function (w) {
      var top = w.offsetTop;
      if (lastTop === null || Math.abs(top - lastTop) > 3) { cur = []; groups.push(cur); lastTop = top; }
      cur.push(w);
    });

    el.textContent = '';
    groups.forEach(function (g) {
      var line = doc.createElement('span');
      line.className = 'line';
      var inner = doc.createElement('span');
      inner.className = 'line-i';
      g.forEach(function (w, i) {
        if (i > 0) inner.appendChild(doc.createTextNode(' '));
        inner.appendChild(w);
      });
      line.appendChild(inner);
      el.appendChild(line);
    });

    el.dataset.splitDone = '1';
    return $$('.line-i', el);
  }

  function splitWords(el) {
    if (el.dataset.splitDone === '1') return $$('.w', el);
    var raw = el.textContent.replace(/\s+/g, ' ').trim();
    el.textContent = '';
    var words = raw.split(' ');
    var frag = doc.createDocumentFragment();
    words.forEach(function (w, i) {
      var s = doc.createElement('span');
      s.className = 'w';
      s.textContent = w;
      frag.appendChild(s);
      if (i < words.length - 1) frag.appendChild(doc.createTextNode(' '));
    });
    el.appendChild(frag);
    el.dataset.splitDone = '1';
    return $$('.w', el);
  }

  /* --------------------------------------------------------------------------
     3. Hero
     -------------------------------------------------------------------------- */
  function heroIntro() {
    var lines = $$('[data-split="lines"]').map(splitLines);
    var words = $$('[data-split="words"]').map(splitWords);
    var fade = $$('[data-hero-fade]');

    var tl = gsap.timeline({ defaults: { ease: 'power4.out' } });

    tl.from('.pre__num', { yPercent: 40, opacity: 0, duration: 0.8 }, 0);

    if (lines.length) {
      tl.from(lines, { yPercent: 118, duration: 1.05, stagger: 0.075 }, 0.05);
    }
    if (words.length) {
      tl.from(words, {
        yPercent: 105, opacity: 0, rotate: 2.2,
        duration: 0.85, stagger: 0.022
      }, 0.25);
    }
    if (fade.length) {
      tl.from(fade, { y: 22, opacity: 0, duration: 0.85, stagger: 0.07 }, 0.42);
    }

    // Hero placeholder image: scale-in from a tighter crop
    var heroImg = $('.hero__ph img');
    if (heroImg) {
      tl.fromTo(heroImg, { scale: 1.14 }, { scale: 1, duration: 1.5, ease: 'power3.out' }, 0.1);
    }
    tl.from('.hero__ph', { clipPath: 'inset(0% 0% 100% 0%)', duration: 1.2, ease: 'power4.inOut' }, 0.12);

    // Hero parallax on scroll-out. Doubled from 9% because the photo is now a
    // 16:9 band; the --hero-over overscan keeps the frame covered throughout.
    if (heroImg) {
      gsap.to(heroImg, {
        yPercent: HERO_PARALLAX,
        ease: 'none',
        scrollTrigger: { trigger: '.hero__media', start: 'top bottom', end: 'bottom top', scrub: 0.6 }
      });
    }
    gsap.to('.hero__title', {
      yPercent: -8, opacity: 0.25,
      ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 0.6 }
    });

    return tl;
  }

  /* --------------------------------------------------------------------------
     4. Generic scroll reveals
     -------------------------------------------------------------------------- */
  function reveals() {
    // [data-reveal] — fade + rise, batched
    var singles = $$('[data-reveal]');
    singles.forEach(function (el) {
      var delay = parseFloat(el.dataset.reveal) || 0;
      gsap.fromTo(el,
        { y: 34, opacity: 0 },
        {
          y: 0, opacity: 1, duration: 0.95, delay: delay, ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 88%', once: true }
        });
    });

    // [data-reveal-stagger] — children cascade
    $$('[data-reveal-stagger]').forEach(function (parent) {
      var kids = Array.prototype.slice.call(parent.children);
      gsap.fromTo(kids,
        { y: 40, opacity: 0 },
        {
          y: 0, opacity: 1, duration: 0.9, ease: 'power3.out',
          stagger: 0.08,
          scrollTrigger: { trigger: parent, start: 'top 85%', once: true }
        });
    });

    // Section headings — line mask reveal
    $$('[data-split="lines"]').forEach(function (el) {
      if (el.closest('.hero')) return;
      var lines = splitLines(el);
      gsap.from(lines, {
        yPercent: 115, duration: 1, ease: 'power4.out', stagger: 0.08,
        scrollTrigger: { trigger: el, start: 'top 88%', once: true }
      });
    });

    // Manifesto — word cascade
    $$('[data-split="words"]').forEach(function (el) {
      if (el.closest('.hero')) return;
      var words = splitWords(el);
      gsap.from(words, {
        yPercent: 108, opacity: 0, duration: 0.8, ease: 'power3.out', stagger: 0.012,
        scrollTrigger: { trigger: el, start: 'top 84%', once: true }
      });
    });

    // Hairline rules that draw themselves
    $$('.rule[data-draw]').forEach(function (r) {
      gsap.fromTo(r, { scaleX: 0 }, {
        scaleX: 1, duration: 1.15, ease: 'power3.inOut', transformOrigin: '0 50%',
        scrollTrigger: { trigger: r, start: 'top 92%', once: true }
      });
    });

    // Placeholder / content image parallax inside overflow frames
    $$('.ph-frame').forEach(function (frame) {
      var img = $('img', frame);
      if (!img) return;
      gsap.fromTo(img, { yPercent: -7, scale: 1.1 }, {
        yPercent: 7, scale: 1.1, ease: 'none',
        scrollTrigger: { trigger: frame, start: 'top bottom', end: 'bottom top', scrub: 0.7 }
      });
    });
  }

  /* --------------------------------------------------------------------------
     5. Counters
     -------------------------------------------------------------------------- */
  // With animation disabled the tween never runs, so the markup's initial "0"
  // would be what a reader actually sees. Print the real figures instead.
  function countersFinal() {
    $$('[data-count]').forEach(function (el) {
      var target = parseFloat(el.dataset.count);
      if (!isNaN(target)) el.textContent = target.toLocaleString('en-US');
    });
  }

  function counters() {
    $$('[data-count]').forEach(function (el) {
      var target = parseFloat(el.dataset.count);
      var decimals = (el.dataset.count.split('.')[1] || '').length;
      var o = { v: 0 };
      el.textContent = (0).toFixed(decimals);
      ScrollTrigger.create({
        trigger: el, start: 'top 88%', once: true,
        onEnter: function () {
          gsap.to(o, {
            v: target, duration: 1.9, ease: 'power2.out',
            onUpdate: function () { el.textContent = o.v.toFixed(decimals); }
          });
        }
      });
    });
  }

  /* --------------------------------------------------------------------------
     6. Pinned horizontal project rail (desktop) / swipe rail (mobile)
     -------------------------------------------------------------------------- */
  function projectRail() {
    var section = $('.proj');
    var track = $('[data-htrack]');
    if (!section || !track) return;

    var mm = gsap.matchMedia();

    mm.add('(min-width: 981px)', function () {
      var all = Array.prototype.slice.call(track.children);
      var items = all.filter(function (el) { return !el.classList.contains('pcard--tail'); });

      // Measure the track's own scrollable width. Using window.innerWidth here
      // is wrong: the track has horizontal padding, so innerWidth can equal or
      // exceed the content width and collapse the travel distance to zero.
      var distance = function () {
        return Math.max(0, track.scrollWidth - track.parentElement.clientWidth);
      };

      var tl = gsap.to(items, {
        x: function () { return -distance(); },
        ease: 'none',
        scrollTrigger: {
          trigger: section,
          pin: true,
          scrub: 0.8,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          end: function () { return '+=' + (distance() * 1.05); }
        }
      });

      // Rail progress indicator
      var bar = $('.proj__bar i');
      if (bar) {
        gsap.fromTo(bar, { xPercent: -100 }, {
          xPercent: 200, ease: 'none',
          scrollTrigger: {
            trigger: section, start: 'top top',
            end: function () { return '+=' + (distance() * 1.05); },
            scrub: 0.6
          }
        });
      }

      // Card images counter-parallax. (Not containerAnimation — that only
      // applies to pinned containers built by ScrollTrigger's horizontal
      // helper, which this hand-rolled rail is not.)
      items.forEach(function (card) {
        var img = $('img', card);
        if (!img) return;
        gsap.fromTo(img, { xPercent: 7 }, {
          xPercent: -7, ease: 'none',
          scrollTrigger: {
            trigger: card,
            start: 'left right', end: 'right left', scrub: 0.6
          }
        });
      });
    });

    mm.add('(max-width: 980px)', function () {
      var vp = $('[data-hviewport]');
      if (vp) { vp.style.overflowX = 'auto'; }
    });
  }

  /* --------------------------------------------------------------------------
     7. Marquee — seamless, resize-safe
     -------------------------------------------------------------------------- */
  function marquee() {
    $$('.marquee__track').forEach(function (track) {
      var base = track.innerHTML;
      track.innerHTML = base + base; // duplicate for a seamless -50% loop

      gsap.to(track, {
        xPercent: -50,
        duration: parseFloat(track.dataset.speed) || 26,
        ease: 'none',
        repeat: -1
      });
    });
  }

  /* --------------------------------------------------------------------------
     8. Nav: pinned permanently + scroll progress bar
     -------------------------------------------------------------------------- */
  function navBehaviour() {
    var nav = $('.nav');
    if (!nav) return;

    // Header stays fixed and visible at all times — only the bottom hairline
    // appears once you leave the top. No hide-on-scroll.
    ScrollTrigger.create({
      start: 'top -80',
      end: 99999,
      onUpdate: function (self) {
        nav.classList.toggle('is-stuck', self.scroll() > 80);
      }
    });

    var bar = $('.prog__bar');
    if (bar) {
      gsap.to(bar, {
        scaleX: 1, ease: 'none',
        scrollTrigger: { trigger: doc.body, start: 'top top', end: 'bottom bottom', scrub: 0.3 }
      });
    }
  }

  /* --------------------------------------------------------------------------
     9. Mobile menu
     -------------------------------------------------------------------------- */
  function mobileMenu() {
    if (mobileMenu._wired) return;
    mobileMenu._wired = true;

    var burger = $('.burger');
    var menu = $('.mmenu');
    if (!burger || !menu) return;
    var open = false;
    var links = $$('.mmenu__links a');
    var foot = $$('.mmenu__foot > *');

    // Explicit fromTo tweens rather than one paused timeline: a paused timeline
    // captures its start values on first render, which races with the initial
    // gsap.set() below and left the panel parked off-screen.
    function setState(next) {
      if (open === next) return;
      open = next;
      burger.classList.toggle('is-on', open);
      doc.body.classList.toggle('is-locked', open);
      nav_setHidden(open);

      if (!animate) {
        gsap.set(menu, {
          display: next ? 'flex' : 'none',
          yPercent: next ? 0 : -101,
          visibility: next ? 'visible' : 'hidden'
        });
        gsap.set(links, { y: 0, opacity: next ? 1 : 0 });
        return;
      }

      if (open) {
        gsap.killTweensOf([menu, links, foot]);
        gsap.set(menu, { display: 'flex', visibility: 'visible' });
        gsap.fromTo(menu, { yPercent: -101 }, { yPercent: 0, duration: 0.62, ease: 'power4.inOut' });
        gsap.fromTo(links, { y: 44, opacity: 0 }, {
          y: 0, opacity: 1, duration: 0.6, ease: 'power3.out', stagger: 0.055, delay: 0.28
        });
        gsap.fromTo(foot, { y: 24, opacity: 0 }, {
          y: 0, opacity: 1, duration: 0.5, ease: 'power3.out', stagger: 0.06, delay: 0.34
        });
      } else {
        gsap.killTweensOf(links);
        gsap.to(links, { y: 20, opacity: 0, duration: 0.26, ease: 'power2.in' });
        gsap.to(menu, {
          yPercent: -101, duration: 0.55, ease: 'power4.inOut',
          onComplete: function () { gsap.set(menu, { display: 'none' }); }
        });
      }
    }

    gsap.set(menu, { display: 'flex', yPercent: -101, visibility: 'hidden' });
    gsap.set(links, { y: 0, opacity: 1 });

    burger.addEventListener('click', function () { setState(!open); });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setState(false);
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) setState(false);
    });
    window.addEventListener('resize', function () {
      if (open && window.innerWidth > 980) setState(false);
    });
  }

  function nav_setHidden(v) {
    // No-op: the header is permanently pinned. Kept as a call-site-compatible
    // stub because the mobile menu still references it — previously this hid
    // the header (and therefore the close "X") while the menu was open, leaving
    // no visible way to dismiss it.
  }

  /* --------------------------------------------------------------------------
     10. Smooth anchor navigation
     -------------------------------------------------------------------------- */
  function anchors() {
    if (anchors._wired) return;
    anchors._wired = true;

    $$('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var id = a.getAttribute('href');
        if (!id || id === '#') return;
        var target = doc.querySelector(id);
        if (!target) return;
        e.preventDefault();
        var offset = id === '#top' ? 0 : -60;
        if (lenis) lenis.scrollTo(target, { offset: offset, duration: 1.35 });
        else target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
      });
    });
  }

  /* --------------------------------------------------------------------------
     11. Accordion
     -------------------------------------------------------------------------- */
  function accordion() {
    // Guard: accordion() is reached from both initUI() and boot(). Without this
    // a single click fires two handlers — open, then immediately close again.
    if (accordion._wired) return;
    accordion._wired = true;

    $$('.acc__btn').forEach(function (btn) {
      var item = btn.closest('.acc__item');
      var panel = $('.acc__panel', item);
      var inner = $('.acc__panel-in', item);
      if (!panel || !inner) return;

      btn.setAttribute('aria-expanded', 'false');

      btn.addEventListener('click', function () {
        var isOpen = item.classList.contains('is-open');
        $$('.acc__item.is-open').forEach(function (other) {
          if (other === item) return;
          other.classList.remove('is-open');
          var op = $('.acc__panel', other);
          var oi = $('.acc__panel-in', other);
          $('.acc__btn', other).setAttribute('aria-expanded', 'false');
          if (animate) {
            gsap.to(op, { height: 0, duration: 0.5, ease: 'power3.inOut' });
            gsap.to(oi, { y: -12, opacity: 0, duration: 0.35, ease: 'power2.in' });
          } else { op.style.height = 0; }
        });

        if (isOpen) {
          item.classList.remove('is-open');
          btn.setAttribute('aria-expanded', 'false');
          if (animate) {
            gsap.to(panel, { height: 0, duration: 0.5, ease: 'power3.inOut' });
            gsap.to(inner, { y: -12, opacity: 0, duration: 0.35, ease: 'power2.in' });
          } else { panel.style.height = 0; }
        } else {
          item.classList.add('is-open');
          btn.setAttribute('aria-expanded', 'true');
          if (animate) {
            gsap.set(inner, { y: 12, opacity: 0 });
            gsap.to(panel, { height: inner.offsetHeight, duration: 0.6, ease: 'power3.out' });
            gsap.to(inner, { y: 0, opacity: 1, duration: 0.5, ease: 'power2.out' }, '-=0.36');
          } else { panel.style.height = 'auto'; }
        }
      });
    });

    // Open the first item by default for scannability
    var first = $('.acc__item');
    if (first) {
      var p = $('.acc__panel', first), i = $('.acc__panel-in', first);
      if (p && i) {
        first.classList.add('is-open');
        p.style.height = 'auto';
        $('.acc__btn', first).setAttribute('aria-expanded', 'true');
      }
    }
  }

  /* --------------------------------------------------------------------------
     12. Form — client-side validation + success state
     -------------------------------------------------------------------------- */
  function form() {
    if (form._wired) return;
    form._wired = true;

    var f = $('.form');
    if (!f) return;
    var ok = $('.form-ok');

    function fieldError(input, msg) {
      var fld = input.closest('.fld');
      if (!fld) return;
      fld.classList.toggle('fld--invalid', !!msg);
      var err = $('.fld__err', fld);
      if (err) err.textContent = msg || '';
    }

    function validate(input) {
      var v = (input.value || '').trim();
      var lbl = (input.getAttribute('data-label') || 'This field');
      if (input.hasAttribute('required') && !v) { fieldError(input, lbl + ' is required'); return false; }
      if (input.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
        fieldError(input, 'Enter a valid email address'); return false;
      }
      if (input.type === 'tel' && v && v.replace(/\D/g, '').length < 7) {
        fieldError(input, 'Enter a valid phone number'); return false;
      }
      fieldError(input, '');
      return true;
    }

    $$('input, textarea, select', f).forEach(function (input) {
      input.addEventListener('blur', function () { validate(input); });
      input.addEventListener('input', function () {
        var fld = input.closest('.fld');
        if (fld && fld.classList.contains('fld--invalid')) validate(input);
      });
    });

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var inputs = $$('input, textarea, select', f).filter(function (i) { return i.type !== 'hidden'; });
      var valid = true;
      inputs.forEach(function (i) { if (!validate(i)) valid = false; });
      if (!valid) {
        var bad = $('.fld--invalid .fld__control', f);
        if (bad) bad.focus();
        return;
      }

      var btn = $('button[type="submit"]', f);
      if (btn) { btn.setAttribute('disabled', 'disabled'); btn.classList.add('is-sent-busy'); }

      /* ── Wire this to your backend ───────────────────────────────────────
         Option A (Netlify/Vercel static deploy): remove the JS preventDefault
         below and add netlify/netlify-honeypot to the <form>.
         Option B (Formspree / Basin / own API): replace the setTimeout with —
             fetch('https://formspree.io/f/YOUR_ID', {
               method: 'POST',
               headers: { 'Accept': 'application/json' },
               body: new FormData(f)
             }).then(...)
      ─────────────────────────────────────────────────────────────────── */
      setTimeout(function () {
        f.classList.add('is-sent');
        if (ok) {
          var name = (f.querySelector('[name="name"]') || {}).value || 'there';
          var slot = $('.form-ok__name', ok);
          if (slot) slot.textContent = name.trim().split(' ')[0];
          ok.classList.add('is-on');
        }
      }, 850);
    });
  }

  /* --------------------------------------------------------------------------
     13. Footer wordmark — a slow, confident settle
     -------------------------------------------------------------------------- */
  function footerWord() {
    var el = $('.foot__word span');
    if (!el) return;
    var raw = el.textContent.trim();
    el.textContent = '';
    var frag = doc.createDocumentFragment();
    raw.split('').forEach(function (ch) {
      var s = doc.createElement('span');
      s.textContent = ch;
      frag.appendChild(s);
    });
    el.appendChild(frag);
    var chars = Array.prototype.slice.call(el.children);
    gsap.from(chars, {
      yPercent: 105, duration: 0.9, ease: 'power4.out', stagger: 0.035,
      scrollTrigger: { trigger: el, start: 'top 92%', once: true }
    });
  }

  /* --------------------------------------------------------------------------
     14. Boot
     -------------------------------------------------------------------------- */
  function boot() {
    if (booted) return;
    booted = true;

    if (doc.fonts && doc.fonts.ready) {
      doc.fonts.ready.then(function () { ScrollTrigger.refresh(); });
    }

    if (!animate) {
      // No motion: make sure nothing is left in a hidden or placeholder state.
      countersFinal();
      gsap && ScrollTrigger && ScrollTrigger.refresh();
      return;
    }

    gsap.registerPlugin(ScrollTrigger);
    ScrollTrigger.config({ ignoreMobileResize: true });

    initSmoothScroll();
    heroIntro();
    reveals();
    counters();
    projectRail();
    marquee();
    navBehaviour();
    footerWord();
    window.addEventListener('load', function () { ScrollTrigger.refresh(); });
  }

  // Non-motion UI still needs wiring (menu, accordion, anchors, form)
  function initUI() {
    gsap && ScrollTrigger && gsap.registerPlugin(ScrollTrigger);
    mobileMenu();
    anchors();
    accordion();
    form();
    if (!animate) {
      $$('[data-split]').forEach(function (el) { el.dataset.splitDone = '1'; });
      ScrollTrigger && ScrollTrigger.refresh();
    }
  }

  if (hasGSAP) {
    initUI();
    runPreloader();
  } else {
    // GSAP blocked / offline: strip the preloader, show everything
    initUI();
    killPreloader();
  }
})();
