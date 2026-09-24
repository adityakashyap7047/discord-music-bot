/* NOTIXMIX dashboard + landing logic */

function $(id) { return document.getElementById(id); }

function toast(msg, isErr) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = "toast"; }, 3200);
}

function fmtUptime(ms) {
  if (ms == null) return "--";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m " + (s % 60) + "s";
}

function fmtBytes(b) {
  if (b == null) return "--";
  if (b > 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (b > 1048576) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1024).toFixed(0) + " KB";
}

function fmtNum(n) {
  if (n == null) return "--";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

/* Boot screen */
window.addEventListener("load", () => {
  const boot = $("boot");
  if (boot) setTimeout(() => boot.classList.add("hide"), 900);
});

/* Landing stats */
async function loadLandingStats() {
  try {
    const r = await fetch("/api/status");
    const s = await r.json();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("s-guilds", fmtNum(s.guilds));
    set("s-users", fmtNum(s.users));
    set("s-latency", s.latency != null ? s.latency + "ms" : "--");
    set("s-uptime", fmtUptime(s.uptime));
    set("l-latency", s.latency != null ? s.latency + "ms" : "--");
    set("l-uptime", fmtUptime(s.uptime));
    set("l-mem", fmtBytes(s.memory && s.memory.rss));
    set("l-guilds", fmtNum(s.guilds));
  } catch (e) { /* ignore */ }
}

if ($("stats") || $("l-latency")) {
  loadLandingStats();
  setInterval(loadLandingStats, 15000);
}

/* Dashboard */
let currentUser = null;
let selectedGuild = null;
let pollTimer = null;

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
  if (r.status === 401) throw new Error("unauthorized");
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

async function initDashboard() {
  const loginView = $("login-view");
  const dashView = $("dash-view");
  const userSlot = $("user-slot");
  if (!loginView || !dashView) return; // not on dashboard page

  let me;
  try {
    me = await api("/api/me");
  } catch (e) {
    me = { authenticated: false };
  }

  if (!me.authenticated) {
    loginView.style.display = "block";
    dashView.style.display = "none";
    if (userSlot) userSlot.innerHTML = '<a href="/auth/login?return=/dashboard" class="btn btn-primary btn-sm">Login</a>';
    return;
  }

  currentUser = me.user;
  loginView.style.display = "none";
  dashView.style.display = "grid";
  if (userSlot) {
    userSlot.innerHTML =
      '<span class="user-bar"><img src="' + escapeHtml(currentUser.avatar) + '" alt="" /> <span>' +
      escapeHtml(currentUser.globalName) + '</span></span> ' +
      '<a href="/auth/logout" class="btn btn-ghost btn-sm">Logout</a>';
  }

  await loadDashboardStatus();
  await loadServers();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await loadDashboardStatus();
    if (selectedGuild) await loadQueue(selectedGuild);
  }, 5000);
}

async function loadDashboardStatus() {
  try {
    const s = await api("/api/status");
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("d-latency", s.latency != null ? s.latency + "ms" : "--");
    set("d-guilds", fmtNum(s.guilds));
    set("d-users", fmtNum(s.users));
    set("d-uptime", fmtUptime(s.uptime));
  } catch (e) { /* ignore */ }
}

async function loadServers() {
  const list = $("server-list");
  if (!list) return;
  try {
    const data = await api("/api/servers");
    const servers = data.servers || [];
    if (servers.length === 0) {
      list.innerHTML = '<div class="empty">No shared servers where you have manage permissions.<br /><a href="https://discord.com/api/oauth2/authorize?client_id=1552647926780534874&permissions=3146240&scope=bot%20applications.commands" style="color:var(--accent2);">Add the bot →</a></div>';
      return;
    }
    list.innerHTML = servers.map((s) => {
      const icon = s.icon
        ? '<img src="' + escapeHtml(s.icon) + '" alt="" />'
        : '<div class="fallback">' + escapeHtml(s.name.charAt(0).toUpperCase()) + "</div>";
      const badge = s.playing ? '<span class="badge"></span>' : '<span class="badge off"></span>';
      return (
        '<div class="server-item" data-id="' + escapeHtml(s.id) + '">' +
        icon +
        '<span class="sname">' + escapeHtml(s.name) + "</span>" +
        badge +
        "</div>"
      );
    }).join("");
    list.querySelectorAll(".server-item").forEach((el) => {
      el.addEventListener("click", () => selectServer(el.dataset.id, el));
    });
    if (selectedGuild && !servers.some((s) => s.id === selectedGuild)) {
      selectedGuild = null;
    }
    if (!selectedGuild && servers.length > 0) {
      const first = list.querySelector(".server-item");
      if (first) selectServer(first.dataset.id, first);
    } else if (selectedGuild) {
      const cur = list.querySelector('[data-id="' + selectedGuild + '"]');
      if (cur) cur.classList.add("active");
    }
  } catch (e) {
    list.innerHTML = '<div class="empty">Failed to load servers.</div>';
  }
}

