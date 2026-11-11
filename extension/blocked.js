const params = new URLSearchParams(window.location.search);
const domain = params.get('domain');

if (domain) {
  document.getElementById('blockedWebsite').textContent = domain;
}
