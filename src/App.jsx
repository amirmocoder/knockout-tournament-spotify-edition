import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Music2,
  Trophy,
  Link as LinkIcon,
  Sparkles,
  ChevronRight,
  RefreshCw,
  ExternalLink,
  Play,
  Pause,
  Volume2,
  Shield,
  Lock,
} from "lucide-react";

/**
 * Spotify Duel — Dynamic Knockout Tournament (Non power-of-two)
 *
 * ✅ NOT power-of-two bracket
 * ✅ Each round: pair strongest vs weakest; if odd -> MOST popular gets a BYE
 * ✅ Special rule for 3 remaining:
 *    - Most popular auto-advances to Final
 *    - User picks winner of other two -> meets top track in Final
 *
 * ✅ In-app playback using Spotify Web Playback SDK (Premium required)
 * ✅ Tinder-style picking: tap card (cards are selection-only)
 * ✅ Playback controls are OUTSIDE cards (play never selects)
 * ✅ Bracket rounds expand/collapse
 *
 * ✅ NEW:
 * - Save button: persist playlistInput + playlistMeta + tracks + tournament to localStorage
 * - Reset button: clears localStorage + resets app to initial state
 * - Auto-restore on load if saved session exists
 */

// ✅ Put your Spotify Client ID here
const SPOTIFY_CLIENT_ID = "034fbb5f4b5345c18a8abce3db58812a";

// ✅ Redirect must match Spotify dashboard exactly
const REDIRECT_URI = typeof window !== "undefined" ? window.location.origin : "";

// ✅ Scopes for playlists + full playback (Premium required for SDK playback)
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
];

// ------------------------
// Local Save / Restore
// ------------------------
const APP_SAVE_KEY = "spotify_duel_save_v1";

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function saveToLocalStorage(payload) {
  localStorage.setItem(
    APP_SAVE_KEY,
    JSON.stringify({
      ...payload,
      savedAt: Date.now(),
      version: 1,
    })
  );
}

function loadFromLocalStorage() {
  const raw = localStorage.getItem(APP_SAVE_KEY);
  if (!raw) return null;
  return safeJsonParse(raw);
}

function clearLocalStorageSave() {
  localStorage.removeItem(APP_SAVE_KEY);
}

// ------------------------
// Helpers
// ------------------------
const clamp = (n, a, b) => Math.max(a, Math.min(b, Math.min(b, n)));

function parseSpotifyPlaylistId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  const uriMatch = trimmed.match(/^spotify:playlist:([a-zA-Z0-9]+)$/);
  if (uriMatch) return uriMatch[1];
  const urlMatch = trimmed.match(/spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  const idMatch = trimmed.match(/^([a-zA-Z0-9]+)$/);
  return idMatch ? idMatch[1] : null;
}

function base64UrlEncode(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest("SHA-256", data);
}

function randomString(length = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let out = "";
  const rnd = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) out += chars[rnd[i] % chars.length];
  return out;
}

