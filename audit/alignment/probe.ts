/**
 * The layout probe: what is wrong with this page, measured rather than eyeballed.
 *
 * This function is serialised into the browser by `page.evaluate`, so it must
 * be self-contained — no imports, no closure over anything in the spec, and no
 * TypeScript that needs a runtime helper (no enums, no class fields, no
 * decorators). Type annotations are fine; they are stripped before it ships.
 *
 * ## Why measure instead of compare images
 *
 * A screenshot diff tells you two renders differ. It cannot tell you *why*, it
 * cannot tell you which component owns the defect, and on a first audit there
 * is no baseline to differ from. Every check here reads the box model the
 * engine actually computed, so a finding arrives already naming the element,
 * the numbers, and the shared component to fix it in — which is what turns 800
 * screenshots into a report with a handful of root causes.
 *
 * ## What `owner` is for
 *
 * The point of the audit is to fix shared components once rather than pages
 * forty-five times, so every finding is attributed: the first class on the
 * element or its ancestors that belongs to a shared component wins, and only
 * when nothing matches does the finding fall to the page itself. Grouping the
 * report by `owner` is then the same thing as grouping by root cause.
 */

export interface Finding {
  /** Category slug, matching the audit's check list. */
  check: string;
  /** A short, readable path to the element. */
  sel: string;
  /** The shared component to blame, or `page` when it is one page's own. */
  owner: string;
  /** The measurement, in words and numbers. */
  detail: string;
  severity: 'high' | 'med' | 'low';
}

