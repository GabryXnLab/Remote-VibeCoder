'use strict';

// Check if already logged in — redirect to projects
(async () => {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.authenticated) {
      window.location.replace('projects.html');
      return;
    }
  } catch (_) {}

  // Init login form
  initLoginForm();
})();

function initLoginForm() {
  const form = document.getElementById('login-form');
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('password').value;

    btn.disabled = true;
    btn.textContent = 'Connecting…';
    errorEl.classList.remove('visible');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        window.location.replace('projects.html');
      } else {
        const data = await res.json().catch(() => ({ error: 'Login failed' }));
        showError(data.error || 'Invalid password');
      }
    } catch (err) {
      showError('Connection error — server unreachable');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
    document.getElementById('password').select();
  }
}
