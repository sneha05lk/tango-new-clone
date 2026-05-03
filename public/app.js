/* ═══════════════════════════════════════════════════════════════
   TangoLive – app.js
   Main SPA logic: auth, navigation, streams, socket.io, gifts
═══════════════════════════════════════════════════════════════ */

const RAW_API_BASE = (window.__APP_CONFIG__?.apiBase || '').trim();
const API = RAW_API_BASE.replace(/\/+$/, '');
let token = localStorage.getItem('tl_token');
let currentUser = JSON.parse(localStorage.getItem('tl_user') || 'null');
let socket = null; // This will now hold the Supabase Channel instance
let supabaseClient = null; // Supabase client instance
let currentStream = null;  // stream object being watched
let profileStatsTimer = null;
let chatPartnerId = null; // Currently chatting with this user ID
let socketConnected = false;
let isHost = false;
let guestTimerInterval = null;
let pendingJoinRequest = null; // { userId, streamId, socket_id }
let livekitRoom = null;
let pendingGuestInvite = null; // { hostId, roomName }
let isGuestStreamer = false;
let activeGuestIds = new Set(); // To track UI elements for guests
let cachedLivekitUrl = null;
let currentScreen = 'home'; // Tracking the active screen state
let livekitConnectSeq = 0;
let lastManualLivekitDisconnectAt = 0;
let isGoLiveInProgress = false;
let isGiftSending = false;
let homeRefreshTimer = null;


// ─── UTILITY ─────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const isMobileDevice = () =>
    /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '');
