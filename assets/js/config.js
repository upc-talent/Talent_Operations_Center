/* ════════════════════════════════════════════════════════════════════
   App configuration — the ONLY place URLs live.
   Note: anything shipped to a browser can be seen by a determined visitor, so neither the
   backend URL nor the anon key is a secret. What protects the data is the backend itself:
   trainer actions need a signed login token, supervisor actions are scoped server-side to
   their own pharmacists, and Row-Level Security stops the anon key touching any table directly.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  const SUPABASE_URL = 'https://aoqgabdsayaqgqroscdw.supabase.co';

  const cfg = {
    // Supabase is the single source of truth: a Postgres database behind the "api" Edge Function.
    SUPABASE_URL,
    SUPABASE_ANON: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvcWdhYmRzYXlhcWdxcm9zY2R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwNzI5NzYsImV4cCI6MjEwNTY0ODk3Nn0.xJ_aTcn6XtYbQGRi_DjlczgVRG7JV5gpi7RYwUxOH4s',
    API_URL: SUPABASE_URL + '/functions/v1/api',

    // Course-completion report source (used by Trainer > Setup > "Sync Now"). This is a separate,
    // read-only reporting service — not the app's database.
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

  window.APP_CONFIG = cfg;
})();
