/* ════════════════════════════════════════════════════════════════════
   App configuration — the ONLY place URLs live.
   Note: anything shipped to a browser can be seen by a determined visitor, so the
   backend URL is not a secret. What protects the data is the backend itself:
   trainer actions need a signed login token, supervisor actions are scoped to
   their own pharmacists, and the Google Sheet stays private.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  const cfg = {
    // Google Apps Script web app that reads/writes the Training Operations Hub sheet
    API_URL: 'https://script.google.com/macros/s/AKfycbxbLEHU-uRJhHtd9yT2nqiFi6trJEyvNS8zxKNkALhY_deI5U9VlrKF5AJJUsbPvSyU/exec',

    // Existing LMS completion-report source (used by Trainer > Setup > "Sync Now")
    COMPLETION_REPORTS_URL: 'https://script.google.com/macros/s/AKfycbzLmYSVLykZNjjYKWeWxhJOlsHoDNKzxlGH8zg931_rr6y4VHTPxqNVj5W7zFvWNTuS/exec',

    // Landing-page cards
    LINKS: {
      progressReports: 'https://upc-talent.github.io/LMS-reporting/'
      // LMS Ticketing System card is switched off for now. To bring it back: add this link here
      //   ticketing: 'https://forms.clickup.com/90152546261/f/2kyr5byn-5335/DH1J7W33E380VYJM8C'
      // and re-add the card (see the "c-ticket" style in assets/css/app.css) to index.html.
    },

    BASE: ''   // path prefix for dev helpers (leave empty)
  };

  // Local development: open any page with ?mock=1 to run against an in-browser fake sheet
  // (no real data, nothing leaves your machine). ?mock=0 switches it back off.
  try {
    const q = new URLSearchParams(location.search).get('mock');
    if (q === '1') sessionStorage.setItem('upc_mock', '1');
    if (q === '0') sessionStorage.removeItem('upc_mock');
    if (sessionStorage.getItem('upc_mock') === '1') cfg.API_URL = 'mock';
  } catch (e) {}

  window.APP_CONFIG = cfg;
})();
