// Putting the art where it is going: the clipboard, X's composer or Telegram's share sheet.
//
// Every entry point is called from a click and does all of its clipboard / popup / share work
// synchronously, before its first await: Safari forgets the user gesture at the first await (the
// write is refused), and a popup opened after a promise is blocked in Safari and Firefox.
//
// Clipboard order (copyText): one ClipboardItem built in the click (text/plain, plus text/html only
// for Telegram ASCII on a fine pointer, so Telegram Desktop pastes a pre block), then writeText,
// then document.execCommand('copy') on a hidden textarea, then 'manual' (the app shows the text
// selected in a sheet). The intents (X, t.me) copy with execCommand FIRST: it finishes before
// window.open returns, while an async write can lose the race with the new tab taking focus
// ("Document is not focused") in desktop Chrome.

import { xIntentUrl, tgShareUrl, linkFits } from './links.js';

const nav = () => globalThis.navigator;
const doc = () => globalThis.document;

export const MANUAL_HINT = 'This browser blocked copying. The art is selected: press and hold, then Copy.';

/**
 * Phone or desktop? `device` may be { coarse }, 'phone' | 'desktop' (or 'coarse' | 'fine');
 * otherwise the device's primary pointer. What matters is where the art gets pasted (Telegram
 * Desktop or a phone app), so a touch laptop tapped with a finger still counts as desktop; the
 * click's pointerType is only the last resort.
 */
export function isCoarse(device, event) {
  if (device && typeof device === 'object' && 'coarse' in device) return !!device.coarse;
  if (device === 'phone' || device === 'coarse') return true;
  if (device === 'desktop' || device === 'fine') return false;
  try { return globalThis.matchMedia('(pointer: coarse)').matches; } catch { /* no matchMedia */ }
  return !!(event && event.pointerType === 'touch');
}

/** Synchronous copy through a selected, invisible textarea. Returns true when the browser says so. */
export function execCopy(text) {
  const d = doc();
  if (!d || !d.body || typeof d.execCommand !== 'function') return false;
  const active = d.activeElement;
  const ta = d.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');           // no keyboard on phones
  ta.setAttribute('aria-hidden', 'true');
  ta.tabIndex = -1;
  // on screen (iOS will not select off-screen text) but invisible; 16 px keeps iOS from zooming
  ta.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;margin:0;padding:0;border:0;'
    + 'opacity:0;font-size:16px;pointer-events:none;';
  d.body.append(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    ok = d.execCommand('copy') === true;
  } catch { ok = false; }
  ta.remove();
  try { if (active && active !== d.body && active.focus) active.focus({ preventScroll: true }); } catch { /* gone */ }
  return ok;
}

const done = (via, html = false) => ({ ok: true, how: 'clipboard', via, html });
const manual = err => ({ ok: false, how: 'manual', via: null, html: false, error: (err && err.name) || null });

/**
 * Write `text` (and optionally `html`) to the clipboard. Call it inside the click, before any await.
 * opts.sync: try execCommand first (used right before a popup opens).
 * -> Promise<{ ok, how: 'clipboard' | 'manual', via: 'item' | 'writeText' | 'exec' | null, html }>
 */
export function copyText(text, html = null, opts = {}) {
  text = String(text ?? '');
  if (opts.sync && !html && execCopy(text)) return Promise.resolve(done('exec'));
  const clip = nav() && nav().clipboard;
  let pending = null, via = null;
  try {
    if (clip && typeof clip.write === 'function' && typeof globalThis.ClipboardItem === 'function') {
      const parts = { 'text/plain': new Blob([text], { type: 'text/plain' }) };
      if (html) parts['text/html'] = new Blob([html], { type: 'text/html' });
      pending = clip.write([new globalThis.ClipboardItem(parts)]);
      via = 'item';
    } else if (clip && typeof clip.writeText === 'function') {
      pending = clip.writeText(text);
      via = 'writeText';
    }
  } catch (e) {
    pending = Promise.reject(e);
  }
  if (!pending) return Promise.resolve(execCopy(text) ? done('exec') : manual(null));
  return Promise.resolve(pending).then(() => done(via, !!html && via === 'item'), async err => {
    // An engine that refuses ClipboardItem (or text/html) may still take plain text.
    if (via === 'item' && clip && typeof clip.writeText === 'function') {
      try { await clip.writeText(text); return done('writeText'); } catch { /* next */ }
    }
    if (execCopy(text)) return done('exec');
    return manual(err);
  });
}

/** Open `href` in a new tab from the click; null when the popup was blocked. */
function openTab(href) {
  let tab = null;
  try { tab = globalThis.open(href, '_blank'); } catch { tab = null; }
  // not 'noopener' in the features: then open() returns null by spec and a blocked popup looks
  // the same as an opened one. The opener link is cut by hand instead.
  if (tab) { try { tab.opener = null; } catch { /* cross-origin already */ } }
  return tab;
}

/**
 * X's composer with the art, clipboard first in the same click (the phone app can drop line
 * breaks from an intent; the clipboard is the backup). /intent/tweet, no url param: a link costs
 * 23 of the 280. Links past LINK_MAX.x are not opened: the art is copied instead.
 * -> Promise<{ ok, how: 'intent' | 'clipboard' | 'manual', href, blocked, tooLong, hint }>
 */
export function openXIntent(text, opts = {}) {
  const href = xIntentUrl(text, { path: opts.path || 'tweet' });
  if (!linkFits(href, 'x')) {
    return copyText(text).then(c => ({ ...c, href, blocked: false, tooLong: true,
      hint: c.ok ? 'Copied. Too long for a link: paste it into a new post.' : MANUAL_HINT }));
  }
  const copied = copyText(text, null, { sync: true });
  const tab = openTab(href);
  return copied.then(c => ({
    ...c, how: tab ? 'intent' : c.how, href, blocked: !tab, tooLong: false,
    hint: tab ? (c.ok ? 'Opened X. The art is on your clipboard too.' : 'Opened X with your art.')
      : c.ok ? 'Copied. Your browser blocked the X window: tap Open X.' : MANUAL_HINT,
  }));
}