const toAssetUrl = (url) => {
    if (!url) return '';
    if (/^(https?:)?\/\//i.test(url) || /^data:|^blob:/i.test(url)) return url;
    if (!API) return url;
    if (url.startsWith('/')) return `${API}${url}`;
    return `${API}/${url}`;
};
const apiReq = async (method, path, body) => {
    try {
        const res = await fetch(API + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        const data = await res.json();
        if (!res.ok) {
            console.error(`[API Error] ${method} ${path}:`, data.message || res.statusText);
            throw new Error(data.message || `Request failed with status ${res.status}`);
        }
        return data;
    } catch (err) {
        if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
            showGlobalError('Network error: Please check your internet connection or server status.');
        } else {
            // Re-throw to be handled by the caller (like login-form submit)
            throw err;
        }
    }
};

function showGlobalError(msg) {
    const container = $('global-error-container') || createGlobalErrorContainer();
    container.textContent = msg;
    container.classList.remove('hidden');
    container.style.display = 'block';
    setTimeout(() => {
        container.style.display = 'none';
        container.classList.add('hidden');
    }, 5000);
}

function createGlobalErrorContainer() {
    const div = document.createElement('div');
    div.id = 'global-error-container';
    div.className = 'global-error-toast hidden';
    div.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #ff4d4d;
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        z-index: 9999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        font-weight: 600;
        display: none;
    `;
    document.body.appendChild(div);
    return div;
}

// ─── SUPABASE / REALTIME INIT ─────────────────────────────────────────
async function initSocket() {
    if (socket) return;

    // Fetch config if not already available
    if (!supabaseClient) {
        try {
            const config = await apiReq('GET', '/api/config');
            if (!config.supabaseUrl || !config.supabaseKey) {
                console.error('Supabase config missing');
                return;
            }
            // Use the global 'supabase' object from the CDN script to create a client
            supabaseClient = supabase.createClient(config.supabaseUrl, config.supabaseKey);
        } catch (err) {
            console.error('Failed to load Supabase config:', err);
            return;
        }
    }

    // Main global channel for direct messages and notifications
    const globalChannel = supabaseClient.channel('global-updates', {
        config: { broadcast: { self: true } }
    });

    globalChannel
        .on('broadcast', { event: 'direct-message' }, ({ payload }) => {
            handleIncomingDirectMessage(payload);
        })
        .on('broadcast', { event: 'guest-invite-received' }, ({ payload }) => {
            if (isGuestStreamer) return;
            pendingGuestInvite = payload;
            $('guest-invite-msg').textContent = `${payload.hostName} invited you to go live!`;
            $('guest-invite-toast').classList.remove('hidden');
            setTimeout(() => $('guest-invite-toast').classList.add('hidden'), 20000);
        })
        .on('broadcast', { event: 'guest-invite-reply' }, ({ payload }) => {
            if (payload.accepted) {
                appendChat('System', `🎉 ${payload.username} accepted your invite and is joining!`, true);
            } else {
                appendChat('System', `❌ ${payload.username} declined your invitation.`, true);
            }
        })
        .on('broadcast', { event: 'guest-kicked' }, ({ payload }) => {
            if (isGuestStreamer) {
                alert('The host has ended your guest session.');
                stopGuestStream();
            }
        });

    if (currentUser) {
        globalChannel.on('broadcast', { event: `join-response-${currentUser.id}` }, ({ payload }) => {
            $('joinreq-status').textContent = payload.approved ? '✅ Approved! Joining...' : '❌ Host denied your request.';
            if (payload.approved && currentStream) {
                setTimeout(async () => {
                    closeModal('joinreq-modal');
                    try {
                        await enterLiveScreen(currentStream);
                    } catch (err) {
                        console.error('Failed to enter approved stream:', err);
                    }
                }, 1000);
            }
        });
    }

    globalChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
            socketConnected = true;
            console.log('Supabase Realtime connected');
        }
    });

    socket = globalChannel; // Store global channel as the default socket
}

function joinRoom(roomName) {
    if (!supabaseClient || !roomName) return;

    // Leave old room channel if exists
    if (window.roomChannel) {
        window.roomChannel.unsubscribe();
    }

    const channel = supabaseClient.channel(`room:${roomName}`, {
        config: {
            broadcast: { self: true },
            presence: { key: currentUser ? currentUser.id : 'guest-' + Math.random().toString(36).substr(2, 5) }
        }
    });

    channel
        .on('broadcast', { event: 'chat-message' }, ({ payload }) => {
            appendChat(payload.username, payload.message, false, payload.avatar);
        })
        .on('broadcast', { event: 'reaction' }, ({ payload }) => {
            if (currentScreen === 'live' && currentStream?.livekit_room === roomName) {
                showFloatingReaction(payload.emoji);
            }
        })
        .on('broadcast', { event: 'gift-animation' }, ({ payload }) => {
            showGiftBurst(payload.gift.icon, payload.sender, payload.gift.name);
        })
        .on('broadcast', { event: 'stream-ended' }, ({ payload }) => {
            if (!isHost) {
                alert(payload.message || 'Stream has ended.');
                leaveLiveScreen();
            }
        })
        .on('broadcast', { event: 'user-joined' }, ({ payload }) => {
            appendChat('System', `${payload.username} joined 🎉`, true);
        })
        .on('broadcast', { event: 'viewer-count' }, ({ payload }) => {
            $('hud-viewers').textContent = payload.count;
        })
        .on('broadcast', { event: 'join-request-received' }, ({ payload }) => {
            // Only host should respond, but anyone in room sees the toast if we want
            if (isHost) {
                showJoinRequestToast(payload.userId, payload.username, payload.streamId, payload.requestId);
            }
        })
        .on('broadcast', { event: 'guest-left' }, ({ payload }) => {
            removeGuestVideo(payload.userId);
        })
        .on('presence', { event: 'sync' }, () => {
            const state = channel.presenceState();
            const count = Object.keys(state).length;
            $('hud-viewers').textContent = count;

            // Sync viewer count to DB (if host)
            if (isHost) {
                apiReq('PUT', `/api/streams/${currentStream.id}/viewers`, { count }).catch(() => { });
            }
        })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                console.log(`Joined room: ${roomName}`);
                channel.send({
                    type: 'broadcast',
                    event: 'user-joined',
                    payload: { username: currentUser ? currentUser.username : 'Guest' }
                });

                await channel.track({
                    online_at: new Date().toISOString(),
                    username: currentUser ? currentUser.username : 'Guest'
                });
            }
        });

    window.roomChannel = channel;
}

// ─── SEARCH ───────────────────────────────────────────────────────────
function initSearch() {
    const searchInput = $('global-search');
    const searchWrap = document.querySelector('.search-bar-wrap');

    searchInput.addEventListener('input', debounce((e) => {
        const query = e.target.value.trim();
        if (query.length >= 2) {
            searchAll(query);
        } else if (query.length === 0) {
            loadStreams();
        }
    }, 500));

    const toggleSearch = () => {
        searchWrap.classList.toggle('active');
        if (searchWrap.classList.contains('active')) {
            searchInput.focus();
        } else {
            searchInput.value = '';
            if (currentScreen === 'home') loadStreams();
        }
    };

    document.querySelector('.search-trigger').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSearch();
    });

    searchInput.addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', (e) => {
        if (searchWrap.classList.contains('active')) {
            searchWrap.classList.remove('active');
            searchInput.value = '';
        }
    });
}

async function searchAll(query) {
    const feed = $('stream-feed');
    feed.innerHTML = '<div class="feed-loading"><div class="spinner"></div><p>Searching...</p></div>';
    try {
        const [streams, users] = await Promise.all([
            apiReq('GET', `/api/streams/search?q=${query}`),
            apiReq('GET', `/api/users/search?q=${query}`)
        ]);
        renderSearchResults(streams, users);
    } catch {
        feed.innerHTML = '<div class="feed-loading"><p>Search failed.</p></div>';
    }
}

function renderSearchResults(streams, users) {
    const feed = $('stream-feed');
    let html = '';

    if (streams.length) {
        html += '<h3 style="grid-column: 1/-1; font-size: 1.1rem; margin: 10px 0;">Live Streams</h3>';
        html += renderStreamFeedHTML(streams);
    }

    if (users.length) {
        html += '<h3 style="grid-column: 1/-1; font-size: 1.1rem; margin: 15px 0 10px;">Users</h3>';
        html += users.map(u => {
            const initials = u.username.charAt(0).toUpperCase();
            const avatarUrl = toAssetUrl(u.avatar);
            const avatarStyle = avatarUrl ? `background-image:url(${avatarUrl});background-size:cover;background-position:center;` : '';
            return `
                <div class="glass" style="display:flex; align-items:center; gap:12px; padding:10px; border-radius:12px; cursor:pointer;" onclick="viewUserProfile(${u.id})">
                    <div class="user-avatar-sm" style="background: linear-gradient(135deg, var(--accent), var(--accent2)); width:40px; height:40px; display:flex; align-items:center; justify-content:center; color:white; font-weight:bold; border-radius:50%; ${avatarStyle}">${avatarUrl ? '' : initials}</div>
                    <div style="font-weight:600;">${u.username}</div>
                </div>
            `;
        }).join('');
    }

    if (!streams.length && !users.length) {
        html = '<div class="feed-loading"><p>No results found.</p></div>';
    }

    feed.innerHTML = html;
}

function debounce(fn, delay) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
    };
}

async function retryAsync(task, { retries = 2, delayMs = 500, shouldRetry } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await task(attempt);
        } catch (err) {
            lastError = err;
            const retryable = shouldRetry ? shouldRetry(err) : true;
            if (!retryable || attempt === retries) break;
            await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
        }
    }
    throw lastError;
}

// ─── NAV ──────────────────────────────────────────────────────────────
function navigateTo(screenName) {
    currentScreen = screenName;
    if (screenName === 'golive' && !currentUser) {
        showAuthOverlay('login');
        return;
    }
    if (screenName === 'wallet' && !currentUser) {
        showAuthOverlay('login');
        return;
    }

    document.querySelectorAll('.screen').forEach(s => {
        s.classList.remove('active');
        s.classList.add('hidden');
    });

    const target = $(`screen-${screenName}`);
    if (target) {
        target.classList.remove('hidden');
        target.classList.add('active');
    }

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const navItem = document.querySelector(`.nav-item[data-screen="${screenName}"]`);
    if (navItem) navItem.classList.add('active');

    // Side effects
    if (screenName === 'golive') {
        initCamera();
    } else {
        stopCamera();
    }

    if (screenName === 'wallet') loadWallet();
    if (screenName === 'profile') renderProfile();
    if (screenName === 'chat') renderChatList();
    if (screenName === 'home') loadStreams(document.querySelector('.cat-pill.active')?.dataset.cat || 'all');
    if (screenName === 'home') {
        if (homeRefreshTimer) clearInterval(homeRefreshTimer);
        homeRefreshTimer = setInterval(() => {
            if (currentScreen === 'home') {
                loadStreams(document.querySelector('.cat-pill.active')?.dataset.cat || 'all');
            }
        }, 10000);
    } else if (homeRefreshTimer) {
        clearInterval(homeRefreshTimer);
        homeRefreshTimer = null;
    }
    if (screenName !== 'chat-thread') chatPartnerId = null;
    if (screenName !== 'view-profile' && screenName !== 'follow-list') {
        viewProfileUserId = null;
    }
}

// ─── AUTH ──────────────────────────────────────────────────────────────
function showAuthOverlay(form = 'login') {
    $('auth-overlay').classList.remove('hidden');
    showAuthForm(form);
}
function hideAuthOverlay() {
    $('auth-overlay').classList.add('hidden');
    // Start 5-min guest timer
    if (!currentUser) startGuestTimer();
}
function showAuthForm(form) {
    $('login-form').classList.toggle('hidden', form !== 'login');
    $('register-form').classList.toggle('hidden', form !== 'register');
}

$('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('login-email').value.trim().toLowerCase();
    const password = $('login-password').value;
    try {
        const user = await apiReq('POST', '/api/auth/login', { email, password });
        saveSession(user);
        hideAuthOverlay();
        afterLogin();
    } catch (err) {
        showError('login-error', err.message);
    }
});

$('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('reg-username').value.trim();
    const email = $('reg-email').value.trim().toLowerCase();
    const password = $('reg-password').value;
    try {
        const user = await apiReq('POST', '/api/auth/register', { username, email, password });
        saveSession(user);
        hideAuthOverlay();
        afterLogin();
    } catch (err) {
        showError('reg-error', err.message);
    }
});

function saveSession(user) {
    token = user.token;
    currentUser = user;
    localStorage.setItem('tl_token', token);
    localStorage.setItem('tl_user', JSON.stringify(user));
}

function afterLogin() {
    clearGuestTimer();
    $('guest-timer-popup').classList.add('hidden');

    // Explicitly disconnect old guest socket before creating a new authenticated one
    if (supabaseClient) {
        supabaseClient.removeAllChannels();
        socket = null;
    }

    initSocket();
    renderTopBar();
    navigateTo('home');
}

function logout() {
    token = null;
    currentUser = null;
    localStorage.removeItem('tl_token');
    localStorage.removeItem('tl_user');
    if (supabaseClient) {
        supabaseClient.removeAllChannels();
        socket = null;
    }
    renderTopBar();
    navigateTo('home');
    showAuthOverlay('login');
}

function showError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
}

// ─── GUEST TIMER ──────────────────────────────────────────────────────
let guestSecondsLeft = 5 * 60;
function startGuestTimer() {
    if (currentUser) return;
    clearGuestTimer(); // Ensure only one timer is running at a time
    guestSecondsLeft = 5 * 60;
    const popup = $('guest-timer-popup');
    popup.classList.remove('hidden');

    guestTimerInterval = setInterval(() => {
        guestSecondsLeft--;
        const m = Math.floor(guestSecondsLeft / 60);
        const s = guestSecondsLeft % 60;
        $('guest-timer-count').textContent = `${m}:${s.toString().padStart(2, '0')}`;
        if (guestSecondsLeft <= 0) {
            clearGuestTimer();
            popup.classList.add('hidden');
            leaveLiveScreen();
            showAuthOverlay('register');
        }
    }, 1000);
}
function clearGuestTimer() {
    if (guestTimerInterval) { clearInterval(guestTimerInterval); guestTimerInterval = null; }
}

// ─── TOP BAR ──────────────────────────────────────────────────────────
function renderTopBar() {
    const avatarEl = $('user-avatar-top');
    if (currentUser) {
        setAvatar(avatarEl, currentUser.avatar, currentUser.username);
    } else {
        setAvatar(avatarEl, null, null);
    }
}

// ─── HOME FEED ────────────────────────────────────────────────────────
async function loadStreams(cat) {
    const feed = $('stream-feed');
    feed.innerHTML = '<div class="feed-loading"><div class="spinner"></div><p>Loading streams...</p></div>';
    try {
        let endpoint = currentUser ? '/api/streams/all' : '/api/streams';
        if (cat === 'following') endpoint += '?category=following';

        const streams = await apiReq('GET', endpoint);
        renderStreamFeed(streams, cat);
    } catch {
        feed.innerHTML = '<div class="feed-loading"><p>Could not load streams.</p></div>';
    }
}

const STREAM_EMOJIS = { Gaming: '🎮', Music: '🎵', Talk: '💬', Dance: '💃', Cooking: '🍳', General: '🌐' };
function renderStreamFeed(streams, cat) {
    const feed = $('stream-feed');
    let filtered = streams;
    if (cat && cat !== 'all' && cat !== 'following') {
        filtered = streams.filter(s => s.category?.toLowerCase() === cat.toLowerCase());
    }
    if (!filtered.length) {
        if (cat === 'following') {
            feed.innerHTML = '<div class="feed-loading"><span style="font-size:2.5rem">🤝</span><p>No one you follow is live. Explore some new hosts!</p></div>';
            return;
        }

        filtered = [
            { id: "'mock1'", username: 'GamingGuru', category: 'Gaming', viewer_count: 1240, type: 'public', title: 'Late Night Valorant Ranked!' },
            { id: "'mock2'", username: 'MelodyMaker', category: 'Music', viewer_count: 850, type: 'public', title: 'Acoustic Covers & Chill' },
            { id: "'mock3'", username: 'ChefGordon', category: 'Cooking', viewer_count: 3200, type: 'public', title: 'Making the perfect Carbonara' },
            { id: "'mock4'", username: 'DanceQueen', category: 'Dance', viewer_count: 540, type: 'public', title: 'Learning new K-Pop Choreo' }
        ];
        if (cat && cat !== 'all') {
            filtered = filtered.filter(s => s.category?.toLowerCase() === cat.toLowerCase());
        }
    }
    feed.innerHTML = renderStreamFeedHTML(filtered);
}

function captureThumbnail() {
    const video = document.getElementById('local-video');
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

function renderStreamFeedHTML(streams) {
    return streams.map((s, i) => {
        const initials = s.username ? s.username.charAt(0).toUpperCase() : '?';
        const thumbUrl = toAssetUrl(s.thumbnail);
        const avatarUrl = toAssetUrl(s.avatar);
        const thumbBg = thumbUrl ? `background-image:url(${thumbUrl});background-size:cover;background-position:center;` : '';

        return `
    <div class="stream-card" style="animation-delay:${i * 0.07}s" onclick="openStream(${s.id})">
      <div class="stream-thumb" style="${thumbBg}">
        ${!s.thumbnail ? `<span class="stream-thumb-emoji">${STREAM_EMOJIS[s.category] || '🌐'}</span>` : ''}
        <div class="stream-thumb-overlay"></div>
        <span style="position:absolute;top:8px;left:8px;z-index:2">
          <span class="live-badge">LIVE</span>
          ${s.is_trending ? '<span class="trending-badge">🔥 TRENDING</span>' : ''}
        </span>
        ${s.type && s.type.toLowerCase() !== 'public' ? `
          <div style="position:absolute;top:8px;right:8px;z-index:3;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);padding:4px 6px;border-radius:8px;border:1px solid var(--glass-border);display:flex;align-items:center;gap:4px">
            <span style="font-size:0.9rem">${s.type.toLowerCase() === 'private' ? '🔒' : '👥'}</span>
          </div>` : ''}
      </div>
      <div class="stream-card-info">
        <div style="display:flex; align-items:center; gap:8px">
           <div class="thumb-avatar" style="width:20px;height:20px;font-size:0.6rem;background:var(--accent);display:flex;align-items:center;justify-content:center;color:white;border-radius:50%;background-size:cover;background-position:center;${avatarUrl ? `background-image:url(${avatarUrl})` : ''}">${avatarUrl ? '' : initials}</div>
           <div class="stream-card-host">${s.username}</div>
        </div>
        <div class="stream-card-meta">
          <span class="viewer-count">👁 ${s.viewer_count || 0}</span>
        </div>
        <div class="stream-card-cat">${s.category || 'General'}</div>
      </div>
    </div>
  `;
    }).join('');
}

document.querySelectorAll('.cat-pill').forEach(pill => {
    pill.addEventListener('click', () => {
        document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        loadStreams(pill.dataset.cat);
    });
});

// ─── OPEN STREAM ──────────────────────────────────────────────────────
async function openStream(streamId) {
    if (typeof streamId === 'string' && streamId.startsWith('mock')) {
        alert("This is just a sample placeholder stream to show what the UI looks like!");
        return;
    }
    try {
        const stream = await apiReq('GET', `/api/streams/${streamId}`);
        currentStream = stream;
        isHost = currentUser && currentUser.id === stream.host_id;

        // For private/group: show join request flow
        if ((stream.type === 'private' || stream.type === 'group') && !isHost) {
            if (!currentUser) { showAuthOverlay('login'); return; }
            showJoinRequestModal(stream);
            return;
        }

        await enterLiveScreen(stream);

        // Start guest timer if not logged in
        if (!currentUser) startGuestTimer();
    } catch (err) {
        alert('Failed to open stream: ' + err.message);
    }
}

async function enterLiveScreen(stream, existingToken = null) {
    currentScreen = 'live';
    currentStream = stream;
    if (!shouldPublishLocalTracks()) {
        stopCamera(); // viewers do not need local preview stream
    }

    // NEW: Reset co-streaming states for the new session
    activeGuestIds.clear();
    isGuestStreamer = false;
    $('video-area').innerHTML = ''; // Clear all old video wrappers
    $('video-area').className = 'video-area grid-1'; // Reset grid

    // Update HUD
    $('hud-title').textContent = stream.title || 'Live Stream';
    $('hud-viewers').textContent = stream.viewer_count || 0;
    $('hud-host-name').textContent = stream.username || 'Host';

    setAvatar($('hud-host-avatar'), stream.avatar, stream.username || 'H');

    // Show/hide end stream button & host controls
    const endBtn = $('end-stream-btn');
    if (endBtn) endBtn.classList.toggle('hidden', !isHost);

    const hostCtrls = $('host-controls');
    if (hostCtrls) hostCtrls.classList.toggle('hidden', !isHost);

    const viewerCtrls = $('viewer-controls');
    if (viewerCtrls) viewerCtrls.classList.toggle('hidden', isHost);

    // Initial state for host/viewer toggles
    if (isHost) {
        const micBtn = $('hud-mic-btn');
        const camBtn = $('hud-cam-btn');
        if (micBtn) {
            micBtn.classList.remove('muted');
            micBtn.textContent = '🎤';
        }
        if (camBtn) {
            camBtn.classList.remove('muted');
            camBtn.textContent = '📷';
        }
        const vPlaceholder = $('video-placeholder');
        if (vPlaceholder) vPlaceholder.classList.add('hidden');
    }

    // Clear chat
    const chatBox = $('chat-messages');
    if (chatBox) chatBox.innerHTML = '';

    // Switch screen
    document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.classList.add('hidden'); });
    $('screen-live').classList.remove('hidden');
    $('screen-live').classList.add('active');

    // Join socket room
    initSocket();
    joinRoom(stream.livekit_room);

    // Create host's own local video wrapper in the grid
    if (isHost) {
        const videoArea = $('video-area');
        const localWrapper = document.createElement('div');
        localWrapper.id = `video-wrapper-${currentUser.username}`;
        localWrapper.className = 'video-wrapper';
        const localVid = document.createElement('video');
        localVid.id = 'local-video';
        localVid.className = 'live-video';
        localVid.autoplay = true;
        localVid.muted = true;
        localVid.playsInline = true;
        const badge = document.createElement('div');
        badge.className = 'guest-name-badge';
        badge.textContent = (currentUser?.username || 'You') + ' (Host)';
        localWrapper.appendChild(localVid);
        localWrapper.appendChild(badge);
        videoArea.insertBefore(localWrapper, videoArea.firstChild);
        // Show immediate preview while LiveKit connection initializes.
        if (mediaStream) {
            localVid.srcObject = mediaStream;
            localVid.classList.remove('hidden');
            localVid.play().catch(() => { });
        }
        // Note: We don't add '__local__' to activeGuestIds anymore. 
        // updateVideoGrid() handles the local user separately.
        updateVideoGrid();
    }

    // Fetch LiveKit token and connect (unless token is already provided)
    try {
        const livekitToken = existingToken || (await retryAsync(async () => {
            const tk = await apiReq('POST', '/api/livekit/token', {
                room: stream.livekit_room,
                identity: currentUser ? currentUser.username : null,
                canPublish: shouldPublishLocalTracks()
            });
            if (!tk?.token) throw new Error('LiveKit token was empty');
            return tk;
        }, {
            retries: 2,
            delayMs: 700,
            shouldRetry: (err) => !String(err?.message || '').includes('Not authorized'),
        })).token;

        await retryAsync(
            async () => connectToLiveKit(livekitToken, stream.livekit_room),
            {
                retries: 1,
                delayMs: 800,
                shouldRetry: (err) => {
                    const msg = String(err?.message || '');
                    return !msg.includes('Client initiated disconnect');
                },
            }
        );
    } catch (err) {
        console.error('Failed to initialize LiveKit:', err);
        const overlay = $('connection-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
            overlay.innerHTML = `<p class="error-msg">Failed to connect: ${err.message}</p>`;
        }
        if (!currentUser) {
            appendChat('System', 'You are watching as a guest. Log in to chat and send gifts!', true);
        }
    }

    // Load gifts
    loadGifts();

    // Check follow status
    updateFollowButton();
}


// ─── FOLLOW SYSTEM ────────────────────────────────────────────────────
async function toggleFollow() {
    if (!currentUser) { showAuthOverlay('login'); return; }
    if (!currentStream || isHost) return;

    const followBtn = $('hud-follow-btn');
    const isFollowing = followBtn.classList.contains('following');
    const method = isFollowing ? 'DELETE' : 'POST';

    try {
        await apiReq(method, `/api/users/follow/${currentStream.host_id}`);
        updateFollowButton();
    } catch (err) {
        console.error("Follow error:", err);
    }
}

async function updateFollowButton() {
    const btn = $('hud-follow-btn');
    if (!btn) return;

    if (!currentUser || !currentStream || isHost) {
        btn.classList.add('hidden');
        return;
    }

    try {
        const { isFollowing } = await apiReq('GET', `/api/users/follow-status/${currentStream.host_id}`);
        btn.classList.remove('hidden');
        btn.classList.toggle('following', isFollowing);
        btn.textContent = isFollowing ? 'Following' : '+ Follow';
    } catch (e) {
        btn.classList.add('hidden');
    }
}


// End of previous block

// ─── LIVEKIT INTEGRATION ──────────────────────────────────────────────
function shouldPublishLocalTracks() {
    return isHost || isGuestStreamer;
}

function markManualLivekitDisconnect() {
    lastManualLivekitDisconnectAt = Date.now();
}

function clearAudioElements() {
    document.querySelectorAll('audio[id^="audio-track-"]').forEach((el) => el.remove());
}

function normalizeLivekitUrl(rawUrl) {
    const url = (rawUrl || '').trim();
    if (!url) throw new Error('LiveKit URL is missing');
    if (!url.startsWith('wss://')) {
        throw new Error('Invalid LiveKit URL. Expected a secure wss:// URL');
    }
    return url;
}

async function getLivekitUrl() {
    if (cachedLivekitUrl) return normalizeLivekitUrl(cachedLivekitUrl);
    const config = await apiReq('GET', '/api/config');
    cachedLivekitUrl = normalizeLivekitUrl(config.livekitUrl);
    return cachedLivekitUrl;
}

async function attachLocalVideo(track) {
    const localVideo = $('local-video');
    if (!localVideo || !track) return;
    track.detach(localVideo);
    track.attach(localVideo);
    localVideo.classList.remove('hidden');
    try {
        await localVideo.play();
    } catch (e) {
        console.warn('Local video play() wait warning:', e);
    }
}

async function syncHostControlButtons() {
    if (!shouldPublishLocalTracks() || !livekitRoom?.localParticipant) return;
    const micBtn = $('hud-mic-btn');
    const camBtn = $('hud-cam-btn');
    const audioPub = Array.from(livekitRoom.localParticipant.audioTrackPublications.values())[0];
    const micEnabledFromPub = audioPub ? !audioPub.isMuted : null;
    const micEnabledFromLocalTrack = mediaStream?.getAudioTracks?.()[0]?.enabled;
    const micEnabled = micEnabledFromPub !== null
        ? micEnabledFromPub
        : (typeof micEnabledFromLocalTrack === 'boolean'
            ? micEnabledFromLocalTrack
            : !!livekitRoom.localParticipant.isMicrophoneEnabled);
    const camEnabled = livekitRoom.localParticipant.isCameraEnabled;
    if (micBtn) {
        micBtn.classList.toggle('muted', !micEnabled);
        micBtn.textContent = micEnabled ? '🎤' : '🔇';
    }
    if (camBtn) {
        camBtn.classList.toggle('muted', !camEnabled);
        camBtn.textContent = camEnabled ? '📷' : '🚫';
    }
}

async function ensureLocalMediaPublished() {
    await livekitRoom.localParticipant.setMicrophoneEnabled(true);
    await livekitRoom.localParticipant.setCameraEnabled(true);
    const videoPub = Array.from(livekitRoom.localParticipant.videoTrackPublications.values())[0];
    if (videoPub?.track) {
        await attachLocalVideo(videoPub.track);
    }
    await syncHostControlButtons();
}

async function connectToLiveKit(token, roomName) {
    const connectSeq = ++livekitConnectSeq;
    if (livekitRoom) {
        try {
            markManualLivekitDisconnect();
            await livekitRoom.disconnect();
        } catch (disconnectErr) {
            console.warn('Previous LiveKit disconnect warning:', disconnectErr);
        }
    }
    clearAudioElements();

    const preferMobilePreset = isMobileDevice();
    const publishPreset = preferMobilePreset
        ? (LivekitClient.VideoPresets?.h540 || LivekitClient.VideoPresets?.h720)
        : (LivekitClient.VideoPresets?.h1080 || LivekitClient.VideoPresets?.h720);
    const preferredCodec = preferMobilePreset ? 'vp8' : 'h264';
    livekitRoom = new LivekitClient.Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
            resolution: publishPreset.resolution,
        },
        publishDefaults: {
            simulcast: !preferMobilePreset,
            videoEncoding: publishPreset.encoding,
            screenShareEncoding: publishPreset.encoding,
            videoCodec: preferredCodec,
        }
    });

    // Setup event listeners
    livekitRoom
        .on(LivekitClient.RoomEvent.TrackSubscribed, handleTrackSubscribed)
        .on(LivekitClient.RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
        .on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, handleAudioPlaybackStatus)
        .on(LivekitClient.RoomEvent.TrackMuted, (pub, part) => handleTrackMuteChange(pub, part, true))
        .on(LivekitClient.RoomEvent.TrackUnmuted, (pub, part) => handleTrackMuteChange(pub, part, false))
        .on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            removeGuestVideo(participant.identity);
        })
        .on(LivekitClient.RoomEvent.Disconnected, () => {
            const isManual = Date.now() - lastManualLivekitDisconnectAt < 4000;
            if (isManual) {
                console.log('[LiveKit] Disconnected (manual/reconnect)');
            } else {
                console.warn('[LiveKit] Disconnected unexpectedly');
            }
            clearAudioElements();
        });

    // Show connection overlay at start of connect attempt
    const connOverlay = $('connection-overlay');
    if (connOverlay) {
        connOverlay.classList.remove('hidden');
        connOverlay.innerHTML = '<div class="spinner"></div><p>Connecting to stream...</p>';
    }

    try {
        const livekitUrl = await getLivekitUrl();

        await livekitRoom.connect(livekitUrl, token);
        if (connectSeq !== livekitConnectSeq) {
            await livekitRoom.disconnect();
            return;
        }
        console.log('[LiveKit] Connected to room:', roomName);

        if (shouldPublishLocalTracks()) {
            await ensureLocalMediaPublished();
            console.log('[LiveKit] Local media enabled and published');
        }

        if (!shouldPublishLocalTracks() && !livekitRoom.canPlaybackAudio) {
            console.warn('Audio blocked immediately on connect. Showing prompt.');
            showAudioPrompt();
        }

        if (!shouldPublishLocalTracks()) {
            await livekitRoom.startAudio().catch((e) => {
                console.warn('Early startAudio failed:', e);
            });
            livekitRoom.remoteParticipants.forEach((participant) => {
                participant.trackPublications.forEach((publication) => {
                    if (publication.track) {
                        handleTrackSubscribed(publication.track, publication, participant);
                    }
                });
            });
        }
        if (connOverlay) connOverlay.classList.add('hidden');
    } catch (error) {
        const errorMsg = String(error?.message || '');
        const isExpectedDisconnect =
            connectSeq !== livekitConnectSeq ||
            errorMsg.includes('Client initiated disconnect') ||
            errorMsg.includes('user initiated disconnect');
        if (isExpectedDisconnect) {
            console.warn('[LiveKit] Connect attempt cancelled by a newer request.');
            return;
        }
        console.error('[LiveKit] Failed to connect:', error);
        const overlay = $('connection-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
            overlay.innerHTML = `
                <p class="error-msg" style="background:none;">Video connection failed. Please check LiveKit configuration.</p>
                <button class="btn-primary btn-sm" onclick="location.reload()">Retry Connection</button>
            `;
        }
    }
}

function handleTrackSubscribed(track, publication, participant) {
    console.log('Track subscribed:', track.kind, participant.identity);
    if (track.kind === 'video') {
        renderParticipantVideo(participant, track);
        // If track is already muted when subscribed
        if (publication.isMuted) {
            handleTrackMuteChange(publication, participant, true);
        }
    } else if (track.kind === 'audio') {
        const audioId = `audio-track-${participant.identity}`;
        let existing = $(audioId);
        if (existing) {
            existing.pause();
            existing.remove();
        }

        const el = track.attach();
        el.id = audioId;
        el.muted = false;
        el.autoplay = true;
        el.playsInline = true;
        document.body.appendChild(el);
        el.play().catch(e => {
            console.warn('Initial audio play() failed:', e);
            showAudioPrompt();
        });
        console.log('Audio track attached for:', participant.identity);
    }
}

function renderParticipantVideo(participant, track) {
    // Failsafe: Hide connection overlay whenever a video is rendered
    const connOverlay = $('connection-overlay');
    if (connOverlay) connOverlay.classList.add('hidden');

    const videoArea = $('video-area');
    const wrapperId = `video-wrapper-${participant.identity}`;
    let wrapper = $(wrapperId);

    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = wrapperId;
        wrapper.className = 'video-wrapper';

        const videoEl = document.createElement('video');
        videoEl.id = `video-${participant.identity}`;
        videoEl.className = 'live-video';
        videoEl.autoplay = true;
        videoEl.playsInline = true;

        const badge = document.createElement('div');
        badge.className = 'guest-name-badge';
        badge.textContent = participant.identity || 'Guest';

        wrapper.appendChild(videoEl);
        wrapper.appendChild(badge);

        // If I am host, add a Kick button for guests (but not for myself)
        if (isHost && !participant.isLocal) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'kick-btn-overlay';
            kickBtn.innerHTML = '✕';
            kickBtn.onclick = (e) => { e.stopPropagation(); kickGuest(participant.identity); };
            wrapper.appendChild(kickBtn);
        }

        videoArea.appendChild(wrapper);
        activeGuestIds.add(participant.identity);
        updateVideoGrid();
    }

    const video = wrapper.querySelector('video');
    track.detach(video);
    track.attach(video);
    video.play().catch(e => console.warn('Autoplay prevented video:', e));
}

function handleTrackUnsubscribed(track, publication, participant) {
    track.detach();
    if (track.kind === 'video') {
        removeGuestVideo(participant.identity);
    } else if (track.kind === 'audio') {
        const audioEl = $(`audio-track-${participant.identity}`);
        if (audioEl) {
            audioEl.pause();
            audioEl.remove();
        }
    }
}

function removeGuestVideo(identity) {
    const wrapper = $(`video-wrapper-${identity}`);
    if (wrapper) {
        wrapper.remove();
        activeGuestIds.delete(identity);
        updateVideoGrid();
    }
}

function updateVideoGrid() {
    const area = $('video-area');
    if (!area) return;

    const count = activeGuestIds.size + (isHost || isGuestStreamer ? 1 : 0); // Participants + Local 

    // Clear old grid classes
    area.classList.remove('grid-1', 'grid-2', 'grid-3', 'grid-4');

    if (count <= 1) area.classList.add('grid-1');
    else if (count === 2) area.classList.add('grid-2');
    else if (count === 3) area.classList.add('grid-3');
    else area.classList.add('grid-4');
}

function handleAudioPlaybackStatus() {
    if (!livekitRoom) return;
    console.log('Audio playback status changed. Can playback:', livekitRoom.canPlaybackAudio);
    if (livekitRoom.canPlaybackAudio) {
        hideAudioPrompt();
    } else {
        showAudioPrompt();
    }
}

function showAudioPrompt() {
    let prompt = $('audio-prompt');
    if (!prompt) prompt = createAudioPrompt();
    prompt.classList.remove('hidden');
    // For some browsers, adding interaction hint helps
    console.warn('Audio is blocked by browser. Showing unmute prompt.');
}

function hideAudioPrompt() {
    const prompt = $('audio-prompt');
    if (prompt) prompt.classList.add('hidden');
}

function createAudioPrompt() {
    const div = document.createElement('div');
    div.id = 'audio-prompt';
    div.className = 'audio-unlock-overlay hidden';
    div.innerHTML = `
        <div class="audio-prompt-content glass">
            <div class="prompt-icon-ring">
                <span class="prompt-icon-large">🔇</span>
            </div>
            <h3>Audio is Muted</h3>
            <p>Your browser is blocking sound.</p>
            <button class="btn-primary" onclick="resumeAudio()">
                Tap to Unmute
            </button>
        </div>
    `;
    // Append to body to ensure it's not hidden by container overflow
    document.body.appendChild(div);
    return div;
}

async function resumeAudio() {
    if (livekitRoom) {
        try {
            await livekitRoom.startAudio();
            console.log('Audio manually resumed by user');
            hideAudioPrompt();
        } catch (err) {
            console.error('Failed to resume audio:', err);
        }
    }
}


function leaveLiveScreen() {
    if (socket && currentStream) {
        // roomChannel.unsubscribe() is handled in joinRoom
    }
    if (livekitRoom) {
        markManualLivekitDisconnect();
        livekitRoom.disconnect();
        livekitRoom = null;
    }
    clearAudioElements();
    closeGiftPanel();
    currentStream = null;

    isHost = false;
    isGuestStreamer = false;
    activeGuestIds.clear();
    $('video-area').innerHTML = ''; // Clean up all video elements

    clearGuestTimer();
    $('guest-timer-popup').classList.add('hidden');
    stopCamera();
    navigateTo('home');
}

// ─── GO LIVE ──────────────────────────────────────────────────────────
let mediaStream = null;
async function initCamera() {
    try {
        const useMobileProfile = isMobileDevice();
        const cameraProfiles = useMobileProfile
            ? [
                { video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' }, audio: true },
                { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' }, audio: true },
            ]
            : [
                { video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' }, audio: true },
                { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' }, audio: true },
            ];
        let lastErr = null;
        for (const constraints of cameraProfiles) {
            try {
                mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
                break;
            } catch (err) {
                lastErr = err;
            }
        }
        if (!mediaStream) throw lastErr || new Error('Unable to access camera');
        $('camera-preview').srcObject = mediaStream;
    } catch {
        console.warn('Camera not available');
    }
}
function stopCamera() {
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    const preview = $('camera-preview');
    if (preview) preview.srcObject = null;
}

// Capture a single frame from the camera preview as a Blob (JPEG)
function captureThumbnail() {
    return new Promise((resolve) => {
        const video = $('camera-preview');
        if (!video || !video.srcObject || video.videoWidth === 0) {
            resolve(null);
            return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 270; // 16:9
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
    });
}

// Stream type picker
document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

$('go-live-btn').addEventListener('click', async () => {
    if (!currentUser) { showAuthOverlay('login'); return; }
    if (isGoLiveInProgress) return;
    isGoLiveInProgress = true;
    const title = $('stream-title').value || 'My Live Stream';
    const category = $('stream-category').value;
    const type = document.querySelector('.type-btn.active')?.dataset.type || 'public';

    const btn = $('go-live-btn');
    btn.disabled = true;
    btn.textContent = '📸 Capturing...';

    try {
        // 1. Capture a thumbnail frame from the camera preview
        const thumbnailBlob = await captureThumbnail();

        // 2. Build FormData so we can send both text fields + the image file
        const formData = new FormData();
        formData.append('title', title);
        formData.append('category', category);
        formData.append('type', type);
        if (thumbnailBlob) {
            formData.append('thumbnail', thumbnailBlob, 'thumb.jpg');
        }

        // 3. Create stream with thumbnail (multipart request – can't use apiReq helper)
        btn.textContent = '🚀 Going Live...';
        const res = await fetch(`${API}/api/streams`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
        });
        const stream = await res.json();
        if (!res.ok) throw new Error(stream.message || 'Failed to create stream');

        currentStream = stream;
        isHost = true;

        // 4. Fetch LiveKit token for host
        const tkData = await apiReq('POST', '/api/livekit/token', {
            room: stream.livekit_room,
            identity: currentUser.username,
            canPublish: true
        });

        // 5. Enter live screen with the token we just fetched (prevents double connection)
        await enterLiveScreen(stream, tkData.token);
    } catch (err) {
        alert('Failed to go live: ' + err.message);
    } finally {
        isGoLiveInProgress = false;
        btn.disabled = false;
        btn.innerHTML = '<span class="live-dot-anim"></span> GO LIVE';
    }
});


// ─── END STREAM ────────────────────────────────────────────────────────
async function endStream() {
    if (!currentStream || !isHost) return;
    try {
        await apiReq('PUT', `/api/streams/${currentStream.id}/end`);
        window.roomChannel?.send({
            type: 'broadcast',
            event: 'stream-ended',
            payload: { message: 'The host has ended the stream.' }
        });
        leaveLiveScreen();
    } catch (err) { alert(err.message); }
}

// ─── CHAT ──────────────────────────────────────────────────────────────
$('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage('live');
});
function sendChatMessage(context) {
    const input = $('chat-input');
    const msg = input.value.trim();
    if (!msg || !currentStream) return;
    window.roomChannel?.send({
        type: 'broadcast',
        event: 'chat-message',
        payload: { username: currentUser ? currentUser.username : 'Guest', message: msg, avatar: currentUser ? currentUser.avatar : '' }
    });
    input.value = '';
}
function appendChat(username, message, isSystem = false, avatar = '') {
    const box = $('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = `chat-msg ${isSystem ? 'system-msg' : ''}`;

    if (isSystem) {
        div.innerHTML = `<span class="chat-msg-text" style="color:var(--accent2); font-weight:600">${message}</span>`;
    } else {
        const initials = username ? username.charAt(0).toUpperCase() : '?';
        const avatarUrl = toAssetUrl(avatar);
        const avatarHtml = `<div class="chat-avatar" style="${avatarUrl ? `background-image:url(${avatarUrl});background-size:cover;background-position:center;` : `background:var(--accent)`}">${avatarUrl ? '' : initials}</div>`;
        div.innerHTML = `${avatarHtml}<div class="chat-msg-content"><span class="chat-msg-name">${username}</span><span class="chat-msg-text">${message}</span></div>`;
    }

    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

// ─── REACTIONS ─────────────────────────────────────────────────────────
function sendReaction(emoji) {
    if (!currentStream) return;
    window.roomChannel?.send({
        type: 'broadcast',
        event: 'reaction',
        payload: { emoji, username: currentUser ? currentUser.username : 'Guest' }
    });
    showFloatingReaction(emoji);
}
function showFloatingReaction(emoji) {
    let overlay = $('reaction-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'reaction-overlay';
        overlay.className = 'reaction-overlay';
        const liveScreen = $('screen-live');
        if (liveScreen) {
            liveScreen.appendChild(overlay);
        } else {
            document.body.appendChild(overlay);
        }
        console.warn('[UI] reaction-overlay was missing. Created dynamically.');
    }
    const el = document.createElement('div');
    el.className = 'floating-reaction';
    el.textContent = emoji;
    el.style.left = Math.random() * 70 + 5 + '%';
    overlay.appendChild(el);
    setTimeout(() => el.remove(), 2500);
}

// ─── GIFTS ─────────────────────────────────────────────────────────────
let giftsCache = [];
async function loadGifts() {
    if (giftsCache.length) { renderGiftList(); return; }
    try {
        giftsCache = await retryAsync(() => apiReq('GET', '/api/gifts'), { retries: 1, delayMs: 500 });
        renderGiftList();
    } catch (err) {
        console.error('Failed to load gifts:', err);
    }
}
function renderGiftList() {
    const giftList = $('gift-list');
    if (!giftList) return;
    giftList.innerHTML = giftsCache.map((g, idx) => `
    <div class="gift-item" onclick="sendGiftByIndex(${idx})">
      <div class="gift-icon">${g.icon}</div>
      <div class="gift-name">${g.name}</div>
      <div class="gift-cost">🪙${g.coin_cost}</div>
    </div>
  `).join('');
}
function sendGiftByIndex(index) {
    const gift = giftsCache[index];
    if (!gift) {
        alert('Gift is unavailable. Please refresh and try again.');
        return;
    }
    return sendGift(gift);
}
function toggleGiftPanel(forceOpen = null) {
    if (!currentUser) { showAuthOverlay('login'); return; }
    const panel = $('gift-panel');
    if (!panel) return;
    const shouldOpen = typeof forceOpen === 'boolean'
        ? forceOpen
        : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !shouldOpen);
}
function closeGiftPanel() {
    const panel = $('gift-panel');
    if (panel) panel.classList.add('hidden');
}
async function sendGift(giftInput) {
    if (!currentUser || !currentStream) return;
    if (isGiftSending) return;
    isGiftSending = true;
    const gift = typeof giftInput === 'object'
        ? giftInput
        : giftsCache.find((g) => String(g.id) === String(giftInput));
    if (!gift) {
        isGiftSending = false;
        return;
    }
    try {
        let receiverId = currentStream.host_id ?? currentStream.user_id ?? currentStream.host?.id;
        if (!receiverId && currentStream.id) {
            const latestStream = await apiReq('GET', `/api/streams/${currentStream.id}`);
            receiverId = latestStream.host_id ?? latestStream.user_id ?? latestStream.host?.id;
            if (receiverId) currentStream.host_id = receiverId;
        }
        if (!receiverId) {
            throw new Error('Unable to send gift: stream host is unavailable.');
        }
        if (Number(receiverId) === Number(currentUser.id)) {
            throw new Error('You cannot send gifts to your own stream.');
        }
        if ((Number(currentUser.coin_balance) || 0) < (Number(gift.coin_cost) || 0)) {
            throw new Error(`Insufficient coins. Need ${gift.coin_cost}, you have ${currentUser.coin_balance || 0}.`);
        }

        await apiReq('POST', '/api/gifts/send', {
            gift_id: gift.id,
            stream_id: currentStream.id,
            receiver_id: receiverId,
        });
        window.roomChannel?.send({
            type: 'broadcast',
            event: 'gift-animation',
            payload: {
                sender: currentUser ? currentUser.username : 'Guest',
                receiver: currentStream?.username,
                gift,
            }
        });
        showGiftBurst(gift.icon, 'You', gift.name);
        closeGiftPanel();
        // Refresh user coins locally
        currentUser.coin_balance = Math.max(0, (Number(currentUser.coin_balance) || 0) - Number(gift.coin_cost || 0));
        localStorage.setItem('tl_user', JSON.stringify(currentUser));
    } catch (err) {
        console.error('Gift send failed:', err);
        alert(err.message || 'Failed to send gift.');
    } finally {
        isGiftSending = false;
    }
}
function showGiftBurst(icon, sender, name) {
    const el = document.createElement('div');
    el.className = 'gift-burst';
    el.innerHTML = `${icon}<br><small style="font-size:.5em;opacity:.8">${sender} sent ${name}</small>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
}

// ─── WALLET ────────────────────────────────────────────────────────────
async function loadWallet() {
    if (!$('wallet-balance') || !$('wallet-transactions')) return;
    $('wallet-balance').textContent = '...';
    $('wallet-transactions').innerHTML = '';
    try {
        const data = await apiReq('GET', '/api/wallet');
        $('wallet-balance').textContent = data.coin_balance.toLocaleString();
        if (!data.transactions.length) {
            $('wallet-transactions').innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px">No transactions yet</p>';
            return;
        }
        $('wallet-transactions').innerHTML = data.transactions.map(t => {
            const isGiftDebit = t.sender_id === currentUser.id && t.receiver_id !== currentUser.id && t.receiver_id !== null;
            const isWithdrawal = t.gift_name === 'Withdrawal';
            const isPurchase = t.gift_name === 'Coin Purchase';

            const isDebit = isGiftDebit || isWithdrawal; // Money leaving or being locked for withdrawal

            let typeLabel = isGiftDebit ? 'Gift Sent' : 'Gift Received';
            let icon = t.gift_icon || '🪙';
            let subText = isGiftDebit ? 'To ' + (t.receiver_name || '?') : 'From ' + (t.sender_name || '?');

            if (isPurchase) {
                typeLabel = 'Coins Purchased';
                icon = '💳';
                subText = 'via Credit Card';
            } else if (isWithdrawal) {
                typeLabel = 'Withdrawal Request';
                icon = '💸';
                subText = 'Pending Approval';
            }

            return `
        <div class="txn-item">
          <div class="txn-icon">${icon}</div>
          <div class="txn-info">
            <div class="txn-title">${typeLabel}</div>
            <div class="txn-sub">${subText}</div>
          </div>
          <div class="txn-amount ${isDebit ? 'debit' : 'credit'}">${isDebit ? '-' : '+'}${t.amount} 🪙</div>
        </div>
      `;
        }).join('');
    } catch (err) { $('wallet-balance').textContent = 'Error'; }
}

function showWithdrawModal() {
    if (!currentUser) { showAuthOverlay('login'); return; }
    $('withdraw-modal').classList.remove('hidden');
}
async function submitWithdrawal() {
    const amount = parseInt($('withdraw-amount').value);
    if (!amount || amount < 100) { showError('withdraw-msg', 'Minimum 100 coins'); return; }
    try {
        await apiReq('POST', '/api/wallet/withdraw', { amount });
        closeModal('withdraw-modal');

        // Sync the local current user profile
        if (currentUser) {
            currentUser.coin_balance -= amount;
            localStorage.setItem('tl_user', JSON.stringify(currentUser));
        }

        loadWallet(); // Refresh UI
        alert("Withdrawal request submitted! 100 coins have been deducted.");
    } catch (err) { showError('withdraw-msg', err.message); }
}

async function buyCoins(amount) {
    if (!currentUser) { showAuthOverlay('login'); return; }
    if (!confirm(`Confirm purchase of ${amount} coins?`)) return;

    try {
        await apiReq('POST', '/api/wallet/buy', { coins: amount });

        // Update local session
        if (currentUser) {
            currentUser.coin_balance += amount;
            localStorage.setItem('tl_user', JSON.stringify(currentUser));
        }

        loadWallet(); // Refresh UI
        alert(`Successfully added ${amount} coins to your wallet! 🪙`);
    } catch (err) {
        alert("Purchase failed: " + err.message);
    }
}

// ─── CHAT ────────────────────────────────────────────────────────────
async function renderChatList() {
    if (!currentUser) {
        $('chat-list').innerHTML = '<div class="profile-guest"><span class="empty-icon">💬</span><p>Login to chat with others</p></div>';
        return;
    }
    try {
        const convos = await apiReq('GET', '/api/messages');
        const list = $('chat-list');
        if (!convos.length) {
            list.innerHTML = '<div class="empty-state"><span class="empty-icon">💬</span><p>No messages yet</p></div>';
            return;
        }
        list.innerHTML = convos.map(c => {
            const initials = c.partner_name ? c.partner_name.charAt(0).toUpperCase() : '?';
            const partnerAvatarUrl = toAssetUrl(c.partner_avatar);
            const avatarStyle = partnerAvatarUrl ? `background-image:url(${partnerAvatarUrl}); background-size:cover; background-position:center;` : '';
            return `
      <div class="chat-list-item glass" onclick="openChatThread(${c.partner_id}, '${c.partner_name}', '${c.partner_avatar || ''}')" style="display:flex;align-items:center;padding:12px;border-radius:12px;gap:12px;cursor:pointer">
         <div class="profile-avatar-lg" style="width:48px;height:48px;font-size:1.2rem;background:linear-gradient(135deg,#c084fc,#818cf8);${avatarStyle}">${partnerAvatarUrl ? '' : initials}</div>
         <div style="flex:1">
           <div style="font-weight:600;margin-bottom:4px;color:var(--text)">${c.partner_name}</div>
           <div style="color:var(--text);opacity:0.7;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">${c.last_message}</div>
         </div>
         <div style="font-size:0.75rem;color:var(--text);opacity:0.5">${formatTime(c.time)}</div>
         ${!c.is_read && c.partner_id !== currentUser.id ? '<div style="width:8px;height:8px;background:var(--accent);border-radius:50%"></div>' : ''}
      </div>
    `;
        }).join('');
    } catch (err) {
        console.error(err);
    }
}

async function openChatThread(partnerId, partnerName, partnerAvatar = '') {
    chatPartnerId = partnerId;
    $('chat-thread-partner-name').textContent = partnerName;
    setAvatar($('chat-thread-partner-avatar'), partnerAvatar, partnerName);
    $('chat-thread-messages').innerHTML = '<div class="feed-loading">📡 Loading messages...</div>';
    navigateTo('chat-thread');

    try {
        const messages = await apiReq('GET', `/api/messages/${partnerId}`);
        renderThreadMessages(messages);
    } catch (err) {
        console.error(err);
    }
}

function renderThreadMessages(messages) {
    const box = $('chat-thread-messages');
    box.innerHTML = messages.map(m => {
        const isMe = m.sender_id === currentUser.id;
        return `
      <div style="align-self: ${isMe ? 'flex-end' : 'flex-start'}; background: ${isMe ? 'var(--accent)' : 'var(--bg-card)'}; padding: 10px 14px; border-radius: 18px; border-bottom-${isMe ? 'right' : 'left'}-radius: 4px; max-width: 80%; border: 1px solid var(--glass-border)">
        <div style="font-size: 0.9rem">${m.message}</div>
        <div style="font-size: 0.65rem; opacity: 0.5; margin-top: 4px; text-align: right">${formatTime(m.created_at)}</div>
      </div>
    `;
    }).join('');
    box.scrollTop = box.scrollHeight;
}

async function sendDirectMessage() {
    const input = $('chat-thread-input');
    const msg = input.value.trim();
    if (!msg || !chatPartnerId) return;

    try {
        // 1. Save to Database via API
        const savedMsg = await apiReq('POST', '/api/messages', {
            receiver_id: chatPartnerId,
            message: msg
        });

        // 2. Broadcast via Supabase Realtime for instant UI update on receiver side
        socket?.send({
            type: 'broadcast',
            event: 'direct-message',
            payload: savedMsg
        });

        input.value = '';
        // Note: We don't call handleIncomingDirectMessage manually here because 
        // the broadcast will come back to us (self: true) and handle it.
    } catch (err) {
        console.error('Failed to send direct message:', err);
        alert('Could not send message. Please try again.');
    }
}

function handleIncomingDirectMessage(data) {
    // If we are currently looking at this thread, append it
    if (chatPartnerId === data.sender_id || chatPartnerId === data.receiver_id) {
        const box = $('chat-thread-messages');
        const isMe = data.sender_id === currentUser.id;
        const msgHtml = `
      <div style="align-self: ${isMe ? 'flex-end' : 'flex-start'}; background: ${isMe ? 'var(--accent)' : 'var(--bg-card)'}; padding: 10px 14px; border-radius: 18px; border-bottom-${isMe ? 'right' : 'left'}-radius: 4px; max-width: 80%; border: 1px solid var(--glass-border)">
        <div style="font-size: 0.9rem">${data.message}</div>
        <div style="font-size: 0.65rem; opacity: 0.5; margin-top: 4px; text-align: right">${formatTime(data.created_at)}</div>
      </div>
    `;
        box.insertAdjacentHTML('beforeend', msgHtml);
        box.scrollTop = box.scrollHeight;
    }

    // Always refresh the chat list if we are on that screen
    if (currentScreen === 'chat') {
        renderChatList();
    }
}

function formatTime(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── PROFILE ───────────────────────────────────────────────────────────
async function renderProfile() {
    const guest = $('profile-guest-msg');
    const user = $('profile-user');
    if (!guest || !user) return;
    if (!currentUser) {
        guest.classList.remove('hidden');
        user.classList.add('hidden');
    } else {
        guest.classList.add('hidden');
        user.classList.remove('hidden');

        try {
            // Fetch detailed profile data
            const data = await apiReq('GET', `/api/users/profile/${currentUser.id}`);

            $('profile-username').textContent = data.username;
            $('profile-email').textContent = currentUser.email;
            $('profile-bio').textContent = data.bio || '';
            $('profile-followers').textContent = (data.followers_count || 0).toLocaleString();
            $('profile-followers').parentElement.onclick = () => openFollowList('followers', data.id);

            $('profile-following').textContent = (data.following_count || 0).toLocaleString();
            $('profile-following').parentElement.onclick = () => openFollowList('following', data.id);
            $('profile-wallet').textContent = (data.coin_balance || 0).toLocaleString();
            $('profile-earned').textContent = (data.earned_coins || 0).toLocaleString();

            setAvatar($('profile-avatar-el'), data.avatar, data.username);
        } catch (e) {
            console.error("Profile fetch error", e);
        }
    }
}

function openProfileEditor() {
    if (!currentUser) return;
    $('edit-username').value = currentUser.username || '';
    $('edit-bio').value = currentUser.bio || '';
    $('profile-modal').classList.remove('hidden');
    setAvatar($('edit-avatar-preview'), currentUser.avatar, currentUser.username);
}

function previewAvatar(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const preview = $('edit-avatar-preview');
            preview.style.backgroundImage = `url(${e.target.result})`;
            preview.textContent = '';
        };
        reader.readAsDataURL(input.files[0]);
    }
}

