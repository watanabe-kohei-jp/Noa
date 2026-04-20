const SAFE_URL_SCHEMES = /^(https?:|mailto:)/i;

export function isSafeCalendarUrl(url: string | undefined): boolean {
  if (!url) return false;
  return SAFE_URL_SCHEMES.test(url.trim());
}