export function probe(theme: 'light' | 'dark'): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  /*
   * Declared inside, not above.
   *
   * `page.evaluate` ships this function's *source* to the browser, where it is
   * evaluated with no module around it — so a reference to a module-level
   * const is a ReferenceError at the point it is read, which is deep inside a
   * loop and a long way from the line that looks wrong. Everything this
   * function needs is therefore local to it, including the constants.
   *
   * `TOKENS` is the spacing scale from `global.css` (`--sp-1`..`--sp-5`) plus
   * the values a layout legitimately needs outside it: zero, and the 1–2px
   * hairlines and optical nudges that are not spacing decisions.
   * `CTRL_H` is `--h-ctl-sm`, `--h-ctl`, `--h-in` and `--h-ctl-lg`.
   */
  const TOKENS = [0, 1, 2, 6, 10, 16, 22, 32];
  const CTRL_H = [32, 38, 40, 44];

  const add = (
    check: string, el: Element | null, detail: string,
    severity: 'high' | 'med' | 'low',
  ) => {
    const sel = el ? path(el) : '(document)';
    const owner = el ? ownerOf(el) : 'page';
    /* One finding per element per check: a flex row with eight ragged buttons
       is one bug to fix, not eight lines in a table. */
    const key = check + '|' + sel + '|' + detail;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ check, sel, owner, detail, severity });
  };

  /* ------------------------------------------------------------------ paths */

  function label(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return tag + cls;
  }

  function path(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; cur && i < 3 && cur !== document.body; i += 1) {
      parts.unshift(label(cur));
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /**
   * Which shared component owns an element. Ordered most specific first,
   * because `.card-b` inside `.tbl-wrap` is the table's problem, not the
   * card's — the nearer class is the one whose CSS set the box.
   */
  const OWNERS: [string, string][] = [
    ['tbl-wrap', 'TableWrap (ui.tsx)'],
    ['tbl', 'Table (ui.tsx)'],
    ['tabs', 'Tabs (ui.tsx)'],
    ['toolbar', 'toolbar (global.css)'],
    ['field', 'field (global.css)'],
    ['card-h', 'Card header (ui.tsx)'],
    ['card-b', 'Card body (ui.tsx)'],
    ['card', 'Card (ui.tsx)'],
    ['kv', 'KV (ui.tsx)'],
    ['seg', 'Seg (ui.tsx)'],
    ['pager', 'Pager (ui.tsx)'],
    ['badge', 'Badge (ui.tsx)'],
    ['tile', 'Tile (ui.tsx)'],
    ['statrow', 'StatRow (ui.tsx)'],
    ['empty', 'EmptyState (ui.tsx)'],
    ['retry', 'RetryNotice (ui.tsx)'],
    ['banner', 'Banner (ui.tsx)'],
    ['modal-f', 'Layer footer (Layer.tsx)'],
    ['modal-h', 'Layer header (Layer.tsx)'],
    ['modal-b', 'Layer body (Layer.tsx)'],
    ['modal', 'Layer modal (Layer.tsx)'],
    ['drawer', 'Layer drawer (Layer.tsx)'],
    ['topbar', 'TopBar (shell)'],
    ['nav-fly', 'Menu flyout (Menu.tsx)'],
    ['nav', 'Menu rail (Menu.tsx)'],
    ['btn', 'button (global.css)'],
    ['row', 'row (global.css)'],
    ['grid', 'grid (global.css)'],
  ];

  function ownerOf(el: Element): string {
    let cur: Element | null = el;
    for (let i = 0; cur && i < 8; i += 1) {
      const classes = typeof cur.className === 'string'
        ? cur.className.trim().split(/\s+/) : [];
      for (let j = 0; j < OWNERS.length; j += 1) {
        if (classes.indexOf(OWNERS[j]![0]) !== -1) return OWNERS[j]![1];
      }
      cur = cur.parentElement;
    }
    return 'page';
  }

  /* ------------------------------------------------------------- primitives */

  const cs = (el: Element) => getComputedStyle(el);

  function visible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) return false;
    const s = cs(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    return parseFloat(s.opacity || '1') > 0.05;
  }

  /** The roots worth scanning: the page, the chrome, and anything open over it. */
  function roots(): Element[] {
    const found: Element[] = [];
    const sels = ['main', 'header.topbar', '.modal', '.drawer', '.nav-fly'];
    for (let i = 0; i < sels.length; i += 1) {
      const list = document.querySelectorAll(sels[i]!);
      for (let j = 0; j < list.length; j += 1) {
        if (visible(list[j]!)) found.push(list[j]!);
      }
    }
    return found;
  }

  function walk(root: Element): Element[] {
    const all = root.querySelectorAll('*');
    const kept: Element[] = [];
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i]!;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'defs'
        || tag === 'path' || tag === 'circle' || tag === 'rect'
        || tag === 'line' || tag === 'g' || tag === 'clippath') continue;
      if (!visible(el)) continue;
      kept.push(el);
    }
    return kept;
  }

  /** Does this element hold text of its own, rather than only child elements? */
  function ownText(el: Element): string {
    let text = '';
    for (let i = 0; i < el.childNodes.length; i += 1) {
      const n = el.childNodes[i]!;
      if (n.nodeType === 3) text += n.textContent || '';
    }
    return text.trim();
  }

  /** The box the text itself occupies, which is not the element's own box. */
  function textRect(el: Element): DOMRect | null {
    const range = document.createRange();
    let got: DOMRect | null = null;
    for (let i = 0; i < el.childNodes.length; i += 1) {
      const n = el.childNodes[i]!;
      if (n.nodeType !== 3 || !(n.textContent || '').trim()) continue;
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width < 0.5 && r.height < 0.5) continue;
      if (!got) { got = r; continue; }
      const left = Math.min(got.left, r.left);
      const top = Math.min(got.top, r.top);
      const right = Math.max(got.right, r.right);
      const bottom = Math.max(got.bottom, r.bottom);
      got = new DOMRect(left, top, right - left, bottom - top);
    }
    range.detach();
    return got;
  }

  const spread = (ns: number[]) => Math.max.apply(null, ns) - Math.min.apply(null, ns);
  const r1 = (n: number) => Math.round(n * 10) / 10;

  /* ----------------------------------------------------------------- colour */

  function parseColour(v: string): [number, number, number, number] | null {
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1]!.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length < 3) return null;
    return [parts[0]!, parts[1]!, parts[2]!, parts.length > 3 ? parts[3]! : 1];
  }

  /**
   * The colour actually behind an element's own text, compositing every
   * translucent layer.
   *
   * Starts at `el`, not at its parent. An element that carries both a
   * background and its own text — an avatar with initials in it, a badge, a
   * filled button — *is* the background its text sits on, and starting a step
   * up measured the white card behind the avatar instead of the avatar. That
   * reported white-on-white at 1:1 for every avatar on every page, ten
   * thousand findings of it, and would have put a fabricated contrast crisis
   * at the top of the report.
   */
  function behind(el: Element): [number, number, number] | null {
    const layers: [number, number, number, number][] = [];
    let cur: Element | null = el;
    while (cur) {
      const style = cs(cur);
      /*
       * A painted image — a gradient, a photograph — and the composite stops
       * being arithmetic this can do. `background-color` on such an element is
       * `transparent`, so without this the walk goes straight past it to the
       * page and reports the text against a canvas it is nowhere near.
       *
       * That is not hypothetical and it is not rare: `.punch-card` is
       * `linear-gradient(135deg, var(--brand), var(--s7))` with white text, and
       * the first audit reported its clock, its labels, its buttons and its
       * badges at **1.1:1** — white on white — on every page the card appears
       * on. White on the brand gradient is fine; the finding was the probe's.
       *
       * Null rather than a guess, and the caller skips the element. A sampled
       * midpoint would be a number, and a number is what somebody acts on: it
       * would send them to change a colour that is correct. "I cannot tell"
       * is the honest answer, and these are a handful of components that a
       * person can check by eye.
       */
      if (style.backgroundImage && style.backgroundImage !== 'none') return null;
      const c = parseColour(style.backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 0.999) break;
      }
      cur = cur.parentElement;
    }
    /* Nothing opaque found: the canvas. Which colour that is depends on the
       theme, and guessing white here is how a dark-theme audit invents
       hundreds of contrast failures that do not exist. */
    let base: [number, number, number] = theme === 'dark' ? [8, 12, 18] : [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const l = layers[i]!;
      base = [
        l[0] * l[3] + base[0] * (1 - l[3]),
        l[1] * l[3] + base[1] * (1 - l[3]),
        l[2] * l[3] + base[2] * (1 - l[3]),
      ];
    }
    return base;
  }

  function lum(rgb: [number, number, number]): number {
    const f = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  function contrast(a: [number, number, number], b: [number, number, number]): number {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /* ================================================================ checks */

  const scanned = roots();
  const vw = window.innerWidth;

  /* 1. the page itself scrolls sideways ---------------------------------- */
  const docW = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0,
  );
  if (docW > vw + 1) {
    add('page-h-scroll', document.body,
      'the document scrolls sideways: ' + docW + 'px of content in a ' + vw + 'px viewport',
      'high');
  }

  /** Is this element inside something that is allowed to scroll sideways? */
  function scrollableAncestor(el: Element): boolean {
    let cur: Element | null = el.parentElement;
    while (cur && cur !== document.body) {
      const ox = cs(cur).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  for (let i = 0; i < scanned.length; i += 1) {
    const els = walk(scanned[i]!);

    for (let j = 0; j < els.length; j += 1) {
      const el = els[j]!;
      const r = el.getBoundingClientRect();
      const s = cs(el);

      /* 2. content past the right edge, with nothing to scroll it --------- */
      if (r.right > vw + 1 && r.width > 2 && !scrollableAncestor(el)
        && s.position !== 'fixed') {
        add('overflows-viewport', el,
          'right edge at ' + r1(r.right) + 'px, past the ' + vw + 'px viewport,'
          + ' and no scrollable ancestor',
          'high');
      }

      /* 3. text clipped or spilling out of its box ------------------------ */
      const text = ownText(el);
      if (text) {
        const clippedX = el.scrollWidth > el.clientWidth + 1;
        const clippedY = el.scrollHeight > el.clientHeight + 1;
        const hiddenX = s.overflowX === 'hidden' || s.overflowX === 'clip';
        const hiddenY = s.overflowY === 'hidden' || s.overflowY === 'clip';
        const ellipsis = s.textOverflow === 'ellipsis';
        /*
         * A line clamp is somebody saying "show two lines and hide the rest",
         * which is the same measurement as text being clipped by accident and
         * the opposite intention. `.ann-body` is `-webkit-line-clamp:2` with
         * an `.open` class that lifts it, and the audit reported its 34
         * announcements as text cut off — the one case where the clipping is
         * the feature.
         *
         * Read from the computed style rather than from a class list, so it
         * holds for any element that declares one, and only for the vertical
         * check: a clamp says nothing about text being cut off sideways.
         */
        const clamped = s.webkitLineClamp !== undefined
          && s.webkitLineClamp !== ''
          && s.webkitLineClamp !== 'none';
        if (clippedX && hiddenX && !ellipsis) {
          add('text-clipped', el,
            'text is cut off: ' + el.scrollWidth + 'px of text in a '
            + el.clientWidth + 'px box, overflow hidden with no ellipsis'
            + ' — "' + text.slice(0, 40) + '"',
            'high');
        }
        if (clippedY && hiddenY && !clamped) {
          add('text-clipped', el,
            'text is cut off vertically: ' + el.scrollHeight + 'px in a '
            + el.clientHeight + 'px box — "' + text.slice(0, 40) + '"',
            'high');
        }
        /* A fixed height with visible overflow does not clip — it spills,
           which reads as text sitting on top of whatever is below. */
        if (!hiddenY && clippedY && s.height !== 'auto'
          && el.scrollHeight > el.clientHeight + 3) {
          add('text-overflows', el,
            'text spills out of a fixed-height box: ' + el.scrollHeight
            + 'px in ' + el.clientHeight + 'px — "' + text.slice(0, 40) + '"',
            'med');
        }

        /* 10. contrast ---------------------------------------------------- */
        const fgc = parseColour(s.color);
        /* `behind` returns null when something in the stack is painted with an
           image, which this cannot composite. Skipped rather than guessed. */
        const bg = fgc && fgc[3] > 0.1 && r.height > 2 ? behind(el) : null;
        if (fgc && bg) {
          const fg: [number, number, number] = fgc[3] >= 0.999 ? [fgc[0], fgc[1], fgc[2]] : [
            fgc[0] * fgc[3] + bg[0] * (1 - fgc[3]),
            fgc[1] * fgc[3] + bg[1] * (1 - fgc[3]),
            fgc[2] * fgc[3] + bg[2] * (1 - fgc[3]),
          ];
          const size = parseFloat(s.fontSize || '16');
          const weight = parseInt(s.fontWeight || '400', 10);
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const need = large ? 3 : 4.5;
          const got = contrast(fg, bg);
          if (got < need) {
            add('contrast', el,
              'contrast ' + r1(got) + ':1 against its background, below the '
              + need + ':1 this text size needs (' + s.color + ' on rgb('
              + Math.round(bg[0]) + ', ' + Math.round(bg[1]) + ', '
              + Math.round(bg[2]) + ')) — "' + text.slice(0, 30) + '"',
              got < need - 1.5 ? 'high' : 'med');
          }
        }
      }

      /*
       * 11. a light box left behind in the dark theme ---------------------
       *
       * `.swatch-light` is exempt, and so is anything inside one. It is the
       * class the stylesheet gives to a surface that stays light in both
       * themes on purpose — the logo preview, which exists to show the mark on
       * the white it will be printed on. Theming it would make the preview a
       * picture of something that never happens.
       *
       * An opt-out the markup has to ask for, not a selector list kept here:
       * this check cannot tell a decision from an oversight, and the only
       * place that knows is the code that made it. Without one, a deliberate
       * light surface is reported on every dark capture for ever, and a
       * finding nobody can ever close is a finding everybody learns to skip.
       */
      if (theme === 'dark' && r.width > 8 && r.height > 8 && !el.closest('.swatch-light')) {
        const bgc = parseColour(s.backgroundColor);
        if (bgc && bgc[3] > 0.5 && lum([bgc[0], bgc[1], bgc[2]]) > 0.6) {
          add('light-box-in-dark', el,
            'a light surface in the dark theme: background ' + s.backgroundColor
            + ' on a ' + r1(r.width) + '×' + r1(r.height) + 'px box',
            'high');
        }
      }

      /* 9. one-off spacing written inline rather than taken from a token -- */
      const inline = el.getAttribute('style');
      if (inline && /(margin|padding|gap)/.test(inline)) {
        const nums = inline.match(/(?:margin|padding|gap)[^;:]*:\s*([^;]+)/g) || [];
        for (let k = 0; k < nums.length; k += 1) {
          const pxs = nums[k]!.match(/(\d+(?:\.\d+)?)px/g) || [];
          for (let m = 0; m < pxs.length; m += 1) {
            const n = parseFloat(pxs[m]!);
            if (TOKENS.indexOf(n) === -1) {
              add('spacing-off-token', el,
                'inline ' + nums[k]!.trim() + ' — ' + n
                + 'px is not on the --sp scale (6/10/16/22/32)',
                'low');
            }
          }
        }
      }
    }

    /* 4. siblings overlapping each other -------------------------------- */
    const parents = [scanned[i]!].concat(els);
    for (let p = 0; p < parents.length; p += 1) {
      /*
       * Not inside an `<svg>`. The shapes in an icon overlap each other by
       * design — that is what draws the icon — and comparing them produced
       * three thousand findings that all said "a path overlaps a path".
       */
      if (parents[p]!.closest('svg')) continue;
      const kids: Element[] = [];
      const children = parents[p]!.children;
      for (let c = 0; c < children.length; c += 1) {
        const k = children[c]!;
        if (!visible(k)) continue;
        const ks = cs(k);
        if (ks.position === 'absolute' || ks.position === 'fixed'
          || ks.position === 'sticky') continue;
        /* A negative margin is somebody deliberately overlapping two things —
           stacked avatars are the usual one — so it is not a finding. */
        if (parseFloat(ks.marginLeft) < 0 || parseFloat(ks.marginTop) < 0
          || parseFloat(ks.marginRight) < 0 || parseFloat(ks.marginBottom) < 0) continue;
        if (ks.float !== 'none') continue;
        kids.push(k);
      }
      /*
       * Per line box, not the union of them.
       *
       * `getBoundingClientRect()` on an inline element that wraps returns one
       * rectangle covering every line it occupies — so a sentence running over
       * two lines reports a box the full width of its container and two lines
       * tall, and every inline sibling sitting on the first line falls inside
       * it. Nothing overlaps on screen; the union does.
       *
       * That was most of this check's output: a `.badge` next to a wrapping
       * `.muted` in a narrow `dd` "overlapped" it by 66×21px on six pages, and
       * the same shape produced the `td > b` and `td > span.dot` findings.
       * `getClientRects()` gives the boxes a reader actually sees, one per
       * line, and two elements overlap only when some pair of those meets.
       *
       * Falls back to the bounding rect when there are no client rects, which
       * is what a replaced or empty element returns.
       */
      const boxesOf = (el: Element): DOMRect[] => {
        const list = el.getClientRects();
        const out: DOMRect[] = [];
        for (let r = 0; r < list.length; r += 1) out.push(list[r]!);
        return out.length ? out : [el.getBoundingClientRect()];
      };

      for (let a = 0; a < kids.length; a += 1) {
        for (let b = a + 1; b < kids.length; b += 1) {
          const as = boxesOf(kids[a]!);
          const bs = boxesOf(kids[b]!);
          let ox = 0;
          let oy = 0;
          for (let m = 0; m < as.length; m += 1) {
            for (let n = 0; n < bs.length; n += 1) {
              const ra = as[m]!;
              const rb = bs[n]!;
              const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
              const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
              if (x > 2 && y > 2 && x * y > ox * oy) { ox = x; oy = y; }
            }
          }
          if (ox > 2 && oy > 2) {
            add('overlap', kids[a]!,
              'overlaps its sibling ' + label(kids[b]!) + ' by '
              + r1(ox) + '×' + r1(oy) + 'px',
              'high');
          }
        }
      }
    }

    /* 5. controls in one row: heights, centres, baselines ---------------- */
    const CTRL = 'button, .btn, input, select, textarea, .chip, .seg';
    for (let p = 0; p < parents.length; p += 1) {
      const parent = parents[p]!;
      const ps = cs(parent);
      if (ps.display !== 'flex' && ps.display !== 'inline-flex'
        && ps.display !== 'grid') continue;

      const controls: Element[] = [];
      const children = parent.children;
      for (let c = 0; c < children.length; c += 1) {
        const k = children[c]!;
        if (!visible(k)) continue;
        if (k.matches(CTRL)) controls.push(k);
      }
      if (controls.length < 2) continue;

      /* Group by the row they actually landed on, because a wrapped toolbar
         is several rows and comparing across them is meaningless. */
      const rows = new Map<number, Element[]>();
      for (let c = 0; c < controls.length; c += 1) {
        const top = Math.round(controls[c]!.getBoundingClientRect().top / 3) * 3;
        const list = rows.get(top) || [];
        list.push(controls[c]!);
        rows.set(top, list);
      }
      rows.forEach((row) => {
        if (row.length < 2) return;
        const rects = row.map((e) => e.getBoundingClientRect());
        const heights = rects.map((r) => r.height);
        if (spread(heights) > 1) {
          add('control-height', row[0]!,
            'controls in one row have different heights: '
            + heights.map(r1).join(', ') + 'px ('
            + row.map(label).join(', ') + ')',
            'med');
        }
        const centres = rects.map((r) => r.top + r.height / 2);
        if (spread(centres) > 1.5 && spread(heights) <= 1) {
          add('control-centre', row[0]!,
            'controls of equal height sit at different heights: centres '
            + centres.map(r1).join(', ') + 'px',
            'med');
        }
        const bases: number[] = [];
        for (let c = 0; c < row.length; c += 1) {
          const tr = textRect(row[c]!) || textRect(row[c]!.firstElementChild || row[c]!);
          if (tr) bases.push(tr.bottom);
        }
        if (bases.length > 1 && spread(bases) > 1.5) {
          add('baseline', row[0]!,
            'text baselines in one row are off by ' + r1(spread(bases))
            + 'px (' + bases.map(r1).join(', ') + ')',
            'med');
        }
        /* A control off the standard heights is where a ragged row starts.
           Chips and badges are excluded: they are labels sized by their text,
           not controls that have to line up with an input. */
        for (let c = 0; c < row.length; c += 1) {
          const h = rects[c]!.height;
          if (h < 20 || h > 60) continue;
          if (row[c]!.matches('.chip, .badge')) continue;
          let near = false;
          for (let t = 0; t < CTRL_H.length; t += 1) {
            if (Math.abs(h - CTRL_H[t]!) <= 1) near = true;
          }
          if (!near) {
            add('control-height-off-token', row[c]!,
              r1(h) + 'px tall, which is none of the control heights'
              + ' (32/38/40/44px)',
              'low');
          }
        }
      });
    }

    /* 6. form fields: label alignment, field widths, controls that do not fill */
    const fields = scanned[i]!.querySelectorAll('.field');
    const byRow = new Map<string, Element[]>();
    for (let f = 0; f < fields.length; f += 1) {
      const fld = fields[f]!;
      if (!visible(fld)) continue;
      const fr = fld.getBoundingClientRect();
      const lbl = fld.querySelector(':scope > label');
      const ctrl = fld.querySelector('input, select, textarea');
      /*
       * A checkbox or a radio is not a field that spans its row: it is a
       * 13px box with its label beside it, so "the label is 4px off the
       * control" and "the control leaves 510px empty" are both descriptions
       * of a checkbox working correctly.
       */
      const tick = ctrl instanceof HTMLInputElement
        && (ctrl.type === 'checkbox' || ctrl.type === 'radio');

      if (lbl && ctrl && !tick && visible(lbl) && visible(ctrl)) {
        const lr = lbl.getBoundingClientRect();
        const cr = ctrl.getBoundingClientRect();
        if (Math.abs(lr.left - cr.left) > 1) {
          add('label-offset', fld,
            'label starts at ' + r1(lr.left) + 'px but its field at '
            + r1(cr.left) + 'px, off by ' + r1(Math.abs(lr.left - cr.left)) + 'px',
            'med');
        }
      }
      if (ctrl && !tick && visible(ctrl)) {
        const cr = ctrl.getBoundingClientRect();
        const fs = cs(fld);
        const inner = fr.width - parseFloat(fs.paddingLeft) - parseFloat(fs.paddingRight);
        if (inner - cr.width > 2) {
          add('control-not-filling', fld,
            label(ctrl) + ' is ' + r1(cr.width) + 'px wide inside a '
            + r1(inner) + 'px field, leaving ' + r1(inner - cr.width) + 'px empty',
            'med');
        }
      }
      const parent = fld.parentElement;
      if (parent) {
        const key = (parent.getAttribute('class') || '?') + '@'
          + Math.round(fr.top / 3) * 3 + '#'
          + Array.prototype.indexOf.call(document.querySelectorAll('.field'), fld);
        const rowKey = key.split('#')[0]!;
        const list = byRow.get(rowKey) || [];
        list.push(fld);
        byRow.set(rowKey, list);
      }
    }
    byRow.forEach((row) => {
      if (row.length < 2) return;
      const parent = row[0]!.parentElement;
      if (!parent) return;
      const tracks = cs(parent).gridTemplateColumns;
      const widths = row.map((e) => e.getBoundingClientRect().width);
      if (spread(widths) <= 1) return;
      /* Equal grid tracks that produced unequal boxes is a bug. Unequal
         tracks are a layout decision, and saying otherwise would bury the
         report in false positives. */
      const parts = tracks && tracks !== 'none' ? tracks.split(' ') : [];
      const equalTracks = parts.length > 1
        && parts.every((p) => Math.abs(parseFloat(p) - parseFloat(parts[0]!)) < 1);
      if (equalTracks || parts.length <= 1) {
        add('field-width', row[0]!,
          'fields in one row are different widths: ' + widths.map(r1).join(', ')
          + 'px' + (equalTracks ? ', from equal grid tracks' : ''),
          'med');
      }
    });

    /* 7. tables: a missing scroll wrapper, and columns off their headers -- */
    const tables = scanned[i]!.querySelectorAll('table');
    for (let t = 0; t < tables.length; t += 1) {
      const table = tables[t]!;
      if (!visible(table)) continue;
      const wrap = table.parentElement;
      if (wrap) {
        const ws = cs(wrap);
        const scrolls = ws.overflowX === 'auto' || ws.overflowX === 'scroll';
        if (table.scrollWidth > wrap.clientWidth + 1 && !scrolls) {
          add('table-no-scroll-wrapper', table,
            'the table is ' + table.scrollWidth + 'px wide in a '
            + wrap.clientWidth + 'px parent whose overflow-x is ' + ws.overflowX,
            'high');
        }
        if (table.scrollWidth > wrap.clientWidth + 1 && scrolls) {
          add('table-scrolls', table,
            'the table only fits by scrolling: ' + table.scrollWidth
            + 'px of columns in ' + wrap.clientWidth + 'px',
            'low');
        }
      }
      const heads = table.querySelectorAll('thead tr:last-child th');
      const firstRow = table.querySelector('tbody tr');
      const cells = firstRow ? firstRow.querySelectorAll('td') : null;
      /*
       * Sampled across the first few rows rather than from the first alone,
       * and only where there is text to align.
       *
       * The team leave calendar is twenty-eight day columns of empty cells
       * carrying nothing but a background — a leave block, a holiday, a weekly
       * off. Their computed `text-align` is the inherited default, which does
       * not match a centred header, and the audit reported every one of them.
       * An empty cell has no visible alignment, so there is nothing there to
       * disagree with.
       *
       * Five rows because the first can be empty in a column that is not: a
       * register whose top row happens to have no note would otherwise take
       * the whole column out of the check.
       */
      const bodyRows = table.querySelectorAll('tbody tr');
      const textCell = (c: number): Element | null => {
        for (let r = 0; r < Math.min(bodyRows.length, 5); r += 1) {
          const tds = bodyRows[r]!.querySelectorAll('td');
          if (tds.length !== heads.length) continue;
          const td = tds[c];
          if (td && (td.textContent ?? '').trim()) return td;
        }
        return null;
      };
      if (heads.length && cells && cells.length === heads.length) {
        for (let c = 0; c < heads.length; c += 1) {
          const hr = heads[c]!.getBoundingClientRect();
          const dr = cells[c]!.getBoundingClientRect();
          if (hr.width < 1 || dr.width < 1) continue;
          if (Math.abs(hr.left - dr.left) > 1) {
            add('column-misaligned', heads[c]!,
              'column ' + (c + 1) + ' header starts at ' + r1(hr.left)
              + 'px but its cells at ' + r1(dr.left) + 'px',
              'med');
          }
          /* Both ends need text, or there is no alignment to disagree about. */
          const sample = textCell(c);
          if (!sample || !(heads[c]!.textContent ?? '').trim()) continue;
          const ha = cs(heads[c]!).textAlign;
          const da = cs(sample).textAlign;
          const norm = (v: string) => (v === 'start' ? 'left' : v === 'end' ? 'right' : v);
          if (norm(ha) !== norm(da)) {
            add('column-align-mismatch', heads[c]!,
              'column ' + (c + 1) + ' header is ' + ha + ' but its cells are '
              + da + ' — "' + (heads[c]!.textContent || '').trim().slice(0, 24) + '"',
              'med');
          }
        }
      }
    }

    /* 8. cards in a row: uneven heights, inconsistent padding ------------ */
    const cards = scanned[i]!.querySelectorAll('.card');
    const cardRows = new Map<string, Element[]>();
    for (let c = 0; c < cards.length; c += 1) {
      const card = cards[c]!;
      if (!visible(card)) continue;
      const parent = card.parentElement;
      if (!parent) continue;
      const top = Math.round(card.getBoundingClientRect().top / 3) * 3;
      const key = (parent.getAttribute('class') || '?') + '@' + top;
      const list = cardRows.get(key) || [];
      list.push(card);
      cardRows.set(key, list);
    }
    cardRows.forEach((row) => {
      if (row.length < 2) return;
      const heights = row.map((e) => e.getBoundingClientRect().height);
      if (spread(heights) > 2) {
        add('card-height', row[0]!,
          'cards in one row have uneven heights: ' + heights.map(r1).join(', ') + 'px',
          'med');
      }
      const pads: string[] = [];
      for (let c = 0; c < row.length; c += 1) {
        const body = row[c]!.querySelector('.card-b');
        /* `.card-b.flush` is `padding:0` on purpose — a card whose body is a
           table or a chart has no inner padding, so comparing it with a card
           of prose reports a decision as a defect. */
        if (body && !body.classList.contains('flush')) pads.push(cs(body).padding);
      }
      const uniq: string[] = [];
      for (let c = 0; c < pads.length; c += 1) {
        if (uniq.indexOf(pads[c]!) === -1) uniq.push(pads[c]!);
      }
      if (uniq.length > 1) {
        add('card-padding', row[0]!,
          'cards in one row have different padding: ' + uniq.join(' / '),
          'med');
      }
    });

    /* 9. an icon sitting off the text it labels -------------------------- */
    const icons = scanned[i]!.querySelectorAll('svg');
    for (let n = 0; n < icons.length; n += 1) {
      const icon = icons[n]!;
      if (!visible(icon)) continue;
      const ir = icon.getBoundingClientRect();
      if (ir.height > 32 || ir.height < 6) continue;
      const parent = icon.parentElement;
      if (!parent) continue;
      const tr = textRect(parent);
      if (!tr || tr.height < 4) continue;
      /*
       * Only an icon beside its text, not one above a caption or beside a
       * stack of two lines. The tolerance was 24px, which let a two-line
       * name-and-place block count as "text beside the icon" and then
       * reported the 5px between the icon and the block's centre as a
       * defect — a description of a stacked layout, not a misalignment.
       */
      if (Math.abs((tr.top + tr.height / 2) - (ir.top + ir.height / 2)) > 8) continue;
      if (tr.left < ir.right && tr.right > ir.left) continue;
      const off = Math.abs((ir.top + ir.height / 2) - (tr.top + tr.height / 2));
      if (off > 1.5) {
        add('icon-text-centre', parent,
          'the icon centre is ' + r1(off) + 'px off the centre of the text'
          + ' beside it — "' + (ownText(parent) || '').slice(0, 24) + '"',
          'low');
      }
    }

    /* 10. an empty state that is not actually centred --------------------- */
    const empties = scanned[i]!.querySelectorAll('.empty, .empty-state, .retry');
    for (let n = 0; n < empties.length; n += 1) {
      const el = empties[n]!;
      if (!visible(el)) continue;
      const parent = el.parentElement;
      if (!parent) continue;
      const pr = parent.getBoundingClientRect();
      const psx = cs(parent);
      const left = pr.left + parseFloat(psx.paddingLeft) + parseFloat(psx.borderLeftWidth);
      const right = pr.right - parseFloat(psx.paddingRight) - parseFloat(psx.borderRightWidth);
      const r = el.getBoundingClientRect();
      const gapL = r.left - left;
      const gapR = right - r.right;
      if (Math.abs(gapL - gapR) > 4 && r.width < (right - left) - 8) {
        add('empty-off-centre', el,
          'sits ' + r1(gapL) + 'px from the left and ' + r1(gapR)
          + 'px from the right of its container',
          'low');
      }
    }
  }

  return out;
}