async function saveProfile() {
    const username = $('edit-username').value.trim();
    const bio = $('edit-bio').value.trim();
    const avatarFile = $('avatar-input').files[0];

    try {
        // 1. Update basic info
        await apiReq('PUT', '/api/users/profile', { username, bio });

        // 2. Update avatar if a new one was selected
        if (avatarFile) {
            const formData = new FormData();
            formData.append('avatar', avatarFile);

            const res = await fetch(`${API}/api/users/profile/avatar`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message);
            currentUser.avatar = data.avatar;

            // If user is currently hosting, update HUD avatar
            if (isHost) {
                setAvatar($('hud-host-avatar'), currentUser.avatar, currentUser.username);
            }
        }

        // Update local object
        currentUser.username = username;
        currentUser.bio = bio;
        localStorage.setItem('tl_user', JSON.stringify(currentUser));

        closeModal('profile-modal');
        renderProfile();
        renderTopBar();
    } catch (err) {
        alert("Failed to save: " + err.message);
    }
}

let viewProfileUserId = null;

async function viewUserProfile(userId) {
    if (currentUser && userId === currentUser.id) {
        navigateTo('profile');
        return;
    }

    viewProfileUserId = userId;
    navigateTo('view-profile');

    // Reset view
    $('v-profile-username').textContent = 'Loading...';
    $('v-profile-bio').textContent = '';
    $('v-profile-followers').textContent = '0';
    $('v-profile-following').textContent = '0';
    $('v-profile-coins').textContent = '0';
    $('v-follow-btn').classList.add('hidden');

    try {
        const data = await apiReq('GET', `/api/users/profile/${userId}`);

        $('v-profile-username').textContent = data.username;
        $('v-profile-bio').textContent = data.bio || 'No bio provided.';
        $('v-profile-followers').textContent = (data.followers_count || 0).toLocaleString();
        $('v-profile-followers').parentElement.onclick = () => openFollowList('followers', data.id);

        $('v-profile-following').textContent = (data.following_count || 0).toLocaleString();
        $('v-profile-following').parentElement.onclick = () => openFollowList('following', data.id);
        $('v-profile-coins').textContent = (data.earned_coins || 0).toLocaleString();

        setAvatar($('v-profile-avatar'), data.avatar, data.username);

        // Setup message button
        $('v-message-btn').onclick = () => openChatThread(data.id, data.username);

        // Check follow status
        if (currentUser) {
            const { isFollowing } = await apiReq('GET', `/api/users/follow-status/${userId}`);
            const btn = $('v-follow-btn');
            if (btn) {
                btn.classList.remove('hidden');
                btn.classList.toggle('following', isFollowing);
                btn.textContent = isFollowing ? 'Following' : '+ Follow';
            }

            // NEW: Show Invite button if I am the Host
            const inviteBtn = $('v-invite-btn');
            if (inviteBtn) {
                if (isHost && currentStream && userId !== currentUser.id) {
                    inviteBtn.classList.remove('hidden');
                } else {
                    inviteBtn.classList.add('hidden');
                }
            }
        } else {
            const fBtn = $('v-follow-btn');
            if (fBtn) {
                fBtn.classList.remove('hidden');
                fBtn.textContent = '+ Follow';
            }
            const iBtn = $('v-invite-btn');
            if (iBtn) iBtn.classList.add('hidden');
        }
    } catch (e) {
        console.error("View profile error", e);
    }
}

