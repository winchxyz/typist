// Sharing Typist itself (the ⋯ menu) and credits.
//
// X's web intent cannot carry a file, so on desktop a film is saved and a pre-filled post opened for
// the user to attach it to. On phones the system share sheet sends the file itself (the user picks
// X), which is the only way to post a video in one step. The art's own "Post on X" lives in
// copy.js: it carries the art as text, this module only links to the site.

export const SITE_URL = 'https://winchxyz.github.io/typist/';
export const REPO_URL = 'https://github.com/winchxyz/typist';
export const AUTHOR = { handle: 'winchxyz', url: 'https://x.com/winchxyz' };

export function siteIntentUrl(text, url = SITE_URL) {
  const q = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${q}`;
}

export const shareText = kind => (kind === 'video'
  ? `Watch my photo turn into text art. Made with Typist by @${AUTHOR.handle}`
  : `Turn any photo into text art you can paste into a comment, a post or a chat. Typist by @${AUTHOR.handle}`);

/**
 * Open X's composer with a link to Typist in a new tab. Returns false when the browser blocked the
 * popup. Not `window.open(url, '_blank', 'noopener')`: with 'noopener' the call returns null by
 * spec, so a blocked popup and an opened one look the same. The opener link is cut by hand instead.
 */
export function shareSiteOnX(kind = 'site') {
  const tab = window.open(siteIntentUrl(shareText(kind)), '_blank');
  if (!tab) return false;
  try { tab.opener = null; } catch { /* already detached */ }
  return true;
}

/**
 * Share a file (the film, phase 4) to X. Must be called from a click handler: the new tab is opened
 * synchronously so popup blockers allow it, before the (possibly slow) file is ready.
 * @param getBlob  () => Promise<Blob> | Blob
 * @param opts     { filename, kind: 'image'|'video', download(blob, name), canShare(type), mime }
 * @returns 'shared' | 'cancelled' | 'intent' (X tab open, file saved) | 'blocked' (popup blocked,
 *          file saved) | 'saved' (share sheet failed, file saved)
 */
export async function shareToX(getBlob, { filename, kind, download, canShare, mime }) {
  const text = shareText(kind);
  if (canShare?.(mime)) {
    let blob = null;
    try {
      blob = await getBlob();
      const file = new File([blob], filename, { type: blob.type || mime });
      await navigator.share({ files: [file], text: `${text} ${SITE_URL}` });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // the click's user activation is spent by now, so a new tab would be blocked: save the file
      // and let the caller offer X from a fresh tap
      download(blob || await getBlob(), filename);
      return 'saved';
    }
  }
  const opened = shareSiteOnX(kind);
  download(await getBlob(), filename);
  return opened ? 'intent' : 'blocked';
}

/** GitHub star count, cached for an hour; null when offline or rate-limited. */
export async function starCount() {
  const KEY = 'typist:stars';
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (c && Date.now() - c.t < 3600e3) return c.n;
  } catch { /* storage blocked */ }
  try {
    const r = await fetch('https://api.github.com/repos/winchxyz/typist', { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    const n = (await r.json()).stargazers_count;
    try { localStorage.setItem(KEY, JSON.stringify({ n, t: Date.now() })); } catch { /* ignore */ }
    return n;
  } catch { return null; }
}