function formatMs(ms) {
  if (!ms && ms !== 0) return "—";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getImage(images, size = "md") {
  if (!images?.length) return null;
  if (size === "sm") return images[images.length - 1]?.url || images[0].url;
  if (size === "lg") return images[0]?.url || images[images.length - 1].url;
  return images[Math.floor(images.length / 2)]?.url || images[0].url;
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

function sortByPopularityDesc(list) {
  return [...list].sort((a, b) => (b?.popularity ?? 0) - (a?.popularity ?? 0));
}

/**
 * Build a round from entrants, applying:
 * - if 3 entrants: special rule (top -> final)
 * - else if odd: top gets bye
 * - pairing strongest vs weakest among remaining
 */
function makeRound(entrants) {
  const alive = (entrants || []).filter(Boolean);

  if (alive.length <= 1) {
    return { type: "done", entrants: alive, bye: null, matches: [], winners: [] };
  }

  // Special: 3 remaining
  if (alive.length === 3) {
    const sorted = sortByPopularityDesc(alive);
    return {
      type: "three",
      entrants: sorted,
      top: sorted[0],
      match: { a: sorted[1], b: sorted[2], winner: null },
      final: null,
      winners: [],
    };
  }

  const sorted = sortByPopularityDesc(alive);

  let bye = null;
  let pool = sorted;

  if (sorted.length % 2 === 1) {
    bye = sorted[0];
    pool = sorted.slice(1);
  }

  const matches = [];
  for (let i = 0; i < pool.length / 2; i++) {
    matches.push({
      a: pool[i],
      b: pool[pool.length - 1 - i],
      winner: null,
      id: `m-${pool[i]?.id}-${pool[pool.length - 1 - i]?.id}-${i}`,
    });
  }

  return { type: "normal", entrants: sorted, bye, matches, winners: [] };
}

function deriveCursor(tournament) {
  if (!tournament) return null;
  const r = tournament.rounds[tournament.roundIndex];
  if (!r) return null;

  if (r.type === "three") {
    if (!r.match?.winner) return { round: tournament.roundIndex, special: "three" };
    if (r.final && !r.final.winner) return { round: tournament.roundIndex, special: "final" };
    return null;
  }

  if (r.type === "normal") {
    const idx = r.matches.findIndex((m) => !m.winner && m.a && m.b);
    if (idx !== -1) return { round: tournament.roundIndex, match: idx };
    return null;
  }

  return null;
}

function buildTournament(tracks) {
  const first = makeRound(tracks || []);
  const t = {
    roundIndex: 0,
    rounds: [first],
    cursor: null,
    champion: null,
    history: [],
  };
  t.cursor = deriveCursor(t);
  return fastForwardIfNeeded(t);
}

function fastForwardIfNeeded(tournament) {
  const t = deepClone(tournament);

  while (!t.champion) {
    t.cursor = deriveCursor(t);
    const round = t.rounds[t.roundIndex];
    if (!round) break;

    if (t.cursor) break;

    if (round.type === "normal") {
      const allDone = round.matches.every((m) => !!m.winner);
      if (!allDone) break;

      const winners = round.matches.map((m) => m.winner).filter(Boolean);
      if (round.bye) winners.push(round.bye);

      if (winners.length === 1) {
        t.champion = winners[0];
        break;
      }

      const next = makeRound(winners);
      t.roundIndex += 1;
      t.rounds.push(next);
      continue;
    }

    if (round.type === "three") {
      break;
    }

    if (round.type === "done") {
      if (round.entrants?.length === 1) t.champion = round.entrants[0];
      break;
    }

    break;
  }

  t.cursor = deriveCursor(t);
  return t;
}

function applyPick(tournament, pickedSide /* 'a'|'b' */) {
  const t = deepClone(tournament);
  const cur = t.cursor;
  if (!cur) return t;

  const round = t.rounds[t.roundIndex];
  if (!round) return t;

  if (cur.special === "three") {
    const m = round.match;
    const winner = pickedSide === "a" ? m.a : m.b;
    if (!winner) return t;

    m.winner = winner;
    t.history.push({ round: t.roundIndex, stage: "three", winnerId: winner.id });

    round.final = { a: round.top, b: winner, winner: null };
    t.cursor = deriveCursor(t);
    return t;
  }

  if (cur.special === "final") {
    const m = round.final;
    const winner = pickedSide === "a" ? m.a : m.b;
    if (!winner) return t;

    m.winner = winner;
    t.history.push({ round: t.roundIndex, stage: "final", winnerId: winner.id });

    t.champion = winner;
    t.cursor = null;
    return t;
  }

  const m = round.matches[cur.match];
  const winner = pickedSide === "a" ? m.a : m.b;
  if (!winner) return t;

  m.winner = winner;
  t.history.push({ round: t.roundIndex, match: cur.match, winnerId: winner.id });

  const allDone = round.matches.every((x) => x.winner);
  if (!allDone) {
    t.cursor = deriveCursor(t);
    return t;
  }

  const winners = round.matches.map((x) => x.winner).filter(Boolean);
  if (round.bye) winners.push(round.bye);

  if (winners.length === 1) {
    t.champion = winners[0];
    t.cursor = null;
    return t;
  }

  const next = makeRound(winners);
  t.roundIndex += 1;
  t.rounds.push(next);
  t.cursor = deriveCursor(t);
  return fastForwardIfNeeded(t);
}

function getTotalDone(tournament) {
  if (!tournament) return { total: 0, done: 0 };

  let total = 0;
  let done = 0;

  for (const r of tournament.rounds) {
    if (!r) continue;
    if (r.type === "normal") {
      total += r.matches.length;
      done += r.matches.filter((m) => !!m.winner).length;
    } else if (r.type === "three") {
      total += 2;
      done += r.match?.winner ? 1 : 0;
      done += r.final?.winner ? 1 : 0;
    }
  }

  return { total, done };
}

function progressLabel(tournament) {
  if (!tournament) return "";
  if (tournament.champion) return "Finished";

  const cur = tournament.cursor;
  const roundNum = tournament.roundIndex + 1;
  const r = tournament.rounds[tournament.roundIndex];
  if (!r) return `Round ${roundNum}`;

  if (!cur) return `Round ${roundNum}`;

  if (cur.special === "three") return `Round ${roundNum} • Qualifier (pick 1 of 2)`;
  if (cur.special === "final") return `Final • Choose your champion`;

  return `Round ${roundNum} • Match ${cur.match + 1}/${r.matches.length}`;
}

// ------------------------
// Spotify API (PKCE)
// ------------------------
const LS_KEYS = {
  token: "sp_token",
  expiry: "sp_expiry",
  refresh: "sp_refresh",
  verifier: "sp_pkce_verifier",
};

function getStoredAccessToken() {
  const tok = localStorage.getItem(LS_KEYS.token);
  const exp = Number(localStorage.getItem(LS_KEYS.expiry) || "0");
  if (!tok) return null;
  if (Date.now() > exp) return null;
  return tok;
}

function storeToken({ access_token, expires_in, refresh_token }) {
  localStorage.setItem(LS_KEYS.token, access_token);
  localStorage.setItem(LS_KEYS.expiry, String(Date.now() + (expires_in - 15) * 1000));
  if (refresh_token) localStorage.setItem(LS_KEYS.refresh, refresh_token);
}

async function spotifyFetch(path, token, init) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify API error ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

async function spotifyNoContent(path, token, init) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify API error ${res.status}: ${text || res.statusText}`);
  }
  return true;
}

async function refreshAccessTokenIfPossible() {
  const refresh_token = localStorage.getItem(LS_KEYS.refresh);
  if (!refresh_token) return null;

  const body = new URLSearchParams();
  body.set("client_id", SPOTIFY_CLIENT_ID);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refresh_token);

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  const data = await res.json();
  storeToken(data);
  return data.access_token;
}

async function startSpotifyLogin() {
  const verifier = randomString(64);
  localStorage.setItem(LS_KEYS.verifier, verifier);
  const challenge = base64UrlEncode(await sha256(verifier));

  const params = new URLSearchParams();
  params.set("client_id", SPOTIFY_CLIENT_ID);
  params.set("response_type", "code");
  params.set("redirect_uri", REDIRECT_URI);
  params.set("code_challenge_method", "S256");
  params.set("code_challenge", challenge);
  params.set("scope", SCOPES.join(" "));
  params.set("state", randomString(16));

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const verifier = localStorage.getItem(LS_KEYS.verifier);
  if (!verifier) throw new Error("Missing PKCE verifier (try login again).");

  const body = new URLSearchParams();
  body.set("client_id", SPOTIFY_CLIENT_ID);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", REDIRECT_URI);
  body.set("code_verifier", verifier);

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${text || res.statusText}`);
  }
  const data = await res.json();
  storeToken(data);
  localStorage.removeItem(LS_KEYS.verifier);
  return data.access_token;
}

