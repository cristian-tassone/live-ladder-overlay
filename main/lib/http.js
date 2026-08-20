'use strict';

/**
 * Tiny fetch wrapper with a hard timeout and a sane UA.
 * Every network read in the app goes through here so timeouts are uniform
 * and one slow source can never block the poll loop for the others.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 LiveLadder/1.0';

async function getText(url, { timeout = 8000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers }
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts = {}) {
  const text = await getText(url, {
    ...opts,
    headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers || {}) }
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Response was not JSON');
  }
}

module.exports = { getText, getJson, UA };
