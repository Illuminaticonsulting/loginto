/**
 * LogInTo — Login Page Logic
 */
(function() {
  'use strict';

  const loginForm = document.getElementById('login-form');
  const passwordInput = document.getElementById('password-input');
  const loginBtn = document.getElementById('login-btn');
  const loginError = document.getElementById('login-error');

  // Check for existing session on page load
  checkExistingSession();

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = passwordInput.value.trim();
    if (!password) return;

    setLoading(true);
    hideError();

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Login failed');
        setLoading(false);
        return;
      }

      // Store session
      localStorage.setItem('loginto_token', data.token);
      localStorage.setItem('loginto_userId', data.userId);
      localStorage.setItem('loginto_displayName', data.displayName);

      // Redirect to dashboard
      window.location.href = '/dashboard.html';

    } catch (err) {
      showError('Connection failed. Is the server running?');
      setLoading(false);
    }
  });

  async function checkExistingSession() {
    const token = localStorage.getItem('loginto_token');
    if (!token) return;

    try {
      const res = await fetch('/api/session', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (res.ok) {
        window.location.href = '/dashboard.html';
      } else {
        localStorage.removeItem('loginto_token');
        localStorage.removeItem('loginto_userId');
        localStorage.removeItem('loginto_displayName');
      }
    } catch (e) {
      // Server not reachable
    }
  }

  function setLoading(loading) {
    loginBtn.querySelector('.btn-text').style.display = loading ? 'none' : '';
    loginBtn.querySelector('.btn-loading').style.display = loading ? '' : 'none';
    loginBtn.disabled = loading;
  }

  function showError(msg) {
    loginError.textContent = msg;
    loginError.style.display = 'block';
  }

  function hideError() {
    loginError.style.display = 'none';
  }
})();
