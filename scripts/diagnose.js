/**
 * ChatGPT Export Diagnostics
 *
 * Run this in the browser console on chatgpt.com to diagnose why export
 * returns 0 conversations. It checks auth, cookies, and the raw API response.
 *
 * Usage: Paste into browser console while logged into chatgpt.com
 */

(async function ChatGPTDiagnose() {
  'use strict';

  function log(label, value) {
    if (value !== undefined) {
      console.log(`[Diagnose] ${label}:`, value);
    } else {
      console.log(`[Diagnose] ${label}`);
    }
  }

  log('Starting diagnostics...');

  // Check cookies
  const cookies = document.cookie.split(';').map(c => c.trim());
  const accountCookie = cookies.find(c => c.startsWith('_account='));
  const oaiDeviceCookie = cookies.find(c => c.startsWith('oai-did='));
  const relevantCookies = cookies.filter(c =>
    c.startsWith('_account=') ||
    c.startsWith('oai-did=') ||
    c.startsWith('__Host-next-auth') ||
    c.toLowerCase().includes('session') ||
    c.toLowerCase().includes('token')
  );

  log('Relevant cookies found', relevantCookies.length > 0 ? relevantCookies : '(none)');
  log('_account cookie', accountCookie || '(not found)');
  log('oai-did cookie', oaiDeviceCookie || '(not found)');

  // Get session / access token
  log('Fetching session...');
  const sessionResp = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
  const sessionData = await sessionResp.json();
  log('Session status', sessionResp.status);
  log('Has accessToken', !!sessionData.accessToken);
  log('Session user email', sessionData.user?.email || '(unknown)');

  if (!sessionData.accessToken) {
    log('ERROR: No access token. Are you logged in?');
    return;
  }

  const token = sessionData.accessToken;
  const accountId = accountCookie ? accountCookie.split('=')[1].trim() : null;
  log('Detected account ID from cookie', accountId || '(none)');

  // Try conversations WITH workspace header
  const headersWithAccount = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
  };

  log('--- Test 1: With Chatgpt-Account-Id header ---');
  const resp1 = await fetch(
    'https://chatgpt.com/backend-api/conversations?offset=0&limit=10',
    { headers: headersWithAccount, credentials: 'include' }
  );
  const data1 = await resp1.json();
  log('HTTP status', resp1.status);
  log('Response keys', Object.keys(data1));
  log('items count', data1.items?.length ?? '(no items field)');
  log('conversations count', data1.conversations?.length ?? '(no conversations field)');
  log('total', data1.total ?? '(no total field)');
  if (data1.items?.length > 0) log('First item title', data1.items[0].title);
  if (data1.conversations?.length > 0) log('First conversation title', data1.conversations[0].title);

  // Try conversations WITHOUT workspace header
  log('--- Test 2: Without Chatgpt-Account-Id header ---');
  const headersNoAccount = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
  };
  const resp2 = await fetch(
    'https://chatgpt.com/backend-api/conversations?offset=0&limit=10',
    { headers: headersNoAccount, credentials: 'include' }
  );
  const data2 = await resp2.json();
  log('HTTP status', resp2.status);
  log('Response keys', Object.keys(data2));
  log('items count', data2.items?.length ?? '(no items field)');
  log('conversations count', data2.conversations?.length ?? '(no conversations field)');
  log('total', data2.total ?? '(no total field)');
  if (data2.items?.length > 0) log('First item title', data2.items[0].title);

  // Full raw responses for debugging
  log('--- Raw response WITH account header ---', data1);
  log('--- Raw response WITHOUT account header ---', data2);

  log('Diagnostics complete. Check the output above.');
  return { withHeader: data1, withoutHeader: data2 };
})();
