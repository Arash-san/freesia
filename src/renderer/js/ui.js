// ==========================================================
// Freesia UI kit: DOM helpers, toasts, dialogs, count-ups,
// segmented controls. No framework; small and dependency-free.
// ==========================================================
(function (root) {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function icon(name, cls = '') {
    return `<svg${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }

  // h('div.card', { onclick }, [children]) — tiny element builder
  function h(tag, props = {}, children = []) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') {
        // setProperty is required for custom properties like --accent
        for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const isRtl = (text) => /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(String(text).slice(0, 200));

  // ---------------------------------------------------------- toasts
  const TOAST_ICONS = { success: 'check', error: 'x', info: 'bolt' };
  function toast(message, type = 'info', ms = 3200) {
    const host = $('toastContainer');
    if (!host) return;
    while (host.children.length >= 3) host.firstElementChild.remove();
    const el = h(`div.toast.${type}`, { role: 'status' }, [
      h('span.toast-icon', { html: icon(TOAST_ICONS[type] || 'bolt') }),
      h('span', { text: String(message) })
    ]);
    host.append(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 280);
    }, ms);
  }

  // ---------------------------------------------------------- dialogs
  // Resolves with the clicked action's value, or null when dismissed.
  function dialog({ title, text, body, actions = [{ label: 'OK', kind: 'primary', value: true }], dismissable = true, onOpen }) {
    return new Promise((resolve) => {
      const host = $('dialogHost') || document.body;
      const foot = h('div.dialog-foot');
      const box = h('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' }, [
        title ? h('div.dialog-title', { text: title }) : null,
        text ? h('p.dialog-text', { text }) : null,
        body ? h('div.dialog-body', {}, [body]) : null,
        foot
      ]);
      const backdrop = h('div.dialog-backdrop', {}, [box]);
      let done = false;
      const close = (value) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.classList.add('closing');
        setTimeout(() => backdrop.remove(), 210);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(null); }
      };
      for (const a of actions) {
        if (a.spacer) { foot.append(h('span.spacer')); continue; }
        const b = h(`button.btn.btn-${a.kind || 'secondary'}`, { type: 'button', text: a.label });
        b.addEventListener('click', async () => {
          if (a.validate) {
            const ok = await a.validate(box);
            if (!ok) return;
          }
          close(a.value !== undefined ? a.value : a.label);
        });
        foot.append(b);
      }
      if (dismissable) backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });
      document.addEventListener('keydown', onKey, true);
      host.append(backdrop);
      onOpen?.(box, close);
      requestAnimationFrame(() => (box.querySelector('input, textarea, select') || foot.lastElementChild)?.focus());
    });
  }

  function confirmDialog(title, text, { ok = 'Continue', danger = false, cancel = 'Cancel' } = {}) {
    return dialog({ title, text, actions: [{ label: cancel, kind: 'ghost', value: false }, { label: ok, kind: danger ? 'danger' : 'primary', value: true }] })
      .then((v) => v === true);
  }

  // ---------------------------------------------------------- count-up
  function countUp(el, to, { format = (n) => Math.round(n).toLocaleString(), duration = 900 } = {}) {
    if (!el) return;
    const from = Number(el.dataset.count || 0);
    el.dataset.count = String(to);
    if (from === to || root.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof requestAnimationFrame !== 'function') {
      el.textContent = format(to);
      return;
    }
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 4);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = format(from + (to - from) * ease(t));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------- segmented
  function segmented(el, { attr = 'data-tab', onChange } = {}) {
    const thumb = el.querySelector('.segmented-thumb');
    const buttons = $$('button', el);
    const place = () => {
      const active = buttons.find((b) => b.classList.contains('active')) || buttons[0];
      if (!thumb || !active || !active.offsetWidth) return;
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`;
    };
    const set = (value, silent) => {
      buttons.forEach((b) => b.classList.toggle('active', b.getAttribute(attr) === value));
      place();
      if (!silent) onChange?.(value);
    };
    buttons.forEach((b) => b.addEventListener('click', () => set(b.getAttribute(attr))));
    if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(el);
    requestAnimationFrame(place);
    return { set, place };
  }

  // ---------------------------------------------------------- formatting
  function formatDuration(totalSec) {
    const sec = Math.max(0, Math.round(totalSec));
    if (sec < 60) return `${sec}s`;
    const hrs = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return hrs > 0 ? `${hrs}h ${m}m` : `${m}m`;
  }

  function clock(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function bytes(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
    return `${Math.round(n / 1e3)} KB`;
  }

  function kbdHtml(shortcut) {
    return String(shortcut || '').split('+').filter(Boolean)
      .map((k) => `<kbd>${escapeHtml(k === 'Space' ? '␣ Space' : k)}</kbd>`).join('');
  }

  function dayLabel(date) {
    const d = new Date(date);
    const today = new Date();
    const y = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  // Word-by-word blur-in reveal for fresh transcripts
  function revealText(el, text) {
    el.replaceChildren();
    el.dir = isRtl(text) ? 'rtl' : 'ltr';
    // Each word carries its trailing space so wrapped lines never start with one
    const parts = String(text).match(/\s*\S+\s*|\s+/g) || [];
    parts.forEach((p, i) => {
      const s = document.createElement('span');
      s.className = 'word';
      s.textContent = p;
      s.style.animationDelay = `${Math.min(i * 12, 1200)}ms`;
      el.append(s);
    });
  }

  root.UI = { $, $$, h, escapeHtml, icon, isRtl, toast, dialog, confirmDialog, countUp, segmented, formatDuration, clock, bytes, kbdHtml, dayLabel, revealText };
})(typeof window !== 'undefined' ? window : globalThis);