async function fetchPlaylistTracks(playlistId, token) {
  const playlist = await spotifyFetch(`/playlists/${playlistId}?fields=name,images,owner(display_name),tracks.total`, token);

  const items = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const page = await spotifyFetch(
      `/playlists/${playlistId}/tracks?fields=items(track(id,uri,name,artists(name),album(images),duration_ms,external_urls,popularity,is_local),is_local),next,offset,limit&limit=${limit}&offset=${offset}`,
      token
    );

    for (const it of page.items || []) {
      const tr = it?.track;
      if (!tr || tr.is_local || it?.is_local) continue;
      if (!tr.id) continue;

      items.push({
        id: tr.id,
        uri: tr.uri || `spotify:track:${tr.id}`,
        name: tr.name,
        artists: (tr.artists || []).map((a) => a.name).join(", "),
        albumImage: getImage(tr.album?.images, "lg"),
        duration_ms: tr.duration_ms,
        popularity: tr.popularity ?? 0,
        external_url: tr.external_urls?.spotify,
      });
    }

    if (!page.next) break;
    offset += limit;
    if (offset > 2000) break;
  }

  const seen = new Set();
  const dedup = [];
  for (const t of items) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    dedup.push(t);
  }

  return { playlist, tracks: dedup };
}

// ------------------------
// Spotify Web Playback SDK
// ------------------------
function loadSpotifySDK() {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("No window"));
    if (window.Spotify) return resolve(true);

    const existing = document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]');
    if (existing) {
      const check = setInterval(() => {
        if (window.Spotify) {
          clearInterval(check);
          resolve(true);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        if (!window.Spotify) reject(new Error("Spotify SDK failed to load."));
      }, 8000);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onload = () => {
      const check = setInterval(() => {
        if (window.Spotify) {
          clearInterval(check);
          resolve(true);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        if (!window.Spotify) reject(new Error("Spotify SDK loaded but Spotify object missing."));
      }, 8000);
    };
    script.onerror = () => reject(new Error("Failed to load Spotify Web Playback SDK."));
    document.body.appendChild(script);
  });
}