function selectServer(id, el) {
  selectedGuild = id;
  document.querySelectorAll(".server-item").forEach((n) => n.classList.remove("active"));
  if (el) el.classList.add("active");
  loadQueue(id);
}

async function loadQueue(guildId) {
  try {
    const data = await api("/api/queue/" + guildId);
    renderNowPlaying(data);
    renderQueue(data);
    renderControls(data);
  } catch (e) {
    const np = $("now-playing");
    if (np) np.innerHTML = '<div class="empty">Failed to load queue.</div>';
  }
}

function renderNowPlaying(data) {
  const el = $("now-playing");
  if (!el) return;
  if (!data.nowPlaying) {
    el.innerHTML = '<div class="empty">Nothing is playing in this server.</div>';
    return;
  }
  const state = data.playerState || "unknown";
  const stateLabel = state === "playing" ? "▶ PLAYING" : state === "paused" ? "⏸ PAUSED" : state.toUpperCase();
  el.innerHTML =
    '<div class="now-playing">' +
    '<div class="np-icon">🎵</div>' +
    '<div class="np-info">' +
    '<div class="np-title">' + escapeHtml(data.nowPlaying.title) + "</div>" +
    '<div class="np-meta">Volume ' + data.volume + "/10" +
    (data.loop ? " · 🔁 Loop" : "") +
    (data.voiceChannel ? " · 🎙 " + escapeHtml(data.voiceChannel.name) : "") +
    "</div>" +
    '<div class="np-state">' + stateLabel + "</div>" +
    "</div>" +
    "</div>";
}

function renderQueue(data) {
  const el = $("queue-view");
  const cnt = $("q-count");
  if (!el) return;
  const q = data.queue || [];
  if (cnt) cnt.textContent = q.length ? "(" + q.length + ")" : "";
  if (q.length === 0) {
    el.innerHTML = '<div class="empty">Queue is empty.</div>';
    return;
  }
  el.innerHTML = '<div class="queue-list">' + q.map((s, i) =>
    '<div class="queue-item">' +
    '<span class="idx">' + (i + 1) + "</span>" +
    '<span class="qt">' + escapeHtml(s.title) + "</span>" +
    '<button class="rm" data-idx="' + i + '" title="Remove">✕</button>' +
    "</div>"
  ).join("") + "</div>";
  el.querySelectorAll(".rm").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!selectedGuild) return;
      try {
        await api("/api/control/" + selectedGuild + "/remove", {
          method: "POST",
          body: JSON.stringify({ index: parseInt(btn.dataset.idx, 10) }),
        });
        toast("Removed from queue");
        loadQueue(selectedGuild);
        loadServers();
      } catch (e) { toast(e.message, true); }
    });
  });
}

function renderControls(data) {
  const controls = $("controls");
  const volRow = $("vol-row");
  if (!controls) return;
  const has = !!(data.nowPlaying || (data.queue && data.queue.length));
  controls.style.display = has ? "flex" : "none";
  if (volRow) volRow.style.display = has ? "flex" : "none";
  const slider = $("vol-slider");
  const val = $("vol-val");
  if (slider) slider.value = data.volume;
  if (val) val.textContent = data.volume;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function ctrl(action, body) {
  if (!selectedGuild) { toast("Select a server first", true); return; }
  try {
    await api("/api/control/" + selectedGuild + "/" + action, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    toast(action.charAt(0).toUpperCase() + action.slice(1) + " ✓");
    loadQueue(selectedGuild);
    loadServers();
  } catch (e) { toast(e.message, true); }
}

document.addEventListener("DOMContentLoaded", () => {
  initDashboard();

  const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  bind("btn-play", () => ctrl("play"));
  bind("btn-pause", () => ctrl("pause"));
  bind("btn-skip", () => ctrl("skip"));
  bind("btn-stop", () => ctrl("stop"));
  bind("btn-loop", () => ctrl("loop"));
  bind("btn-clear", () => ctrl("clear"));

  const slider = $("vol-slider");
  if (slider) {
    slider.addEventListener("input", () => { const v = $("vol-val"); if (v) v.textContent = slider.value; });
    slider.addEventListener("change", () => ctrl("volume", { volume: parseInt(slider.value, 10) }));
  }

  const quickBtn = $("quick-btn");
  const quickInput = $("quick-input");
  if (quickBtn && quickInput) {
    const doPlay = async () => {
      const q = quickInput.value.trim();
      if (!q) { toast("Enter a URL or search", true); return; }
      if (!selectedGuild) { toast("Select a server first", true); return; }
      quickBtn.disabled = true;
      quickBtn.textContent = "...";
      try {
        await api("/api/control/" + selectedGuild + "/add", {
          method: "POST",
          body: JSON.stringify({ query: q }),
        });
        toast("Added to queue ✓");
        quickInput.value = "";
        loadQueue(selectedGuild);
        loadServers();
      } catch (e) {
        if (e.message === "unauthorized") toast("Session expired — please log in again", true);
        else toast(e.message, true);
      }
      quickBtn.disabled = false;
      quickBtn.textContent = "▶ Play";
    };
    quickBtn.addEventListener("click", doPlay);
    quickInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doPlay(); });
  }
});