async function toggleFollowProfile() {
    if (!currentUser) { showAuthOverlay('login'); return; }
    if (!viewProfileUserId) return;

    const btn = $('v-follow-btn');
    const isFollowing = btn.classList.contains('following');
    const method = isFollowing ? 'DELETE' : 'POST';

    try {
        await apiReq(method, `/api/users/follow/${viewProfileUserId}`);
        // Refresh view
        viewUserProfile(viewProfileUserId);
    } catch (err) {
        console.error("Follow error:", err);
    }
}

// ─── FOLLOW LIST ────────────────────────────────────────────────────────
let followListType = 'followers';
let followListUserId = null;

async function openFollowList(type, userId) {
    followListType = type;
    followListUserId = userId;
    navigateTo('follow-list');

    $('follow-list-title').textContent = type === 'followers' ? 'Followers' : 'Following';
    $('follow-list-content').innerHTML = '<div class="feed-loading">📡 Loading...</div>';

    try {
        const users = await apiReq('GET', `/api/users/${userId}/${type}`);
        renderFollowList(users);
    } catch (e) {
        $('follow-list-content').innerHTML = '<div class="feed-loading"><p>Failed to load.</p></div>';
    }
}

function renderFollowList(users) {
    const container = $('follow-list-content');
    if (!users.length) {
        container.innerHTML = `<div class="feed-loading"><p>No ${followListType} yet.</p></div>`;
        return;
    }

    container.innerHTML = users.map(u => {
        const initials = u.username.charAt(0).toUpperCase();
        const avatarUrl = toAssetUrl(u.avatar);
        const avatarStyle = avatarUrl ? `background-image:url(${avatarUrl}); background-size:cover; background-position:center;` : '';

        return `
            <div class="glass" style="display:flex; align-items:center; gap:12px; padding:15px; border-radius:16px; cursor:pointer; margin-bottom:10px;" onclick="viewUserProfile(${u.id})">
                <div class="user-avatar-sm" style="width:48px; height:48px; border:2px solid var(--glass-border); background: linear-gradient(135deg, var(--accent), var(--accent2)); ${avatarStyle}">${avatarUrl ? '' : initials}</div>
                <div style="flex:1">
                    <div style="font-weight:700; font-size:1.05rem">${u.username}</div>
                    <div style="font-size:0.85rem; color:rgba(255,255,255,0.6)">View Profile</div>
                </div>
                <div style="color:var(--accent); font-size:1.2rem">→</div>
            </div>
        `;
    }).join('');
}

