const demoBlockRules = ['facebook.com', 'youtube.com', 'instagram.com', 'reddit.com'];

function initPopup() {
  const blockedList = document.getElementById('blockedList');
  const indicator = document.getElementById('themeIndicator');

  if (indicator) {
    indicator.textContent = 'System theme';
  }

  if (blockedList) {
    blockedList.innerHTML = demoBlockRules
      .map((rule) => `<li>${rule}</li>`)
      .join('');
  }

  const issueForm = document.getElementById('issueForm');
  if (issueForm) {
    issueForm.addEventListener('submit', (event) => {
      event.preventDefault();
      alert('Ticket submitted. An IT administrator will review it shortly.');
    });
  }
}

document.addEventListener('DOMContentLoaded', initPopup);
