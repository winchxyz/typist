// Small UI primitives: slider rows, segmented radio groups, popover menus, toasts, announcements.

let uid = 0;

/** Keep the filled part of a range track in sync (WebKit has no ::range-progress). */
export function paintRange(input) {
  const min = +input.min || 0, max = +input.max || 100;
  const p = max > min ? ((+input.value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${p}%`);
}

/**
 * A labelled slider with an editable value and a default tick.
 * opts: { label, min, max, step, value, def, format(v)->string, valuetext(v)->string,
 *         onInput(v), onCommit(v), hint }
 */
export function sliderRow(opts) {
  const id = `sl${++uid}`;
  const row = document.createElement('div');
  row.className = 'slider-row';
  row.innerHTML = `<label for="${id}"></label><button type="button" class="val" aria-label=""></button>
    <div class="track"><input type="range" id="${id}"><span class="tick" aria-hidden="true"></span></div>`;
  const label = row.querySelector('label');
  const val = row.querySelector('.val');
  const input = row.querySelector('input');
  const tick = row.querySelector('.tick');
  label.textContent = opts.label;
  if (opts.hint) label.title = opts.hint;
  Object.assign(input, { min: opts.min, max: opts.max, step: opts.step ?? 'any' });
  const fmt = opts.format || (v => String(v));
  let dragging = false;

  const show = v => {
    val.textContent = fmt(v);
    val.setAttribute('aria-label', `${opts.label}: ${fmt(v)}. Click to type a value.`);
    input.setAttribute('aria-valuetext', (opts.valuetext || fmt)(v));
    paintRange(input);
  };
  const set = v => { input.value = v; show(+input.value); };
  const placeTick = () => {
    const p = ((opts.def - opts.min) / (opts.max - opts.min)) * 100;
    // thumb travel is inset by half its width
    tick.style.left = `calc(8px + (100% - 16px) * ${p / 100})`;
  };
  placeTick();
  set(opts.value);

  input.addEventListener('pointerdown', () => { dragging = true; });
  input.addEventListener('input', () => { show(+input.value); opts.onInput?.(+input.value, dragging); });
  const commit = () => { dragging = false; opts.onCommit?.(+input.value); };
  input.addEventListener('change', commit);
  const reset = () => {
    set(opts.def);
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 150);
    opts.onInput?.(opts.def, false);
    opts.onCommit?.(opts.def);
  };
  label.addEventListener('dblclick', reset);
  input.addEventListener('dblclick', reset);

  // click the value to type one
  val.addEventListener('click', () => {
    const edit = document.createElement('input');
    edit.type = 'text';
    edit.inputMode = 'decimal';
    edit.className = 'val';
    edit.value = opts.toEdit ? opts.toEdit(+input.value) : input.value;
    edit.setAttribute('aria-label', opts.label);
    val.replaceWith(edit);
    edit.select();
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      if (ok) {
        const raw = parseFloat(edit.value.replace(',', '.'));
        if (Number.isFinite(raw)) {
          const v = opts.fromEdit ? opts.fromEdit(raw) : raw;
          set(Math.max(+input.min, Math.min(+input.max, v)));
          opts.onInput?.(+input.value, false);
          opts.onCommit?.(+input.value);
        }
      }
      edit.replaceWith(val);
      val.focus();
    };
    edit.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    edit.addEventListener('blur', () => finish(true));
  });

  return { el: row, input, set, get value() { return +input.value; }, get dragging() { return dragging; } };
}

/**
 * Segmented control / radio group with roving tabindex and arrow keys.
 * Returns { set(value), get value }.
 */
export function bindSeg(el, value, onChange) {
  const buttons = [...el.querySelectorAll('[role="radio"]')];
  let current = null;
  const set = v => {
    current = String(v);
    for (const b of buttons) {
      const on = b.dataset.v === current;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    if (!buttons.some(b => b.dataset.v === current) && buttons[0]) buttons[0].tabIndex = 0;
  };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      const changed = b.dataset.v !== current;
      set(b.dataset.v);
      if (changed) onChange?.(b.dataset.v);
    });
  }
  el.addEventListener('keydown', e => {
    const i = buttons.findIndex(b => b.dataset.v === current);
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % buttons.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + buttons.length) % buttons.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = buttons.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    buttons[j].focus();
    buttons[j].click();
  });
  set(value);
  return { set, get value() { return current; } };
}

/** Roving tabindex + arrow keys for a grid of role=radio items (chips, swatches, looks). */
export function rovingGrid(container, selector = '[role="radio"]') {
  container.addEventListener('keydown', e => {
    const items = [...container.querySelectorAll(selector)].filter(x => !x.hidden);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = Math.max(1, Math.round(container.clientWidth / (items[0].offsetWidth || 1)));
    let j = -1;
    if (e.key === 'ArrowRight') j = Math.min(items.length - 1, i + 1);
    if (e.key === 'ArrowLeft') j = Math.max(0, i - 1);
    if (e.key === 'ArrowDown') j = Math.min(items.length - 1, i + cols);
    if (e.key === 'ArrowUp') j = Math.max(0, i - cols);
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = items.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    items[j].focus();
    items[j].click();
  });
}

export function setChecked(items, pred) {
  let any = false;
  for (const el of items) {
    const on = !!pred(el);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.tabIndex = on ? 0 : -1;
    any = any || on;
  }
  if (!any && items[0]) items[0].tabIndex = 0;
}

/** Popover menu attached to a button. Closes on outside click and Escape. */
export function popover(button, menu, { onOpen } = {}) {
  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    onOpen?.();
    (menu.querySelector('[aria-checked="true"], [role="menuitem"], button, input') || menu).focus?.();
  };
  button.addEventListener('click', e => { e.stopPropagation(); menu.hidden ? open() : close(); });
  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) close();
  });
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); button.focus(); }
  });
  return { open, close, get isOpen() { return !menu.hidden; } };
}

// ------------------------------------------------------------------ toasts + announcements
const toastsEl = () => document.getElementById('toasts');
let toastTimer = 0;

/** One toast at a time. opts: { error, action: {label, run}, ms } */
export function toast(message, opts = {}) {
  const host = toastsEl();
  if (!host) return;
  clearTimeout(toastTimer);
  host.replaceChildren();
  const t = document.createElement('div');
  t.className = 'toast' + (opts.error ? ' error' : '');
  t.setAttribute('role', opts.error ? 'alert' : 'status');
  const span = document.createElement('span');
  span.textContent = message;
  t.append(span);
  if (opts.action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opts.action.label;
    b.addEventListener('click', () => { opts.action.run(); t.remove(); });
    t.append(b);
  }
  host.append(t);
  toastTimer = setTimeout(() => t.remove(), opts.ms ?? (opts.action ? 6000 : 3200));
}

export function announce(message, assertive = false) {
  const el = document.getElementById(assertive ? 'liveAssert' : 'live');
  if (!el) return;
  el.textContent = '';
  // next frame so repeated messages are re-announced
  requestAnimationFrame(() => { el.textContent = message; });
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isTouch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