function goBackFromFollowList() {
    if (viewProfileUserId) {
        navigateTo('view-profile');
        viewUserProfile(viewProfileUserId);
    } else {
        navigateTo('profile');
    }
}

function handleTrackMuteChange(pub, part, isMuted) {
    const identity = part.identity;
    const wrapper = $(`video-wrapper-${identity}`);

    if (pub.kind === 'video') {
        const video = wrapper ? wrapper.querySelector('video') : null;
        if (isMuted) {
            if (video) video.classList.add('hidden');
        } else {
            if (video) video.classList.remove('hidden');
        }
    } else if (pub.kind === 'audio') {
        const audioId = `audio-track-${part.identity}`;
        const audioEl = $(audioId);
        if (audioEl) {
            // If the host muted their mic, we mute the local playback element
            // (LiveKit usually stops the stream, but this ensures UI/state consistency)
            audioEl.muted = isMuted;
        }
    }
}

// ─── GUEST STREAMING LOGIC ───────────────────────────────────────────
function inviteToStream() {
    if (!viewProfileUserId || !currentStream || !isHost) return;
    socket?.send({
        type: 'broadcast',
        event: 'guest-invite-received',
        payload: { hostId: currentUser.id, hostName: currentUser.username, roomName: currentStream.livekit_room }
    });
    appendChat('System', `📡 Invitation sent to ${$('v-profile-username').textContent}`, true);
    closeModal('v-profile-modal');
    navigateTo('live');
}

