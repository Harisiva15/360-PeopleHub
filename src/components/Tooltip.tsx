import { useEffect } from 'react';

/**
 * Chart tooltips, delegated from a single floating box.
 *
 * Marks carry `data-tip`; hovering any of them shows the box and it follows the
 * cursor, flipping when it would run off the viewport. One listener set covers
 * every chart on the page, which keeps mark rendering cheap.
 */
export function TooltipLayer() {
  useEffect(() => {
    const el = document.createElement('div');
    el.className = 'tipbox';
    el.id = 'tip';
    document.body.appendChild(el);

    const nearest = (t: EventTarget | null): HTMLElement | null =>
      t instanceof Element ? t.closest<HTMLElement>('[data-tip]') : null;

    const onOver = (e: MouseEvent) => {
      const t = nearest(e.target);
      if (!t) return;
      el.textContent = t.getAttribute('data-tip') || '';
      el.classList.add('on');
    };

    const onMove = (e: MouseEvent) => {
      if (!el.classList.contains('on')) return;
      let x = e.clientX + 14;
      let y = e.clientY + 16;
      if (x + el.offsetWidth > window.innerWidth - 8) x = e.clientX - el.offsetWidth - 12;
      if (y + el.offsetHeight > window.innerHeight - 8) y = e.clientY - el.offsetHeight - 12;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    };

    const onOut = (e: MouseEvent) => {
      if (nearest(e.target)) el.classList.remove('on');
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseout', onOut);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseout', onOut);
      el.remove();
    };
  }, []);

  return null;
}
