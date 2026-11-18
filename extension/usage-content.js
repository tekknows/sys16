(() => {
  let pendingBytes = 0;
  let sending = false;

  const recordTransferSize = (entry) => {
    const bytes = Number(entry.transferSize) || Number(entry.encodedBodySize) || 0;
    if (Number.isFinite(bytes) && bytes > 0) pendingBytes += Math.floor(bytes);
  };

  const navigationEntry = performance.getEntriesByType('navigation')[0];
  if (navigationEntry) recordTransferSize(navigationEntry);

  if ('PerformanceObserver' in window) {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach(recordTransferSize);
    });
    observer.observe({ type: 'resource', buffered: true });
  }

  window.setInterval(() => {
    if (sending || pendingBytes <= 0) return;
    const batchBytes = pendingBytes;
    sending = true;
    chrome.runtime.sendMessage({ type: 'usage-bytes', bytes: batchBytes }, (response) => {
      sending = false;
      if (chrome.runtime.lastError || !response?.ok) return;
      pendingBytes = Math.max(0, pendingBytes - batchBytes);
    });
  }, 60000);
})();
