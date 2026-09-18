/** Coalesces page visibility and top-level window focus into one resume event. */
export const FOREGROUND_RESUME_MESSAGE = 'operator-live-view-returned';

export function installForegroundResume(windowRef, documentRef, onResume) {
  let away = false;

  const markAway = () => { away = true; };
  const resume = () => {
    if (!away || documentRef.hidden) return;
    away = false;
    onResume();
  };
  const onVisibilityChange = () => {
    if (documentRef.hidden) markAway();
    else resume();
  };

  windowRef.addEventListener('blur', markAway);
  windowRef.addEventListener('focus', resume);
  windowRef.addEventListener('pagehide', markAway);
  windowRef.addEventListener('pageshow', resume);
  documentRef.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    windowRef.removeEventListener('blur', markAway);
    windowRef.removeEventListener('focus', resume);
    windowRef.removeEventListener('pagehide', markAway);
    windowRef.removeEventListener('pageshow', resume);
    documentRef.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
