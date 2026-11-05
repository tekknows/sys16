const defaultBlockedDomains = ['facebook.com', 'twitter.com', 'youtube.com', 'reddit.com', 'instagram.com'];

function normalizeDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch (error) {
    return '';
  }
}

function isBlockedDomain(hostname) {
  const rules = JSON.parse(localStorage.getItem('mindlock-blocked-domains') || 'null') || defaultBlockedDomains;
  return rules.some((entry) => hostname === entry || hostname.endsWith('.' + entry));
}

chrome.storage.local.get(['mindlock-blocked-domains'], (result) => {
  const stored = result['mindlock-blocked-domains'];
  const activeDomains = stored && stored.length ? stored : defaultBlockedDomains;
  localStorage.setItem('mindlock-blocked-domains', JSON.stringify(activeDomains));
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const host = normalizeDomain(details.url);
    if (!host || !isBlockedDomain(host)) {
      return {};
    }

    const redirectTarget = chrome.runtime.getURL(`blocked.html?domain=${encodeURIComponent(host)}`);
    return { redirectUrl: redirectTarget };
  },
  { urls: ['<all_urls>'] },
  ['blocking'],
);
