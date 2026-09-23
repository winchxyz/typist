// Sharing to X and credits.
//
// X's web intent cannot carry a file, so on desktop we save the file and open a pre-filled post
// for the user to attach it to. On phones the system share sheet sends the file itself (the user
// picks X), which is the only way to post a video in one step.

export const SITE_URL = 'https://winchxyz.github.io/typist/';
export const REPO_URL = 'https://github.com/winchxyz/typist';
export const AUTHOR = { handle: 'winchxyz', url: 'https://x.com/winchxyz' };

export function xIntentUrl(text, url = SITE_URL) {
  const q = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${q}`;
}

export const shareText = kind => (kind === 'video'
  ? `Watch my photo turn into one continuous line. Made with Spiralist by @${AUTHOR.handle}`
  : `My photo, redrawn as one continuous line. Made with Spiralist by @${AUTHOR.handle}`);

/**
 * Open X's composer in a new tab. Returns false when the browser blocked the popup.
 * Not `window.open(url, '_blank', 'noopener')`: with 'noopener' the call returns null by spec, so a
 * blocked popup and an opened one look the same. The opener link is cut by hand instead.
 */
export function openXIntent(kind) {
  const tab = window.open(xIntentUrl(shareText(kind)), '_blank');
  if (!tab) return false;
  try { tab.opener = null; } catch { /* already detached */ }
  return true;
}

/**
 * Share a file to X. Must be called from a click handler: the new tab is opened synchronously so
 * popup blockers allow it, before the (possibly slow) file is ready. Never navigates this page:
 * the user's drawing or film would be lost.
 * @param getBlob  () => Promise<Blob> | Blob
 * @param opts     { filename, kind: 'image'|'video', download(blob, name), canShare(type) }
 * @returns 'shared' | 'cancelled' | 'intent' (X tab open, file saved) | 'blocked' (popup blocked,
 *          file saved: offer openXIntent from a later click) | 'saved' (share sheet failed, file saved)
 */
export async function shareToX(getBlob, { filename, kind, download, canShare, mime }) {
  const text = shareText(kind);
  const nativeFiles = canShare?.(mime);
  if (nativeFiles) {
    // Phones: hand the actual file to the share sheet (X accepts images and videos from it).
    let blob = null;
    try {
      blob = await getBlob();
      const file = new File([blob], filename, { type: blob.type || mime });
      await navigator.share({ files: [file], text: `${text} ${SITE_URL}` });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // The click's user activation is spent by now, so a new tab would be blocked: save the
      // file and let the caller offer X from a fresh tap.
      download(blob || await getBlob(), filename);
      return 'saved';
    }
  }
  const opened = openXIntent(kind);
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