/**
 * Telegram share. Phones: the system share sheet with the text (AbortError = 'cancelled').
 * Desktop (or no share sheet): the t.me/share/url link while it is short enough, the clipboard
 * otherwise (text/html <pre> too for Telegram ASCII on a fine pointer).
 * opts: { device, event, url (the url Telegram puts first; links.js SITE_URL) }
 */
export function shareTelegram(payload, opts = {}) {
  const text = String((payload && payload.text) || '');
  const coarse = isCoarse(opts.device, opts.event);
  const html = !coarse && payload && payload.html ? payload.html : null;
  const n = nav();
  if (coarse && n && typeof n.share === 'function') {
    const data = { text };
    let can = true;
    try { if (typeof n.canShare === 'function' && !n.canShare(data)) can = false; } catch { can = false; }
    if (can) {
      let p;
      try { p = n.share(data); } catch (e) { p = Promise.reject(e); }
      return Promise.resolve(p).then(
        () => ({ ok: true, how: 'share', via: 'share', html: false, hint: 'Pick a chat in Telegram and send.' }),
        e => {
          if (e && e.name === 'AbortError') return { ok: false, how: 'cancelled', via: null, html: false, hint: null };
          // share sheet refused (no activation, unsupported): the clipboard, best effort
          return copyText(text).then(c => ({ ...c, hint: c.ok ? TG_HINT(payload) : MANUAL_HINT }));
        });
    }
  }
  const href = tgShareUrl(text, opts.url);
  if (linkFits(href, 'tg')) {
    const copied = copyText(text, html, { sync: !html });
    const tab = openTab(href);
    return copied.then(c => ({
      ...c, how: tab ? 'intent' : c.how, href, blocked: !tab,
      hint: tab ? (c.ok ? 'Opened Telegram. The art is on your clipboard too.' : 'Opened Telegram with your art.')
        : c.ok ? 'Copied. Your browser blocked the Telegram window: paste it into any chat.' : MANUAL_HINT,
    }));
  }
  return copyText(text, html).then(c => ({ ...c, href: null, tooLong: true,
    hint: c.ok ? 'Copied (too long for a Telegram link). Paste it into any chat and send.' : MANUAL_HINT }));
}

const fmt = n => Number(n).toLocaleString('en-US');
const TG_HINT = p => (p && p.target === 'tgc'
  ? (p.limit === 1024 ? 'Copied. Attach a photo in your channel and paste this as its caption.'
    : 'Copied. Paste it into your channel and post.')
  : 'Copied. Paste it into any chat and send.');

/** The toast line after a successful copy, per target (SPEC "Copied"). */
export function copiedHint(target, payload = {}) {
  switch (target) {
    case 'ig': return 'Copied. Paste it into a comment.';
    case 'x': return 'Copied. Paste it into a new post.';
    case 'xlong': return payload.foldRow != null
      ? `Copied. Paste it into a new post (Premium). The timeline shows ${fmt(payload.foldRow)} rows, then Show more.`
      : 'Copied. Paste it into a new post (Premium).';
    case 'tg': case 'tgc': return TG_HINT({ ...payload, target });
    // Reddit's rich-text editor turns every line into its own paragraph: Markdown mode keeps the
    // 4-space code block that holds the art together
    case 'reddit': return 'Copied as a code block. Paste it into your post or comment.';
    default: return 'Copied as plain text.';
  }
}

/**
 * The primary / secondary action for a target. Call it straight from the click handler.
 *   action 'auto'  (primary)  X post that fits -> intent + clipboard; everything else -> clipboard
 *          'copy'             clipboard only ("Copy" on X, "Copy anyway")
 *          'share'            Telegram share (phones: share sheet; desktop: t.me link)
 * -> Promise<{ ok, how: 'clipboard' | 'intent' | 'share' | 'cancelled' | 'manual', hint, text, … }>
 * On 'manual' show the text selected in a sheet (result.text); on `blocked` offer "Open X"
 * (result.href) from a later click; `notice` is the Instagram "Action Blocked" line (show once).
 */
export function copyFor(target, payload, { event, device, action = 'auto' } = {}) {
  const text = String((payload && payload.text) || '');
  const withText = r => ({ ...r, text });
  if (!text) return Promise.resolve({ ok: false, how: 'none', hint: 'There is no art to copy yet.', text });
  const coarse = isCoarse(device, event);
  if (target === 'x' && action !== 'copy' && payload.fits !== false) return openXIntent(text).then(withText);
  if ((target === 'tg' || target === 'tgc') && action === 'share') {
    return shareTelegram(payload, { device: { coarse }, event }).then(withText);
  }
  // Telegram: HTML only for the desktop app. Reddit: always, since its editors on every device
  // either read the HTML code block (rich text) or the indented plain text (Markdown)
  const html = target === 'reddit' ? payload.html || null
    : (target === 'tg' || target === 'tgc') && payload.html && !coarse ? payload.html : null;
  const repeat = target === 'ig' ? (payload.warnings || []).find(w => w.code === 'ig-repeat')
    : target === 'reddit' ? (payload.warnings || []).find(w => w.code === 'reddit-markdown') : null;
  return copyText(text, html).then(c => withText({
    ...c, hint: c.ok ? copiedHint(target, payload) : MANUAL_HINT,
    notice: c.ok && repeat ? repeat.message : null,
  }));
}
