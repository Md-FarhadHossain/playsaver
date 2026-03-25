// popup.js

// ─── Theme System ────────────────────────────────────────────────────────────

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(pref) {
    const html = document.documentElement;
    const isDark = pref === 'dark' || (pref === 'auto' && systemDark.matches);
    html.classList.toggle('dark', isDark);
    html.classList.toggle('light', !isDark);
}

function setActiveThemeBtn(pref) {
    document.querySelectorAll('.theme-btn').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.theme === pref)
    );
}

function loadTheme() {
    chrome.storage.local.get(['theme'], ({ theme }) => {
        const pref = theme || 'auto';
        applyTheme(pref);
        setActiveThemeBtn(pref);
    });
}

systemDark.addEventListener('change', () => {
    chrome.storage.local.get(['theme'], ({ theme }) => {
        if (!theme || theme === 'auto') applyTheme('auto');
    });
});

// ─── Auth UI helpers ─────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function showAuthError(id, msg) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

function showView(session) {
    $('view-logged-out').style.display = session ? 'none' : 'block';
    $('view-logged-in').style.display  = session ? 'block' : 'none';

    if (session?.user) {
        const user  = session.user;
        const label = user.name || user.email || '';
        $('user-email').textContent  = label;
        // Show first letter of name/email as avatar fallback
        $('user-avatar').textContent = label.charAt(0).toUpperCase() || '?';
        showAuthError('auth-error-loggedin', '');
    }
}

function setGoogleBtnLoading(loading) {
    const btn = $('btn-google');
    if (loading) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width:12px; height:12px; border-width: 2px;"></span> Signing in…';
    } else {
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
                <path fill="#EA4335" d="M24 9.5c3.21 0 5.93 1.1 8.13 2.9l6.04-6.04C34.27 3.19 29.46 1 24 1 14.82 1 7.07 6.68 3.96 14.6l7.03 5.46C12.62 14.02 17.86 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.52 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h12.7c-.55 2.97-2.2 5.48-4.67 7.17l7.18 5.58C43.44 37.26 46.52 31.36 46.52 24.5z"/>
                <path fill="#FBBC05" d="M10.99 28.5a14.6 14.6 0 0 1 0-9l-7.03-5.46A23.94 23.94 0 0 0 1 24c0 3.87.92 7.53 2.96 10.6l7.03-6.1z"/>
                <path fill="#34A853" d="M24 47c5.46 0 10.05-1.82 13.41-4.93l-7.18-5.58C28.37 37.81 26.3 38.5 24 38.5c-6.14 0-11.38-4.52-13.01-10.6l-7.03 6.1C7.07 41.32 14.82 47 24 47z"/>
            </svg>
            Sign in with Google`;
    }
}

// ─── DOM Ready ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    loadTheme();
    updateDisplay();
    setInterval(updateDisplay, 2000);

    // ── Check existing session ───────────────────────────────
    let session = null;
    try {
        session = await Auth.getSession();
    } catch { /* network offline */ }
    showView(session);

    // ── Theme buttons ────────────────────────────────────────
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const pref = btn.dataset.theme;
            chrome.storage.local.set({ theme: pref }, () => {
                applyTheme(pref);
                setActiveThemeBtn(pref);
            });
        });
    });

    // ── Google OAuth ─────────────────────────────────────────
    $('btn-google').addEventListener('click', async () => {
        setGoogleBtnLoading(true);
        showAuthError('auth-error', '');
        try {
            const session = await Auth.signInWithGoogle();
            showView(session);
            // Notify background so it resets the sync timer (next ADD_TIME syncs immediately)
            chrome.runtime.sendMessage({ type: 'SIGNED_IN' });
            // Also sync right now via background
            chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
        } catch (err) {
            if (!err.message?.includes('cancelled') && !err.message?.includes('closed')) {
                showAuthError('auth-error', err.message || 'Sign-in failed. Please try again.');
            }
        } finally {
            setGoogleBtnLoading(false);
        }
    });

    // ── Dashboard button ──────────────────────────────────────
    $('btn-dashboard').addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://myaccount.google.com/' });
    });

    // ── Sign Out ─────────────────────────────────────────────
    $('btn-signout').addEventListener('click', async () => {
        $('btn-signout').disabled = true;
        try {
            await Auth.signOut();
        } finally {
            showView(null);
            $('btn-signout').disabled = false;
        }
    });

    // ── Display mode ─────────────────────────────────────────
    document.querySelectorAll('input[name="displayMode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                chrome.storage.local.set({ displayMode: e.target.value });
            }
        });
    });
});

// ─── Stats display ────────────────────────────────────────────────────────────

function formatTime(ms, includeSeconds = false) {
    if (!ms || ms < 0) return '0m';
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    let res = '';
    if (h > 0) res += `${h}h `;
    res += `${m}m`;
    if (includeSeconds && h === 0 && m === 0) return `${s}s`;
    return res;
}

function updateDisplay() {
    chrome.storage.local.get(['totalSavedMs', 'dailyStats', 'displayMode'], (result) => {
        const total    = result.totalSavedMs || 0;
        const dateStr  = new Date().toLocaleDateString('en-CA');
        const today    = (result.dailyStats || {})[dateStr] || 0;

        $('total-time').innerText = formatTime(total);
        $('today-time').innerText = formatTime(today, true);

        if (result.displayMode) {
            const radio = document.querySelector(`input[name="displayMode"][value="${result.displayMode}"]`);
            if (radio) radio.checked = true;
        } else {
            const radio = document.querySelector(`input[name="displayMode"][value="always"]`);
            if (radio) radio.checked = true;
        }
    });
}
