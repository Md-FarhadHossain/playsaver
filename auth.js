// auth.js — Chrome Identity (Google OAuth) authentication module
// All auth logic is isolated here. Import in popup.js.

// ─── Storage helpers ──────────────────────────────────────────────────────────

const SESSION_KEYS = ['access_token', 'user', 'auth_method'];

function storeSession(data) {
    return new Promise((resolve) => {
        chrome.storage.local.set({
            access_token: data.access_token,
            user:         data.user,
            auth_method:  data.method || 'native'
        }, resolve);
    });
}

function clearSession() {
    return new Promise((resolve) => chrome.storage.local.remove(SESSION_KEYS, resolve));
}

// ─── Public API ───────────────────────────────────────────────────────────────

const Auth = {
    /**
     * Returns the current session.
     * Only relies on local storage check to prevent auto-logout.
     * The token may be expired, but we only need the user info for data syncing.
     */
    async getSession() {
        const stored = await new Promise((res) => chrome.storage.local.get(SESSION_KEYS, res));
        if (stored.user && stored.access_token) {
            return { access_token: stored.access_token, user: stored.user };
        }
        return null;
    },

    /**
     * Interactive Google sign-in.
     */
    async signInWithGoogle() {
        return Auth._signIn(true);
    },

    async _signInWebAuthFlow(interactive) {
        // Edge / other Chromium (or fallback): use launchWebAuthFlow
        // ⚠️ Requires a "Web Application" OAuth client in Google Cloud Console
        const clientId = '144549382760-ab4epvilh02bqbrbk4u49toc1dkqaa5j.apps.googleusercontent.com';
        const redirectUri = chrome.identity.getRedirectURL();
        const scope = 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;

        const responseUrl = await new Promise((resolve, reject) => {
            chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, (callbackUrl) => {
                if (chrome.runtime.lastError || !callbackUrl) {
                    reject(new Error(chrome.runtime.lastError?.message || 'Auth cancelled'));
                } else {
                    resolve(callbackUrl);
                }
            });
        });

        const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
        const token = params.get('access_token');
        if (!token) throw new Error('No access_token returned by Google');

        const user = await Auth._fetchUser(token);
        const session = { access_token: token, user };
        await storeSession({ ...session, method: 'webflow' });
        return session;
    },

    /**
     * Browser-aware internal sign-in.
     */
    async _signIn(interactive) {
        const isBrave = !!(navigator.brave && navigator.brave.isBrave);
        const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent) && !isBrave;

        if (isChrome) {
            // Native Chrome flow — no redirect URI registration needed
            const getToken = () => new Promise((resolve, reject) => {
                chrome.identity.getAuthToken({ interactive }, (token) => {
                    if (chrome.runtime.lastError || !token) {
                        reject(new Error(chrome.runtime.lastError?.message || 'Auth cancelled'));
                    } else {
                        resolve(token);
                    }
                });
            });

            try {
                let token = await getToken();
                let user;
                try {
                    user = await Auth._fetchUser(token);
                } catch (err) {
                    await new Promise((resolve) =>
                        chrome.identity.removeCachedAuthToken({ token }, resolve)
                    );
                    token = await getToken();
                    user = await Auth._fetchUser(token);
                }
                const session = { access_token: token, user };
                await storeSession({ ...session, method: 'native' });
                return session;
            } catch (err) {
                // If native auth fails because the user explicitly turned off Chrome profile 
                // sign-in (or using Chromium forks like Opera/Comet), failover to WebFlow
                // gracefully for ANY error that isn't a deliberate user cancellation!
                const msg = err.message.toLowerCase();
                if (!msg.includes('cancel')) {
                    return await Auth._signInWebAuthFlow(interactive);
                }
                throw err;
            }
        } else {
            return await Auth._signInWebAuthFlow(interactive);
        }
    },

    /**
     * Sign the user out: clear Chrome's token cache + storage.
     */
    async signOut() {
        const { access_token } = await new Promise((resolve) =>
            chrome.storage.local.get(['access_token'], resolve)
        );

        if (access_token) {
            // 1. Remove from Chrome's internal cache so next getAuthToken gets a fresh token
            await new Promise((resolve) =>
                chrome.identity.removeCachedAuthToken({ token: access_token }, resolve)
            );
            // 2. Revoke server-side (best-effort)
            fetch(`https://oauth2.googleapis.com/revoke?token=${access_token}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }).catch(() => {});
        }

        await clearSession();
    },

    // ─── Private ──────────────────────────────────────────────────────────────

    async _fetchUser(accessToken) {
        const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Could not fetch Google user profile (HTTP ${res.status}): ${body}`);
        }
        const profile = await res.json();
        // Normalize to a consistent shape: { id, email, name, avatar_url }
        return {
            id:         profile.id,
            email:      profile.email,
            name:       profile.name,
            avatar_url: profile.picture,
        };
    },
};

// Make available globally in popup context (no bundler in this extension)
if (typeof window !== 'undefined') window.Auth = Auth;
