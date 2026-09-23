// Links that open a composer with the art already in it.
//
// X: the documented web intent is x.com/intent/tweet (text, url, hashtags, via); /intent/post is
// what x.com itself uses and is kept as an option until the device tests say which one survives in
// the phone app. No url param by default: a link costs 23 of the 280 weighted characters.
// Telegram: t.me/share/url needs a url (the client puts it first, then a newline, then the text).

export const SITE_URL = 'https://winchxyz.github.io/typist/';

// Past these lengths a link is fragile (servers, apps and share sheets truncate or refuse long
// URLs); callers copy to the clipboard instead. Braille costs 9 bytes per cell once encoded.
export const LINK_MAX = { x: 4000, tg: 2000 };

const enc = s => encodeURIComponent(s);

/** xIntentUrl(text, { path: 'tweet' | 'post', url }) — also accepts a path string as 2nd arg. */
export function xIntentUrl(text, opts = {}) {
  const o = typeof opts === 'string' ? { path: opts } : (opts || {});
  const path = o.path === 'post' ? 'post' : 'tweet';
  let href = `https://x.com/intent/${path}?text=${enc(text)}`;
  if (o.url) href += `&url=${enc(o.url)}`;
  return href;
}

/** t.me share link; Telegram requires the url parameter. */
export function tgShareUrl(text, url = SITE_URL) {
  return `https://t.me/share/url?url=${enc(url || SITE_URL)}&text=${enc(text)}`;
}

/** True when a link is short enough to hand to the platform instead of the clipboard. */
export const linkFits = (href, kind) => href.length <= (LINK_MAX[kind] || 2000);