async function acceptGuestInvite(accepted) {
    $('guest-invite-toast').classList.add('hidden');
    if (!pendingGuestInvite) return;

    const { hostId, roomName } = pendingGuestInvite;
    socket?.send({
        type: 'broadcast',
        event: 'guest-invite-reply',
        payload: { userId: currentUser.id, username: currentUser.username, accepted, roomName }
    });

    if (accepted) {
        switchToGuestStreamer(roomName);
    }
    pendingGuestInvite = null;
}

async function switchToGuestStreamer(roomName) {
    try {
        console.log('[Guest] Switching to streamer role...');
        // 1. Get new token with canPublish: true
        const tkData = await apiReq('POST', '/api/livekit/token', {
            room: roomName,
            identity: currentUser.username,
            canPublish: true
        });

        isGuestStreamer = true;

        // 2. Reconnect to LiveKit as Guest Streamer
        await connectToLiveKit(tkData.token, roomName);

        appendChat('System', '🎥 You are now live as a guest!', true);
    } catch (err) {
        alert('Failed to join as guest: ' + err.message);
        isGuestStreamer = false;
    }
}

function stopGuestStream() {
    if (!isGuestStreamer) return;
    isGuestStreamer = false;
    window.roomChannel?.send({
        type: 'broadcast',
        event: 'guest-left',
        payload: { userId: currentUser.id }
    });

    // Re-join as viewer (no publish)
    if (currentStream) {
        enterLiveScreen(currentStream).catch((err) => {
            console.error('Failed to switch back to viewer:', err);
        });
    }
}