// ------------------------
// UI Components
// ------------------------
function Shell({ children }) {
  return (
    <div dir="ltr" className="min-h-dvh text-zinc-100 bg-gradient-to-b from-zinc-950 via-black to-black">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-32 h-[420px] w-[420px] rounded-full bg-white/10 blur-3xl" />
        <div className="absolute top-10 -right-40 h-[520px] w-[520px] rounded-full bg-white/8 blur-3xl" />
        <div className="absolute bottom-[-220px] left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-white/5 blur-3xl" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.06),transparent_30%,transparent_70%,rgba(0,0,0,0.9))]" />
      </div>

      <div className="relative mx-auto max-w-md px-4 pt-6 pb-28 [padding-bottom:calc(env(safe-area-inset-bottom)+7rem)]">
        {children}
      </div>
    </div>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-3xl bg-white/5 ring-1 ring-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.35)] ${className}`}>
      {children}
    </div>
  );
}

function Button({ children, onClick, disabled, variant = "primary", className = "", type = "button" }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-white text-black hover:bg-white/90"
      : variant === "ghost"
      ? "bg-white/5 text-white hover:bg-white/10 ring-1 ring-white/10"
      : variant === "danger"
      ? "bg-rose-500 text-white hover:bg-rose-500/90"
      : "bg-white/10 text-white";
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  );
}

function Pill({ icon: Icon, children }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-white/5 ring-1 ring-white/10 px-3 py-1.5 text-xs text-zinc-200">
      {Icon ? <Icon className="h-4 w-4" /> : null}
      <span className="truncate">{children}</span>
    </div>
  );
}

function GradientTitle({ title, subtitle }) {
  return (
    <div className="mb-5">
      <div className="inline-flex items-center gap-2 rounded-full bg-white/5 ring-1 ring-white/10 px-3 py-1.5 text-xs text-zinc-200">
        <Sparkles className="h-4 w-4" />
        <span>Knockout Tournament</span>
      </div>

      <h1 className="mt-3 text-[26px] leading-[1.15] font-black tracking-tight">
        <span className="bg-gradient-to-l from-white via-white to-zinc-400 bg-clip-text text-transparent">{title}</span>
      </h1>

      {subtitle ? <p className="mt-2 text-sm text-zinc-300/95 leading-relaxed">{subtitle}</p> : null}
    </div>
  );
}

function Input({ value, onChange, placeholder }) {
  return (
    <div className="relative">
      <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400">
        <LinkIcon className="h-4 w-4" />
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-2xl bg-white/5 ring-1 ring-white/10 px-10 py-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-white/30"
      />
    </div>
  );
}

function Meter({ value, label }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-[11px] text-zinc-300">
        <span>{label}</span>
        <span className="tabular-nums">{pct}</span>
      </div>
      <div className="mt-1 h-2 w-full rounded-full bg-white/10">
        <div className="h-2 rounded-full bg-white/70" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Selection-only TrackCard (no playback buttons inside)
function TrackCard({ track, badge, cornerTag, selected, disabled, onSelect }) {
  if (!track) {
    return (
      <div className="rounded-[26px] bg-white/5 ring-1 ring-white/10 p-4">
        <div className="text-sm font-extrabold text-white">Bye</div>
        <div className="mt-2 text-xs text-zinc-400 leading-relaxed">This slot is empty—your opponent advances automatically.</div>
      </div>
    );
  }

  const handleSelect = () => {
    if (disabled) return;
    onSelect?.();
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled ? "true" : "false"}
      onClick={handleSelect}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleSelect();
        }
      }}
      className={[
        "w-full text-left rounded-[26px] overflow-hidden select-none",
        "bg-white/[0.055] ring-1 ring-white/10",
        "transition active:scale-[0.995]",
        disabled ? "opacity-70 cursor-not-allowed" : "cursor-pointer",
        selected ? "ring-2 ring-emerald-400/70" : "",
        "focus:outline-none focus:ring-2 focus:ring-white/30",
      ].join(" ")}
    >
      <div className="relative">
        {track.albumImage ? (
          <img src={track.albumImage} alt="cover" className="h-48 w-full object-cover" />
        ) : (
          <div className="h-48 w-full bg-white/5" />
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-black/10" />
        <div className="absolute inset-0 [background:radial-gradient(900px_circle_at_20%_10%,rgba(255,255,255,0.10),transparent_45%)]" />

        <div className="absolute left-3 top-3">
          <div className="inline-flex items-center gap-2 rounded-full bg-black/45 backdrop-blur ring-1 ring-white/15 px-3 py-1.5 text-[11px]">
            <span className="font-extrabold tracking-wide">{cornerTag}</span>
          </div>
        </div>

        <div className="absolute right-3 top-3">
          <div className="inline-flex items-center gap-2 rounded-full bg-black/45 backdrop-blur ring-1 ring-white/15 px-3 py-1.5 text-[11px]">
            <Music2 className="h-4 w-4" />
            <span className="font-extrabold">{badge}</span>
          </div>
        </div>

        <div className="absolute bottom-4 left-4 right-4">
          <div className="text-[17px] font-black leading-tight line-clamp-2">{track.name}</div>
          <div className="mt-1 text-xs text-zinc-200/90 line-clamp-1">{track.artists}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Pill icon={Volume2}>Popularity: {track.popularity ?? 0}/100</Pill>
            <Pill>⏱ {formatMs(track.duration_ms)}</Pill>
          </div>
        </div>

        <AnimatePresence>
          {selected ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-emerald-500/10">
              <div className="absolute right-4 bottom-4 inline-flex items-center gap-2 rounded-full bg-emerald-500/20 ring-1 ring-emerald-300/30 px-4 py-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-400 text-black font-black">
                  ✓
                </span>
                <span className="text-sm font-extrabold text-emerald-100">Selected</span>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="p-4">
        <Meter value={track.popularity ?? 0} label="Popularity (stream proxy)" />
      </div>
    </div>
  );
}

// Playback controls OUTSIDE the card (no accidental selection)
function TrackControls({ track, canPlay, isPlaying, onTogglePlay }) {
  return (
    <div className="flex gap-2">
      <Button
        variant="ghost"
        className="w-full"
        disabled={!track || !canPlay}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onTogglePlay?.();
        }}
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        {isPlaying ? "Pause" : "Play"}
      </Button>

      {track?.external_url ? (
        <Button
          variant="ghost"
          className="w-[52px]"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(track.external_url, "_blank", "noopener,noreferrer");
          }}
          aria-label="Open in Spotify"
          title="Open in Spotify"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      ) : (
        <div className="w-[52px]" />
      )}
    </div>
  );
}

function BracketMini({ tournament }) {
  const rounds = tournament?.rounds || [];
  const [openRounds, setOpenRounds] = useState(() => new Set());

  function toggleRound(idx) {
    setOpenRounds((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold">Bracket</div>
        <div className="text-xs text-zinc-400">{tournament ? `Round ${tournament.roundIndex + 1}` : ""}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        {rounds.map((r, ri) => {
          const isOpen = openRounds.has(ri);
          const rows = [];

          if (r?.type === "normal") {
            if (r.bye) rows.push({ id: `r${ri}-bye`, a: r.bye, b: null, winner: r.bye });
            for (const m of r.matches) rows.push({ ...m, id: m.id || `r${ri}-${m.a?.id}-${m.b?.id}` });
          } else if (r?.type === "three") {
            rows.push({ id: `r${ri}-top`, a: r.top, b: null, winner: r.top });
            rows.push({ id: `r${ri}-q`, a: r.match?.a, b: r.match?.b, winner: r.match?.winner });
            if (r.final) rows.push({ id: `r${ri}-final`, a: r.final.a, b: r.final.b, winner: r.final.winner });
          } else if (r?.type === "done") {
            if (r.entrants?.[0]) rows.push({ id: `r${ri}-done`, a: r.entrants[0], b: null, winner: r.entrants[0] });
          }

          const shown = isOpen ? rows : rows.slice(0, 3);

          return (
            <div key={ri} className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-zinc-300">Round {ri + 1}</div>

                {rows.length > 3 ? (
                  <button
                    type="button"
                    onClick={() => toggleRound(ri)}
                    className="text-[10px] text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
                  >
                    {isOpen ? "Show less" : `+ ${rows.length - 3} more`}
                  </button>
                ) : null}
              </div>

              <div className="mt-2 space-y-2">
                {shown.map((m) => (
                  <div key={m.id} className="text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-zinc-300">{m.a?.name || "—"}</span>
                      <span className="text-zinc-500">{m.b ? "vs" : "BYE"}</span>
                      <span className="truncate text-zinc-300">{m.b?.name || "—"}</span>
                    </div>
                    {m.winner ? <div className="mt-0.5 text-[10px] text-zinc-500">Winner: {m.winner.name}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function FooterHint() {
  return (
    <div className="mt-6 text-center text-xs text-zinc-500">
      <div className="inline-flex items-center gap-2">
        <Shield className="h-4 w-4" />
        <span>Client-side PKCE • No client secret stored</span>
      </div>
    </div>
  );
}

// ------------------------
// App
// ------------------------
export default function App() {
  const [auth, setAuth] = useState({ status: "idle", token: null, error: null });
  const [playlistInput, setPlaylistInput] = useState("");
  const [loadState, setLoadState] = useState({ status: "idle", error: null });
  const [playlistMeta, setPlaylistMeta] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [tournament, setTournament] = useState(null);

  // Save UI state
  const [saveState, setSaveState] = useState({ status: "idle", error: null, lastSavedAt: null });

  // Tinder-style selection states
  const [selectedSide, setSelectedSide] = useState(null);
  const [isAdvancing, setIsAdvancing] = useState(false);

  // Web Playback SDK
  const playerRef = useRef(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [deviceId, setDeviceId] = useState(null);
  const [playbackError, setPlaybackError] = useState(null);
  const [premiumWarning, setPremiumWarning] = useState(null);
  const [nowPlayingId, setNowPlayingId] = useState(null);
  const [isPaused, setIsPaused] = useState(true);

  // Auto-restore saved session
  useEffect(() => {
    const saved = loadFromLocalStorage();
    if (!saved) return;
    if (!saved.tournament || !saved.tracks || !saved.playlistMeta) return;

    setPlaylistInput(saved.playlistInput || "");
    setPlaylistMeta(saved.playlistMeta || null);
    setTracks(saved.tracks || []);
    setTournament(saved.tournament || null);
    setLoadState({ status: "ready", error: null });

    setSaveState((s) => ({
      ...s,
      status: "restored",
      lastSavedAt: saved.savedAt || null,
      error: null,
    }));
  }, []);

  // OAuth redirect handler
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");

    async function init() {
      try {
        if (SPOTIFY_CLIENT_ID === "YOUR_SPOTIFY_CLIENT_ID") {
          setAuth({ status: "needs_client_id", token: null, error: null });
          return;
        }

        if (error) {
          setAuth({ status: "error", token: null, error });
          return;
        }

        if (code) {
          setAuth({ status: "authing", token: null, error: null });
          const token = await exchangeCodeForToken(code);
          window.history.replaceState({}, document.title, window.location.pathname);
          setAuth({ status: "authed", token, error: null });
          return;
        }

        const stored = getStoredAccessToken();
        if (stored) {
          setAuth({ status: "authed", token: stored, error: null });
          return;
        }

        const refreshed = await refreshAccessTokenIfPossible();
        if (refreshed) {
          setAuth({ status: "authed", token: refreshed, error: null });
          return;
        }

        setAuth({ status: "unauthorized", token: null, error: null });
      } catch (e) {
        setAuth({ status: "error", token: null, error: e?.message || String(e) });
      }
    }

    init();
  }, []);

  // Initialize Web Playback SDK when authed
  useEffect(() => {
    let cancelled = false;

    async function initPlayer() {
      try {
        if (!auth?.token) return;

        setPlaybackError(null);
        setPremiumWarning(null);
        setPlayerReady(false);
        setDeviceId(null);

        await loadSpotifySDK();
        if (cancelled) return;

        if (playerRef.current) {
          try {
            playerRef.current.disconnect();
          } catch {}
          playerRef.current = null;
        }

        const player = new window.Spotify.Player({
          name: "Spotify Duel",
          volume: 0.75,
          getOAuthToken: (cb) => cb(auth.token),
        });

        player.addListener("initialization_error", ({ message }) => setPlaybackError(message));
        player.addListener("authentication_error", ({ message }) => setPlaybackError(message));
        player.addListener("account_error", ({ message }) => {
          setPlaybackError(message);
          setPremiumWarning("In-app playback requires Spotify Premium (Web Playback SDK limitation).");
        });
        player.addListener("playback_error", ({ message }) => setPlaybackError(message));

        player.addListener("ready", async ({ device_id }) => {
          setDeviceId(device_id);
          setPlayerReady(true);

          try {
            await spotifyNoContent(`/me/player`, auth.token, {
              method: "PUT",
              body: JSON.stringify({ device_ids: [device_id], play: false }),
            });
          } catch {}
        });

        player.addListener("not_ready", () => setPlayerReady(false));

        player.addListener("player_state_changed", (state) => {
          if (!state) return;
          const cur = state.track_window?.current_track;
          setNowPlayingId(cur?.id || null);
          setIsPaused(state.paused);
        });

        const connected = await player.connect();
        if (!connected) setPlaybackError("Failed to connect Spotify Player.");
        playerRef.current = player;
      } catch (e) {
        setPlaybackError(e?.message || String(e));
      }
    }

    initPlayer();

    return () => {
      cancelled = true;
    };
  }, [auth?.token]);

  // Clear selection on cursor change
  useEffect(() => {
    setSelectedSide(null);
    setIsAdvancing(false);
  }, [tournament?.roundIndex, tournament?.cursor?.match, tournament?.cursor?.special]);

  const canLoadPlaylist = auth.status === "authed" && !!auth.token;
  const canPlayInsideApp = Boolean(auth.token && playerReady && deviceId);

  async function handleLoadPlaylist() {
    const playlistId = parseSpotifyPlaylistId(playlistInput);
    if (!playlistId) {
      setLoadState({ status: "error", error: "That playlist link/ID doesn’t look valid." });
      return;
    }

    try {
      setLoadState({ status: "loading", error: null });
      const token = auth.token;
      if (!token) throw new Error("Not authenticated");

      const data = await fetchPlaylistTracks(playlistId, token);
      if (!data.tracks.length) throw new Error("No playable tracks found (empty or restricted playlist).");

      setPlaylistMeta(data.playlist);
      setTracks(data.tracks);

      const t = buildTournament(data.tracks);
      setTournament(t);

      setLoadState({ status: "ready", error: null });
    } catch (e) {
      try {
        const newTok = await refreshAccessTokenIfPossible();
        if (newTok) {
          setAuth((s) => ({ ...s, token: newTok, status: "authed" }));

          const playlistId2 = parseSpotifyPlaylistId(playlistInput);
          const data2 = await fetchPlaylistTracks(playlistId2, newTok);
          if (!data2.tracks.length) throw new Error("No playable tracks found (empty or restricted playlist).");

          setPlaylistMeta(data2.playlist);
          setTracks(data2.tracks);

          const t2 = buildTournament(data2.tracks);
          setTournament(t2);

          setLoadState({ status: "ready", error: null });
          return;
        }
      } catch {}

      setLoadState({ status: "error", error: e?.message || String(e) });
    }
  }

  // Determine current stage
  const currentStage = useMemo(() => {
    if (!tournament || tournament.champion) return null;
    const r = tournament.rounds[tournament.roundIndex];
    const cur = tournament.cursor;
    if (!r || !cur) return null;

    if (cur.special === "three") return { kind: "three", a: r.match?.a, b: r.match?.b, top: r.top, round: r };
    if (cur.special === "final") return { kind: "final", a: r.final?.a, b: r.final?.b, top: null, round: r };
    if (typeof cur.match === "number") {
      const m = r.matches[cur.match];
      return { kind: "normal", a: m?.a, b: m?.b, top: r.bye || null, round: r };
    }
    return null;
  }, [tournament]);

  const roundProgress = useMemo(() => getTotalDone(tournament), [tournament]);

  function resetAll() {
    setPlaylistMeta(null);
    setTracks([]);
    setTournament(null);
    setLoadState({ status: "idle", error: null });
    setSelectedSide(null);
    setIsAdvancing(false);
  }

  function handleSave() {
    try {
      if (!tournament || !tracks?.length) {
        setSaveState({ status: "error", error: "Nothing to save yet.", lastSavedAt: null });
        return;
      }
      saveToLocalStorage({ playlistInput, playlistMeta, tracks, tournament, loadState: { status: "ready", error: null } });
      setSaveState({ status: "saved", error: null, lastSavedAt: Date.now() });
    } catch (e) {
      setSaveState({ status: "error", error: e?.message || String(e), lastSavedAt: null });
    }
  }

  function handleResetStorage() {
    clearLocalStorageSave();
    setSaveState({ status: "idle", error: null, lastSavedAt: null });
    resetAll();
  }

  function pickWithFeedback(side) {
    if (!currentStage?.a || !currentStage?.b) return;
    if (isAdvancing) return;

    setIsAdvancing(true);
    setSelectedSide(side);

    window.setTimeout(() => {
      setTournament((t) => (t ? applyPick(t, side) : t));
      setSelectedSide(null);
      setIsAdvancing(false);
    }, 260);
  }

  async function playTrack(track) {
    if (!auth.token || !deviceId || !track?.uri) return;
    setPlaybackError(null);
    try {
      await spotifyNoContent(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, auth.token, {
        method: "PUT",
        body: JSON.stringify({ uris: [track.uri] }),
      });
    } catch (e) {
      setPlaybackError(e?.message || String(e));
    }
  }

  async function pausePlayback() {
    if (!auth.token || !deviceId) return;
    setPlaybackError(null);
    try {
      await spotifyNoContent(`/me/player/pause?device_id=${encodeURIComponent(deviceId)}`, auth.token, { method: "PUT" });
    } catch (e) {
      setPlaybackError(e?.message || String(e));
    }
  }

  async function togglePlay(track) {
    if (!track) return;
    if (nowPlayingId === track.id) {
      if (isPaused) {
        try {
          await spotifyNoContent(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, auth.token, { method: "PUT" });
        } catch (e) {
          setPlaybackError(e?.message || String(e));
        }
      } else {
        await pausePlayback();
      }
      return;
    }
    await playTrack(track);
  }

  function normalizePair(a, b) {
    if (!a || !b) return { top: a, bottom: b, swapped: false };
    const ap = a.popularity ?? 0;
    const bp = b.popularity ?? 0;
    if (ap >= bp) return { top: a, bottom: b, swapped: false };
    return { top: b, bottom: a, swapped: true };
  }

  const displayed = useMemo(() => {
    if (!currentStage?.a || !currentStage?.b) return null;
    const { top, bottom, swapped } = normalizePair(currentStage.a, currentStage.b);
    return {
      top,
      bottom,
      topPickSide: swapped ? "b" : "a",
      bottomPickSide: swapped ? "a" : "b",
    };
  }, [currentStage]);

  const shareText = useMemo(() => {
    if (!tournament?.champion) return "";
    const c = tournament.champion;
    const plName = playlistMeta?.name ? ` from “${playlistMeta.name}”` : "";
    return `My champion${plName}: ${c.name} — ${c.artists}`;
  }, [tournament?.champion, playlistMeta?.name]);

  async function shareChampion() {
    if (!tournament?.champion) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: "My Favorite Song Champion", text: shareText, url: window.location.href });
      } else {
        await navigator.clipboard.writeText(shareText);
        alert("Copied ✅");
      }
    } catch {}
  }

  return (
    <Shell>
      <GradientTitle
        title="Spotify Duel"
        subtitle="Tap a card to advance it. If a round is odd, the most popular track gets a BYE. Special handling when 3 tracks remain."
      />

      {/* Auth */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-bold">Connect to Spotify</div>
            <div className="mt-1 text-xs text-zinc-400 leading-relaxed">
              Sign in to load playlists and enable in-app playback (Premium required).
            </div>
          </div>

          <div className="shrink-0">
            {auth.status === "authed" ? (
              <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/20 px-3 py-1.5 text-xs">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="text-emerald-200">Connected</span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 ring-1 ring-amber-400/20 px-3 py-1.5 text-xs">
                <span className="h-2 w-2 rounded-full bg-amber-300" />
                <span className="text-amber-200">Not connected</span>
              </div>
            )}
          </div>
        </div>

        {(playbackError || premiumWarning) && auth.status === "authed" ? (
          <div className="mt-4 rounded-2xl bg-amber-500/10 ring-1 ring-amber-500/20 p-3 text-xs text-amber-100">
            <div className="font-semibold">Playback status</div>
            {premiumWarning ? <div className="mt-1 opacity-90">{premiumWarning}</div> : null}
            {playbackError ? <div className="mt-1 opacity-90">{playbackError}</div> : null}
          </div>
        ) : null}

        <div className="mt-4 flex gap-2">
          <Button
            onClick={() => startSpotifyLogin()}
            disabled={auth.status === "authed" || auth.status === "authing" || auth.status === "needs_client_id"}
            className="w-full"
          >
            {auth.status === "authing" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
            {auth.status === "authed" ? "Connected" : "Sign in"}
          </Button>

          <Button variant="ghost" onClick={handleResetStorage} className="shrink-0" title="Reset app + storage">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {auth.status === "authed" ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Pill icon={Shield}>{playerReady ? "Player ready" : "Player loading…"}</Pill>
            <Pill icon={Sparkles}>{canPlayInsideApp ? "In-app playback enabled" : "Playback pending"}</Pill>
          </div>
        ) : null}
      </Card>

      {/* Playlist */}
      <div className="mt-4" />
      <Card className="p-4">
        <div className="text-sm font-bold">Playlist</div>
        <div className="mt-1 text-xs text-zinc-400">Paste a Spotify playlist link (public, or private if you have access).</div>

        <div className="mt-3">
          <Input value={playlistInput} onChange={setPlaylistInput} placeholder="https://open.spotify.com/playlist/..." />
        </div>

        <div className="mt-3 flex gap-2">
          <Button onClick={handleLoadPlaylist} disabled={!canLoadPlaylist || loadState.status === "loading"} className="w-full">
            {loadState.status === "loading" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Music2 className="h-4 w-4" />}
            Start tournament
          </Button>
        </div>

        {loadState.status === "error" ? (
          <div className="mt-3 rounded-2xl bg-rose-500/10 ring-1 ring-rose-500/25 p-3 text-xs text-rose-200">{loadState.error}</div>
        ) : null}
      </Card>

      {/* Playlist meta */}
      {playlistMeta ? (
        <div className="mt-4">
          <Card className="p-4">
            <div className="flex items-center gap-3">
              {getImage(playlistMeta.images, "sm") ? (
                <img
                  src={getImage(playlistMeta.images, "sm")}
                  alt="playlist"
                  className="h-14 w-14 rounded-2xl object-cover ring-1 ring-white/10"
                />
              ) : (
                <div className="h-14 w-14 rounded-2xl bg-white/5 ring-1 ring-white/10" />
              )}

              <div className="min-w-0">
                <div className="text-sm font-extrabold truncate">{playlistMeta.name}</div>
                <div className="mt-0.5 text-xs text-zinc-400 truncate">by {playlistMeta.owner?.display_name || "—"}</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Pill>Tracks: {tracks.length}</Pill>
                  {tournament ? <Pill>Rounds built: {tournament.rounds.length}</Pill> : null}
                </div>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {/* Tournament */}
      {tournament ? (
        <div className="mt-4 space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold">Progress</div>
              <div className="text-xs text-zinc-400 tabular-nums">
                {roundProgress.done}/{roundProgress.total}
              </div>
            </div>

            <div className="mt-3 h-2 w-full rounded-full bg-white/10">
              <div
                className="h-2 rounded-full bg-white/70"
                style={{ width: `${roundProgress.total ? (roundProgress.done / roundProgress.total) * 100 : 0}%` }}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <Pill icon={Sparkles}>{progressLabel(tournament)}</Pill>
              <Pill icon={Trophy}>{tournament.champion ? "Champion ready" : "Picking…"}</Pill>
            </div>

            {/* NEW: Save / Reset */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button onClick={handleSave} disabled={!tournament}>
                Save
              </Button>
              <Button variant="ghost" onClick={handleResetStorage}>
                Reset
              </Button>
            </div>

            {saveState.status === "saved" ? (
              <div className="mt-2 text-[11px] text-zinc-500">Saved ✓</div>
            ) : saveState.status === "restored" ? (
              <div className="mt-2 text-[11px] text-zinc-500">Restored ✓</div>
            ) : null}

            {saveState.status === "error" ? (
              <div className="mt-2 rounded-2xl bg-rose-500/10 ring-1 ring-rose-500/25 p-3 text-xs text-rose-200">{saveState.error}</div>
            ) : null}
          </Card>

          {tournament.champion ? (
            <AnimatePresence mode="wait">
              <motion.div
                key="champion"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ duration: 0.25 }}
              >
                <Card className="overflow-hidden">
                  <div className="relative">
                    {tournament.champion.albumImage ? (
                      <img src={tournament.champion.albumImage} alt="champion" className="h-56 w-full object-cover" />
                    ) : (
                      <div className="h-56 w-full bg-white/5" />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-black/10" />
                    <div className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full bg-black/45 ring-1 ring-white/15 px-4 py-2 text-xs">
                      <Trophy className="h-4 w-4" />
                      <span className="font-semibold">Champion</span>
                    </div>
                    <div className="absolute bottom-4 left-4 right-4">
                      <div className="text-xl font-extrabold leading-tight">{tournament.champion.name}</div>
                      <div className="mt-1 text-sm text-zinc-200/90">{tournament.champion.artists}</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Pill>Popularity: {tournament.champion.popularity}</Pill>
                        <Pill>⏱ {formatMs(tournament.champion.duration_ms)}</Pill>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 flex gap-2">
                    <Button onClick={shareChampion} className="w-full">
                      <Sparkles className="h-4 w-4" />
                      Share result
                    </Button>
                    <Button variant="ghost" onClick={handleResetStorage} className="shrink-0">
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              </motion.div>
            </AnimatePresence>
          ) : currentStage && displayed ? (
            <AnimatePresence mode="wait">
              <motion.div
                key={`${tournament.roundIndex}-${tournament.cursor?.match ?? tournament.cursor?.special ?? "x"}`}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ duration: 0.25 }}
                className="space-y-3"
              >
                {/* Special info for 3 remaining */}
                {currentStage.kind === "three" ? (
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold">3-left rule</div>
                        <div className="mt-1 text-xs text-zinc-400 leading-relaxed">
                          The most popular track goes straight to the Final. Pick the other finalist below.
                        </div>
                      </div>
                      <div className="shrink-0 inline-flex items-center gap-2 rounded-full bg-white/5 ring-1 ring-white/10 px-3 py-1.5 text-xs text-zinc-200">
                        <Trophy className="h-4 w-4" />
                        <span>Auto finalist</span>
                      </div>
                    </div>

                    <div className="mt-3 rounded-2xl bg-white/5 ring-1 ring-white/10 p-3">
                      <div className="text-[11px] text-zinc-400">Auto finalist</div>
                      <div className="mt-1 text-sm font-extrabold truncate">{currentStage.top?.name}</div>
                      <div className="mt-0.5 text-xs text-zinc-400 truncate">{currentStage.top?.artists}</div>
                    </div>
                  </Card>
                ) : null}

                {/* Cards + playback controls outside */}
                <div className="space-y-4">
                  <div className="space-y-2">
                    <TrackCard
                      track={displayed.top}
                      badge="Most popular"
                      cornerTag="TOP"
                      selected={selectedSide === displayed.topPickSide}
                      disabled={isAdvancing || !currentStage.a || !currentStage.b}
                      onSelect={() => pickWithFeedback(displayed.topPickSide)}
                    />
                    <TrackControls
                      track={displayed.top}
                      canPlay={canPlayInsideApp}
                      isPlaying={nowPlayingId === displayed.top?.id && !isPaused}
                      onTogglePlay={() => togglePlay(displayed.top)}
                    />
                  </div>

                  <div className="space-y-2">
                    <TrackCard
                      track={displayed.bottom}
                      badge="Least popular"
                      cornerTag="BOTTOM"
                      selected={selectedSide === displayed.bottomPickSide}
                      disabled={isAdvancing || !currentStage.a || !currentStage.b}
                      onSelect={() => pickWithFeedback(displayed.bottomPickSide)}
                    />
                    <TrackControls
                      track={displayed.bottom}
                      canPlay={canPlayInsideApp}
                      isPlaying={nowPlayingId === displayed.bottom?.id && !isPaused}
                      onTogglePlay={() => togglePlay(displayed.bottom)}
                    />
                  </div>
                </div>

                <Card className="p-4">
                  <div className="text-sm font-bold">Tap a card to choose</div>
                  <div className="mt-1 text-xs text-zinc-400">Your pick advances immediately.</div>

                  {!canPlayInsideApp ? (
                    <div className="mt-3 text-[11px] text-zinc-500 leading-relaxed flex items-start gap-2">
                      <Lock className="h-4 w-4 mt-0.5" />
                      <span>
                        In-app playback needs Spotify Premium and a ready player. If playback doesn’t start, open Spotify,
                        play any song once, then return and try again.
                      </span>
                    </div>
                  ) : null}
                </Card>
              </motion.div>
            </AnimatePresence>
          ) : (
            <Card className="p-4">
              <div className="text-sm font-bold">Preparing…</div>
              <div className="mt-1 text-xs text-zinc-400">No playable match found right now. The tournament may be auto-advancing.</div>
              <div className="mt-3">
                <Button variant="ghost" className="w-full" onClick={() => setTournament((t) => (t ? fastForwardIfNeeded(t) : t))}>
                  Continue
                </Button>
              </div>
            </Card>
          )}

          <BracketMini tournament={tournament} />
        </div>
      ) : null}

      <FooterHint />

      <div className="fixed bottom-0 left-0 right-0 bg-gradient-to-t from-black via-black/80 to-transparent">
        <div className="mx-auto max-w-md px-4 pb-4 pt-3">
          <Card className="p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold truncate">Tip</div>
                <div className="mt-0.5 text-[11px] text-zinc-400 truncate">Best experience: 16–64 tracks</div>
              </div>
              <div className="shrink-0">
                <div className="inline-flex items-center gap-2 rounded-full bg-white/5 ring-1 ring-white/10 px-3 py-1.5 text-[11px] text-zinc-200">
                  <Sparkles className="h-4 w-4" />
                  <span>Mobile-first</span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </Shell>
  );
}