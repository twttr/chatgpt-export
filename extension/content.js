/**
 * ChatGPT Export - Content Script
 * Only used to get auth credentials from the page context,
 * since the service worker cannot make credentialed fetches to chatgpt.com.
 */

(function () {
  'use strict';

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.action !== 'getAuth') return;

    fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        const accountCookie = document.cookie
          .split(';')
          .find(c => c.trim().startsWith('_account='));
        const accountId = accountCookie ? accountCookie.split('=')[1].trim() : null;
        sendResponse({ token: data.accessToken, accountId });
      })
      .catch(err => sendResponse({ error: err.message }));

    return true;
  });
})();