function kickGuest(userId) {
    if (!isHost || !currentStream) return;
    socket?.send({
        type: 'broadcast',
        event: 'guest-kicked',
        payload: { roomName: currentStream.livekit_room }
    });
    // Also notify the room
    window.roomChannel?.send({
        type: 'broadcast',
        event: 'guest-left',
        payload: { userId }
    });
}

// ─── HOST CONTROLS ────────────────────────────────────────────────────
async function toggleMic() {
    if (!livekitRoom || !shouldPublishLocalTracks()) return;

    const connectionState = String(livekitRoom.state || '').toLowerCase();
    const isConnected =
        connectionState === 'connected' ||
        (typeof LivekitClient !== 'undefined' &&
            livekitRoom.state === LivekitClient.ConnectionState?.Connected);
    if (!isConnected) {
        alert('Still connecting to the stream engine... Please wait a second.');
        return;
    }

    const audioPub = Array.from(livekitRoom.localParticipant.audioTrackPublications.values())[0];
    const mediaTrackEnabled = mediaStream?.getAudioTracks?.()[0]?.enabled;
    const enabled = audioPub
        ? !audioPub.isMuted
        : (typeof mediaTrackEnabled === 'boolean'
            ? mediaTrackEnabled
            : !!livekitRoom.localParticipant.isMicrophoneEnabled);
    const btn = $('hud-mic-btn');
    if (!btn) return;
    btn.disabled = true; // Prevent double-clicks

    try {
        const targetEnabled = !enabled;
        // Keep publication stable; only toggle source + track mute state.
        if (mediaStream) {
            mediaStream.getAudioTracks().forEach((t) => { t.enabled = targetEnabled; });
        }
        await livekitRoom.localParticipant.setMicrophoneEnabled(targetEnabled);
        const pubs = Array.from(livekitRoom.localParticipant.audioTrackPublications.values());
        for (const pub of pubs) {
            const track = pub?.track;
            if (!track) continue;
            if (track.mediaStreamTrack) track.mediaStreamTrack.enabled = targetEnabled;
            if (targetEnabled) {
                if (typeof track.unmute === 'function') await track.unmute();
            } else if (typeof track.mute === 'function') {
                await track.mute();
            }
        }

        const verifyPub = Array.from(livekitRoom.localParticipant.audioTrackPublications.values())[0];
        const verifyLocal = mediaStream?.getAudioTracks?.()[0]?.enabled;
        const isActuallyEnabled = verifyPub
            ? !verifyPub.isMuted
            : (typeof verifyLocal === 'boolean' ? verifyLocal : targetEnabled);
        if (isActuallyEnabled !== targetEnabled) {
            throw new Error('Microphone state did not update on published track');
        }
        await syncHostControlButtons();
    } catch (e) {
        console.error('Failed to toggle mic:', e);
        const msg = String(e?.message || '');
        // Error-specific feedback
        if (msg.includes('timeout')) {
            alert('Mic toggle timed out. The connection might be unstable.');
        } else if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('denied')) {
            alert('Microphone permission is blocked. Please allow mic access in your browser.');
        } else {
            alert('Could not toggle microphone. Please try again.');
        }
    } finally {
        btn.disabled = false;
    }
}

async function toggleCam() {
    if (!livekitRoom || !shouldPublishLocalTracks()) return;

    if (livekitRoom.state !== 'connected') {
        alert('Still connecting to the stream engine... Please wait a second.');
        return;
    }

    const enabled = !!livekitRoom.localParticipant.isCameraEnabled;
    const btn = $('hud-cam-btn');
    btn.disabled = true;

    try {
        await livekitRoom.localParticipant.setCameraEnabled(!enabled);
        await syncHostControlButtons();
    } catch (e) {
        console.error('Failed to toggle camera:', e);
        if (e.message.includes('timeout')) {
            alert('Camera toggle timed out. The connection might be unstable.');
        }
    } finally {
        btn.disabled = false;
    }
}

// ─── VIEW VIEW CONTROLS (Local Playback) ──────────────────────────────
function toggleViewerAudio() {
    if (!currentStream) return;
    const audioId = `audio-track-${currentStream.username}`;
    const audioEl = $(audioId);
    const btn = $('viewer-mic-btn');
    if (!audioEl || !btn) return;

    const isMuted = audioEl.muted;
    audioEl.muted = !isMuted;

    if (audioEl.muted) {
        btn.classList.add('muted');
        btn.textContent = '🔇';
        btn.title = 'Unmute Audio';
    } else {
        btn.classList.remove('muted');
        btn.textContent = '🔊';
        btn.title = 'Mute Audio';
    }
}

function toggleViewerVideo() {
    if (!currentStream) return;
    const videoId = `video-${currentStream.username}`;
    const videoEl = $(videoId);
    const btn = $('viewer-cam-btn');
    if (!videoEl || !btn) return;

    const isHidden = videoEl.style.display === 'none';

    if (isHidden) {
        videoEl.style.display = 'block';
        btn.classList.remove('muted');
        btn.textContent = '👁️';
        btn.title = 'Hide Video';
    } else {
        videoEl.style.display = 'none';
        btn.classList.add('muted');
        btn.textContent = '🚫';
        btn.title = 'Show Video';
    }
}

// ─── PRIVATE/GROUP JOIN REQUEST ────────────────────────────────────────
async function showJoinRequestModal(stream) {
    $('joinreq-status').textContent = 'Sending request...';
    $('joinreq-modal').classList.remove('hidden');
    initSocket();
    joinRoom(stream.livekit_room);
    try {
        const reqData = await apiReq('POST', `/api/streams/${stream.id}/request`, {});
        $('joinreq-status').textContent = 'Waiting for host...';
        window.roomChannel?.send({
            type: 'broadcast',
            event: 'join-request-received',
            payload: {
                userId: currentUser.id,
                username: currentUser.username,
                avatar: currentUser.avatar,
                streamId: stream.id,
                requestId: reqData?.requestId || null
            }
        });
    } catch (err) {
        $('joinreq-status').textContent = `❌ ${err.message || 'Failed to send request.'}`;
    }
}

function showJoinRequestToast(userId, username, streamId, requestId = null) {
    pendingJoinRequest = { userId, streamId, requestId };
    $('join-req-username').textContent = username;
    $('join-request-toast').classList.remove('hidden');
    setTimeout(() => $('join-request-toast').classList.add('hidden'), 15000);
}

async function respondToJoinRequest(approved) {
    $('join-request-toast').classList.add('hidden');
    if (!pendingJoinRequest || !currentStream) return;
    const { userId, requestId } = pendingJoinRequest;
    const status = approved ? 'approved' : 'rejected';

    if (requestId) {
        try {
            await apiReq('PUT', `/api/streams/requests/${requestId}`, { status });
        } catch (err) {
            alert(`Failed to ${status} request: ${err.message}`);
            return;
        }
    }
    socket?.send({
        type: 'broadcast',
        event: 'join-response-' + userId,
        payload: { approved, roomName: currentStream?.livekit_room }
    });
    pendingJoinRequest = null;
}

// ─── MODAL HELPERS ─────────────────────────────────────────────────────
function closeModal(id) { $(id)?.classList.add('hidden'); }

// ─── HELPERS ───────────────────────────────────────────────────────────
function setAvatar(el, avatarUrl, username) {
    if (!el) return;
    const normalizedAvatar = toAssetUrl(avatarUrl);
    if (normalizedAvatar) {
        el.style.backgroundImage = `url(${normalizedAvatar})`;
        el.textContent = '';
        el.classList.add('has-img');
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
    } else {
        el.style.backgroundImage = 'none';
        el.textContent = username ? username.charAt(0).toUpperCase() : '?';
        el.classList.remove('has-img');
    }
}

function closeModal(id) { $(id)?.classList.add('hidden'); }

// ─── INIT ──────────────────────────────────────────────────────────────
(function init() {
    renderTopBar();
    initSocket();
    initSearch();
    loadStreams();
    document.addEventListener('click', (event) => {
        const panel = $('gift-panel');
        if (!panel || panel.classList.contains('hidden')) return;
        const target = event.target;
        const giftBtn = target?.closest?.('.live-actions-right .action-btn[title="Gift"]');
        if (giftBtn) return;
        if (!panel.contains(target)) {
            closeGiftPanel();
        }
    });

    // Pre-fetch config to speed up connections
    apiReq('GET', '/api/config').then(data => {
        cachedLivekitUrl = normalizeLivekitUrl(data.livekitUrl);
    }).catch(() => { });

    // If no user, show auth on first load after brief delay
    if (!currentUser) {
        setTimeout(() => {
            if (!currentUser) showAuthOverlay('login');
        }, 1000);
    }
})();

window.addEventListener('error', (event) => {
    console.error('[App Runtime Error]', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('[App Unhandled Promise Rejection]', event.reason);
});
