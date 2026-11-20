/* ============================================================
   Image Wall
   Multi-source image search + click-to-fullscreen viewer

   Sources
   -------
   Keyless (work immediately):
     · Openverse        — Creative Commons across the web
     · Wikimedia        — Commons files
     · Art Institute    — museum paintings (artic.edu)
     · Cleveland Museum — museum works
     · NASA Images      — space photography
     · iNaturalist      — licensed wildlife photos
     · GBIF             — biodiversity specimens
   Keyed (free signup, key stored locally):
     · Pexels, Pixabay, Unsplash

   Speed notes
   ------------
   · API results are cached in memory + localStorage (24h TTL), so
     repeat searches and paging back are instant and cost no requests.
   · A new search aborts the in-flight one instead of racing it.
   · Each source appends the moment it lands, so the wall starts
     filling at the speed of the fastest API, not the slowest.
   · Grid tiles use right-sized thumbnails; the viewer paints the
     already-cached thumb immediately, then upgrades to a large
     version in the background.
   · A source that rate-limits (429) is put on a short cooldown
     instead of being retried on every keystroke.
   ============================================================ */

(() => {
  'use strict';

  /* ----------------------------------------------------------
     Config
     ---------------------------------------------------------- */

  const SKELETONS = 14;

  const GRID_THUMB_WIDTH = 500;   // Commons grid thumbnail
  const VIEWER_THUMB_WIDTH = 1920; // Commons large (projection-sized)

  const SUGGESTIONS = [
    'mountain', 'ocean', 'forest', 'starry sky',
    'waterfall', 'city at night', 'desert', 'flowers',
    'wildlife', 'space nebula', 'architecture', 'autumn'
  ];

  const CACHE_KEY = 'imagewall.cache.v1';
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
  const CACHE_MAX = 120;                 // entries
  const RECENTS_KEY = 'imagewall.recents.v1';
  const RECENTS_MAX = 8;
  const KEYS_KEY = 'imagewall.keys.v1';
  const SOURCES_KEY = 'imagewall.sources.v1';

  // Baked-in default API keys, used when this browser has none stored.
  // WARNING: this file is served as public static JS — anyone can read these.
  const DEFAULT_KEYS = {
    pixabay: '53105794-ea4df60b226951916b041f7bc',
  };

  const COOLDOWN_MS = 60 * 1000; // how long a rate-limited source rests

  const saveData = !!(
    navigator.connection && navigator.connection.saveData
  );

  /* ----------------------------------------------------------
     DOM
     ---------------------------------------------------------- */

  const $ = (id) => document.getElementById(id);

  const el = {
    header: $('header'),
    form: $('search-form'),
    input: $('q'),
    clear: $('clear-btn'),
    empty: $('empty'),
    chips: $('chips'),
    grid: $('grid'),
    status: $('status'),
    sentinel: $('sentinel'),

    sourcesBtn: $('sources-btn'),
    sourcesCount: $('sources-count'),
    sheet: $('sources-sheet'),
    sheetBody: $('sources-body'),
    sheetClose: $('sources-close'),

    viewer: $('viewer'),
    viewerImg: $('viewer-img'),
    viewerCount: $('viewer-count'),
    viewerClose: $('viewer-close'),
    viewerPrev: $('viewer-prev'),
    viewerNext: $('viewer-next'),
    viewerLoading: $('viewer-loading'),
  };

  /* ----------------------------------------------------------
     Local settings (API keys + per-source switches)
     ---------------------------------------------------------- */

  const Settings = {
    read(store, fallback) {
      try {
        const raw = localStorage.getItem(store);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
      } catch (_) { return fallback; }
    },

    write(store, value) {
      try { localStorage.setItem(store, JSON.stringify(value)); } catch (_) {}
    },

    keys() { return { ...DEFAULT_KEYS, ...this.read(KEYS_KEY, {}) }; },
    key(id) {
      const v = this.keys()[id];
      return typeof v === 'string' ? v.trim() : '';
    },
    setKey(id, value) {
      const all = this.keys();
      if (value) all[id] = value.trim();
      else delete all[id];
      this.write(KEYS_KEY, all);
    },

    // Per-source opt-out. Anything not listed is enabled by default.
    off() {
      const v = this.read(SOURCES_KEY, {});
      return Array.isArray(v.off) ? v.off : [];
    },
    setOff(id, off) {
      const list = this.off().filter((x) => x !== id);
      if (off) list.push(id);
      this.write(SOURCES_KEY, { off: list });
    },
    isOff(id) { return this.off().includes(id); },
  };

  /* ----------------------------------------------------------
     State
     ---------------------------------------------------------- */

  const state = {
    query: '',
    pages: {},          // providerId -> next page to fetch
    busy: false,
    done: false,
    errors: [],
    items: [],
    index: -1,
    runId: 0,
    cooldown: {},       // providerId -> timestamp until which it rests
  };

  let idleTimer = 0;
  let lastScrollY = 0;
  let scrollTicking = false;
  let inflight = null;   // AbortController for the current search

  /* ----------------------------------------------------------
     Response cache (memory + localStorage)
     ---------------------------------------------------------- */

  const Cache = {
    mem: new Map(),
    saveTimer: 0,

    load() {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.e)) return;
        const now = Date.now();
        for (const entry of parsed.e) {
          if (!entry || !Array.isArray(entry)) continue;
          const [k, v] = entry;
          if (!k || !v || !Array.isArray(v.v)) continue;
          if (now - v.t > CACHE_TTL) continue;
          this.mem.set(k, v);
        }
      } catch (_) { /* private mode / corrupt — run uncached */ }
    },

    get(key) {
      const hit = this.mem.get(key);
      if (!hit) return null;
      if (Date.now() - hit.t > CACHE_TTL) {
        this.mem.delete(key);
        return null;
      }
      return hit.v;
    },

    set(key, items) {
      this.mem.set(key, { t: Date.now(), v: items });
      this.persist();
    },

    persist() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        try {
          // Prune oldest beyond the cap
          const all = [...this.mem.entries()]
            .sort((a, b) => a[1].t - b[1].t)
            .slice(-CACHE_MAX);
          localStorage.setItem(CACHE_KEY, JSON.stringify({ e: all }));
        } catch (_) { /* quota or private mode — memory cache still works */ }
      }, 600);
    },
  };

  Cache.load();

  /* ----------------------------------------------------------
     Recent searches
     ---------------------------------------------------------- */

  const Recents = {
    all() {
      try {
        const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
        return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
      } catch (_) { return []; }
    },
    push(q) {
      if (!q) return;
      const next = [q, ...this.all().filter((s) => s.toLowerCase() !== q.toLowerCase())]
        .slice(0, RECENTS_MAX);
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch (_) {}
      renderChips();
    },
  };

  /* ----------------------------------------------------------
     Small helpers
     ---------------------------------------------------------- */

  /* Numeric character references — same output as named entities,
     without relying on literal "&"-style strings. */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => {
    const codes = { '&': 38, '<': 60, '>': 62, '"': 34, "'": 39 };
    return '&#' + codes[c] + ';';
  });

  function aspectFrom(w, h) {
    if (!w || !h) return 3 / 2;
    return Math.min(Math.max(w / h, 0.62), 2.4);
  }

  function fetchJSON(url, timeoutMs = 12000, signal, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    // Chain an external signal so a superseded search can be cancelled
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }

    return fetch(url, {
      signal: ctrl.signal,
      headers: Object.assign({ Accept: 'application/json' }, headers || {}),
    })
      .then((res) => {
        if (!res.ok) {
          const err = new Error('HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .finally(() => clearTimeout(timer));
  }

  /* ----------------------------------------------------------
     Providers

     Each provider exposes:
       id       — stable key (also the cache prefix)
       label    — shown in the UI
       group    — section in the sources sheet
       maxPages — how deep "load more" may go
       needsKey — 'none' | 'optional' | 'required'
       search(query, page, signal) -> Promise<items[]>
     ---------------------------------------------------------- */

  const Providers = [

    /* ---------------- Openverse ---------------- */
    {
      id: 'openverse',
      label: 'Openverse',
      group: 'Creative Commons',
      maxPages: 8,
      needsKey: 'optional',
      keyUrl: 'https://api.openverse.org/v1/auth_tokens/register/',
      keyHint: 'Optional — raises the anonymous rate limit.',
      search: searchOpenverse,
    },

    /* ---------------- Wikimedia Commons ---------------- */
    {
      id: 'commons',
      label: 'Wikimedia',
      group: 'Creative Commons',
      maxPages: 4,          // Commons search paging is shallow
      needsKey: 'none',
      search: searchCommons,
    },

    /* ---------------- Pexels ---------------- */
    {
      id: 'pexels',
      label: 'Pexels',
      group: 'Stock photos',
      maxPages: 8,
      needsKey: 'required',
      keyUrl: 'https://www.pexels.com/api/',
      keyHint: 'Free key — 200 requests/hour.',
      search: searchPexels,
    },

    /* ---------------- Pixabay ---------------- */
    {
      id: 'pixabay',
      label: 'Pixabay',
      group: 'Stock photos',
      maxPages: 8,
      needsKey: 'required',
      keyUrl: 'https://pixabay.com/api/docs/',
      keyHint: 'Free key — 100 requests/minute.',
      search: searchPixabay,
    },

    /* ---------------- Unsplash ---------------- */
    {
      id: 'unsplash',
      label: 'Unsplash',
      group: 'Stock photos',
      maxPages: 8,
      needsKey: 'required',
      keyUrl: 'https://unsplash.com/developers',
      keyHint: 'Free key — 50 requests/hour.',
      search: searchUnsplash,
    },

    /* ---------------- Art Institute of Chicago ---------------- */
    {
      id: 'artic',
      label: 'Art Institute',
      group: 'Museums',
      maxPages: 4,
      needsKey: 'none',
      search: searchArtic,
    },

    /* ---------------- Cleveland Museum of Art ---------------- */
    {
      id: 'cleveland',
      label: 'Cleveland Museum',
      group: 'Museums',
      maxPages: 4,
      needsKey: 'none',
      search: searchCleveland,
    },

    /* ---------------- NASA ---------------- */
    {
      id: 'nasa',
      label: 'NASA',
      group: 'Science & space',
      maxPages: 4,
      needsKey: 'none',
      search: searchNasa,
    },

    /* ---------------- iNaturalist ---------------- */
    {
      id: 'inaturalist',
      label: 'iNaturalist',
      group: 'Nature',
      maxPages: 4,
      needsKey: 'none',
      search: searchINat,
    },

    /* ---------------- GBIF ---------------- */
    {
      id: 'gbif',
      label: 'GBIF',
      group: 'Nature',
      maxPages: 4,
      needsKey: 'none',
      search: searchGbif,
    },
  ];

  const providerById = (id) => Providers.find((p) => p.id === id);

  /* A provider is usable when it is switched on, has the key it needs,
     and is not serving out a rate-limit cooldown. */
  function usableProviders() {
    const now = Date.now();
    return Providers.filter((p) => {
      if (Settings.isOff(p.id)) return false;
      if (p.needsKey === 'required' && !Settings.key(p.id)) return false;
      if (state.cooldown[p.id] && state.cooldown[p.id] > now) return false;
      return true;
    });
  }

  /* ----------------------------------------------------------
     Provider implementations
     ---------------------------------------------------------- */

  async function searchOpenverse(query, page, signal) {
    const key = 'ov:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const params = new URLSearchParams({
      q: query,
      page_size: '20',
      page: String(page),
    });

    const data = await fetchJSON(
      'https://api.openverse.org/v1/images/?' + params.toString(),
      12000, signal
    );

    const items = (data.results || [])
      .filter((r) => r && r.url)
      .map((r) => ({
        id: 'ov-' + r.id,
        // Openverse `url` is the provider's own file (often 1024px) —
        // a good projection size without loading a multi-megabyte original.
        full: r.url,
        // Their proxied thumbnail is size-bounded, which the original
        // is not, so the grid uses it and falls back to `url`.
        thumb: r.thumbnail || r.url,
        large: r.url,
        w: r.width, h: r.height,
        title: (r.title || '').trim(),
        source: r.provider || 'Openverse',
        link: r.foreign_landing_url || '',
      }));

    if (items.length) Cache.set(key, items);
    return items;
  }

  async function searchCommons(query, page, signal) {
    const key = 'wm:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrnamespace: '6',
      gsrlimit: '40',
      prop: 'imageinfo',
      iiprop: 'url|size|mime',
      iiurlwidth: String(GRID_THUMB_WIDTH),
      format: 'json',
      formatversion: '2',
      origin: '*',
    });

    const s = Math.min(page, 4);
    params.set('gsroffset', String((s - 1) * 40));

    const data = await fetchJSON(
      'https://commons.wikimedia.org/w/api.php?' + params.toString(),
      12000, signal
    );
    const pages = (data.query && data.query.pages) || [];

    const items = pages
      .map((p) => {
        const info = (p.imageinfo || [])[0];
        if (!info || !info.url) return null;
        if (!/^image\/(jpeg|png|webp|gif)$/.test(info.mime || '')) return null;
        return {
          id: 'wm-' + p.pageid,
          full: info.url,
          thumb: info.thumburl || info.url,
          large: commonsLarge(info.thumburl, info.url),
          w: info.width,
          h: info.height,
          title: (p.title || '')
            .replace(/^File:/, '')
            .replace(/\.[a-z0-9]+$/i, ''),
          source: 'Wikimedia',
          link: info.descriptionurl || '',
        };
      })
      .filter(Boolean);

    if (items.length) Cache.set(key, items);
    return items;
  }

  /* Commons returns one thumbnail width per request. Standard widths
     (500, 1920, …) are pre-rendered by their CDN and cheap; arbitrary
     widths return HTTP 400. So derive the large version by swapping
     the width token, and fall back to the original if that fails. */
  function commonsLarge(thumburl, original) {
    if (!thumburl) return original || '';
    const swapped = thumburl.replace(
      /\/(\d+)px-/,
      '/' + VIEWER_THUMB_WIDTH + 'px-'
    );
    return swapped !== thumburl ? swapped : (original || thumburl);
  }

  async function searchPexels(query, page, signal) {
    const key = 'px:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const apiKey = Settings.key('pexels');
    if (!apiKey) return [];

    const params = new URLSearchParams({
      query,
      per_page: '20',
      page: String(page),
    });

    const data = await fetchJSON(
      'https://api.pexels.com/v1/search?' + params.toString(),
      12000, signal,
      { Authorization: apiKey }
    );

    const items = (data.photos || [])
      .filter((p) => p && p.src)
      .map((p) => ({
        id: 'px-' + p.id,
        full: p.src.original || p.src.large2x || p.src.large,
        thumb: p.src.medium || p.src.small || p.src.tiny || p.src.original,
        large: p.src.large2x || p.src.large || p.src.original,
        w: p.width, h: p.height,
        title: (p.alt || '').trim(),
        source: 'Pexels',
        link: p.url || '',
      }));

    if (items.length) Cache.set(key, items);
    return items;
  }

  async function searchPixabay(query, page, signal) {
    const key = 'pb:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const apiKey = Settings.key('pixabay');
    if (!apiKey) return [];

    const params = new URLSearchParams({
      key: apiKey,
      q: query,
      image_type: 'photo',
      per_page: '20',
      page: String(page),
      safesearch: 'true',
    });

    const data = await fetchJSON(
      'https://pixabay.com/api/?' + params.toString(),
      12000, signal
    );

    const items = (data.hits || [])
      .filter((h) => h && (h.largeImageURL || h.webformatURL))
      .map((h) => ({
        id: 'pb-' + h.id,
        full: h.fullHDURL || h.largeImageURL || h.webformatURL,
        thumb: h.webformatURL || h.previewURL || h.largeImageURL,
        large: h.fullHDURL || h.largeImageURL || h.webformatURL,
        w: h.imageWidth, h: h.imageHeight,
        title: (h.tags || '').split(',').slice(0, 4).join(', ').trim(),
        source: 'Pixabay',
        link: h.pageURL || '',
      }));

    if (items.length) Cache.set(key, items);
    return items;
  }

  async function searchUnsplash(query, page, signal) {
    const key = 'us:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const apiKey = Settings.key('unsplash');
    if (!apiKey) return [];

    const params = new URLSearchParams({
      query,
      per_page: '20',
      page: String(page),
    });

    const data = await fetchJSON(
      'https://api.unsplash.com/search/photos?' + params.toString(),
      12000, signal,
      { Authorization: apiKey }
    );

    const items = (data.results || [])
      .filter((p) => p && p.urls)
      .map((p) => ({
        id: 'us-' + p.id,
        full: p.urls.raw || p.urls.full,
        thumb: p.urls.small || p.urls.regular || p.urls.full,
        large: p.urls.full || p.urls.regular,
        w: p.width, h: p.height,
        title: (p.alt_description || p.description || '').trim(),
        source: 'Unsplash',
        link: (p.links && p.links.html) || '',
      }));

    if (items.length) Cache.set(key, items);
    return items;
  }

  async function searchArtic(query, page, signal) {
    const key = 'ai:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const params = new URLSearchParams({
      q: query,
      limit: '24',
      page: String(page),
      fields: 'id,title,image_id,artist_title,date_display',
    });

    const data = await fetchJSON(
      'https://api.artic.edu/api/v1/artworks/search?' + params.toString(),
      12000, signal
    );

    const items = (data.data || [])
      .filter((a) => a && a.image_id)
      .map((a) => {
        const base = 'https://www.artic.edu/iiif/2/' + a.image_id;
        return {
          id: 'ai-' + a.id,
          full: base + '/full/1686,/0/default.jpg',
          thumb: base + '/full/843,/0/default.jpg',
          large: base + '/full/1686,/0/default.jpg',
          w: 0, h: 0,
          title: [a.title, a.artist_title].filter(Boolean).join(' — '),
          source: 'Art Institute',
          link: 'https://www.artic.edu/artworks/' + a.id,
        };
      });

    if (items.length) Cache.set(key, items);
    return items;
  }

  async function searchCleveland(query, page, signal) {
    const key = 'cm:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const params = new URLSearchParams({
      q: query,
      limit: '24',
      skip: String((page - 1) * 24),
      has_image: 'true',
    });

    const data = await fetchJSON(
      'https://openaccess-api.clevelandart.org/api/artworks/?' + params.toString(),
      12000, signal
    );

    const items = (data.data || [])
      .filter((a) => a && a.images && a.images.web && a.images.web.url)
      .map((a) => ({
        id: 'cm-' + a.id,
        full: (a.images.print && a.images.print.url) || a.images.web.url,
        thumb: a.images.web.url,
        large: (a.images.print && a.images.print.url) || a.images.web.url,
        w: (a.images.web && a.images.web.width) || 0,
        h: (a.images.web && a.images.web.height) || 0,
        title: [a.title, a.creator_display].filter(Boolean).join(' — '),
        source: 'Cleveland Museum',
        link: 'https://www.openaccess-art.clevelandart.org/artworks/' + a.id,
      }));

    if (items.length) Cache.set(key, items);
    return items;
  }

  async function searchNasa(query, page, signal) {
    const key = 'na:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const params = new URLSearchParams({
      q: query,
      media_type: 'image',
      page: String(page),
    });

    const data = await fetchJSON(
      'https://images-api.nasa.gov/search?' + params.toString(),
      12000, signal
    );

    const items = ((data.collection && data.collection.items) || [])
      .map((it) => {
        const meta = (it.data || [])[0] || {};
        const links = it.links || [];
        const pick = (re) => {
          const l = links.find((x) => x.render === 'image' && re.test(x.href || ''));
          return l ? l.href : '';
        };
        const full = pick(/~orig\./);
        const large = pick(/~large\./) || full || pick(/~medium\./);
        const thumb = pick(/~medium\./) || large || full;
        if (!thumb) return null;
        const size = links.find((x) => x.href === thumb) || {};
        return {
          id: 'na-' + (meta.nasa_id || it.href),
          full: full || large || thumb,
          thumb,
          large: large || full || thumb,
          w: size.width || 0, h: size.height || 0,
          title: meta.title || meta.description || 'NASA image',
          source: 'NASA',
          link: meta.nasa_id
            ? 'https://images.nasa.gov/details/' + meta.nasa_id
            : '',
        };
      })
      .filter(Boolean);

    if (items.length) Cache.set(key, items);
    return items;
  }

  async function searchINat(query, page, signal) {
    const key = 'in:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const params = new URLSearchParams({
      q: query,
      per_page: '20',
      page: String(page),
      photos: 'true',
      photo_license: 'cc0,cc-by,cc-by-sa',
      quality_grade: 'research',
      order_by: 'votes',
    });

    const data = await fetchJSON(
      'https://api.inaturalist.org/v1/observations?' + params.toString(),
      12000, signal
    );

    const items = (data.results || [])
      .map((o) => {
        const photo = (o.photos || [])[0];
        if (!photo || !photo.url) return null;
        // The API hands back a square; medium/large follow the same path.
        const large = photo.url.replace(/\/square\.jpg$/, '/large.jpg');
        const medium = photo.url.replace(/\/square\.jpg$/, '/medium.jpg');
        const taxon = (o.taxon && (o.taxon.preferred_common_name || o.taxon.name)) || '';
        return {
          id: 'in-' + o.id,
          full: large,
          thumb: medium,
          large,
          w: 0, h: 0,
          title: taxon,
          source: 'iNaturalist',
          link: 'https://www.inaturalist.org/observations/' + o.id,
        };
      })
      .filter(Boolean);

    if (items.length) Cache.set(key, items);
    return items;
  }

  async function searchGbif(query, page, signal) {
    const key = 'gb:' + query.toLowerCase() + ':' + page;
    const cached = Cache.get(key);
    if (cached) return cached;

    const params = new URLSearchParams({
      q: query,
      media_type: 'StillImage',
      limit: '20',
      offset: String((page - 1) * 20),
    });

    const data = await fetchJSON(
      'https://api.gbif.org/v1/occurrence/search?' + params.toString(),
      12000, signal
    );

    const items = (data.results || [])
      .map((r) => {
        const media = (r.media || [])[0];
        if (!media || !media.identifier) return null;
        if (!/^https?:/i.test(media.identifier)) return null;
        return {
          id: 'gb-' + r.key,
          full: media.identifier,
          thumb: media.identifier,
          large: media.identifier,
          w: 0, h: 0,
          title: [r.scientificName, media.title].filter(Boolean).join(' — '),
          source: 'GBIF',
          link: 'https://www.gbif.org/occurrence/' + r.key,
        };
      })
      .filter(Boolean);

    if (items.length) Cache.set(key, items);
    return items;
  }

  /* ----------------------------------------------------------
     Search
     ---------------------------------------------------------- */

  function stopInflight() {
    if (inflight) {
      try { inflight.abort(); } catch (_) {}
      inflight = null;
    }
  }

  async function runSearch(query, { replace = true } = {}) {
    const q = query.trim();
    if (!q) return;

    // Cancel the previous search; its results would be stale anyway.
    stopInflight();
    inflight = new AbortController();
    const signal = inflight.signal;

    const runId = ++state.runId;
    const isCurrent = () => runId === state.runId;

    state.query = q;
    el.input.value = q;
    el.clear.hidden = false;

    if (replace) {
      state.pages = {};
      state.done = false;
      state.errors = [];
      state.items = [];
      el.grid.innerHTML = '';
      el.status.textContent = '';
      showSkeletons(SKELETONS);
      setEmpty(false);
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    state.busy = true;

    const active = usableProviders();
    if (!active.length) {
      state.busy = false;
      state.done = true;
      el.status.innerHTML =
        'No sources are enabled.<br><small>Open the sources panel to turn some on.</small>' +
        '<button type="button" data-retry>Open sources</button>';
      return;
    }

    const launched = active.map((p) => ({
      name: p.id,
      label: p.label,
      page: state.pages[p.id] || 1,
      fn: p.search,
    }));

    let remaining = launched.length;
    let fresh = 0;
    let firstPaint = false;

    const settle = () => {
      if (--remaining > 0) return;
      if (!isCurrent()) return;

      state.busy = false;

      if (fresh === 0) {
        if (state.errors.length) {
          el.status.innerHTML =
            'No images came back.<br><small>' +
            esc(state.errors.slice(0, 3).join(' · ')) +
            '</small><button type="button" data-retry>Try again</button>';
        } else {
          el.status.textContent =
            'No results for “' + state.query + '”. Try a different word.';
        }
        state.done = true;
      } else {
        el.status.textContent = '';
        state.done = false;
      }

      syncURL();
    };

    launched.forEach(({ name, label, page, fn }) => {
      fn(q, page, signal).then((items) => {
        if (!isCurrent()) return;

        state.pages[name] = page + 1;

        if (items.length) {
          clearSkeletons();
          fresh += items.length;
          // Eager, high-priority loading for the first screenful only.
          appendItems(items, { eager: !firstPaint ? 6 : 0 });
          if (!firstPaint) firstPaint = true;
        }
        settle();
      }).catch((err) => {
        if (!isCurrent()) return;

        if (err && err.status === 429) {
          // Rest this source briefly so one busy API does not get
          // hammered on every keystroke.
          state.cooldown[name] = Date.now() + COOLDOWN_MS;
        }

        state.errors.push(label + ': ' + describeError(err));
        settle();
      });
    });

    Recents.push(q);
  }

  async function loadMore() {
    if (state.busy || state.done || !state.query) return;

    const active = usableProviders().filter((p) => {
      const page = state.pages[p.id] || 1;
      return page <= p.maxPages;
    });

    if (!active.length) {
      state.done = true;
      el.status.textContent = 'That’s everything for now. Refine your search to see more.';
      return;
    }

    stopInflight();
    inflight = new AbortController();
    const signal = inflight.signal;

    const runId = state.runId;
    const isCurrent = () => runId === state.runId;

    state.busy = true;

    const launched = active.map((p) => ({
      name: p.id,
      label: p.label,
      page: state.pages[p.id] || 1,
      fn: p.search,
    }));

    let remaining = launched.length;
    let fresh = 0;

    const settle = () => {
      if (--remaining > 0) return;
      if (!isCurrent()) return;

      state.busy = false;

      if (fresh === 0) {
        state.done = true;
        if (state.errors.length) {
          el.status.innerHTML =
            '<small>' + esc(state.errors[state.errors.length - 1]) + '</small>';
        }
      } else {
        el.status.textContent = '';
      }
    };

    launched.forEach(({ name, label, page, fn }) => {
      fn(state.query, page, signal).then((items) => {
        if (!isCurrent()) return;
        state.pages[name] = page + 1;
        if (items.length) {
          fresh += items.length;
          appendItems(items, { eager: 0 });
        }
        settle();
      }).catch((err) => {
        if (!isCurrent()) return;
        if (err && err.status === 429) {
          state.cooldown[name] = Date.now() + COOLDOWN_MS;
        }
        state.errors.push(label + ': ' + describeError(err));
        settle();
      });
    });
  }

  function describeError(err) {
    if (!err) return 'unknown error';
    if (err.name === 'AbortError') return 'timed out';
    if (err.status === 429) return 'rate limited — waiting a moment';
    if (err.status === 401 || err.status === 403) return 'check the API key';
    if (err.status) return 'HTTP ' + err.status;
    return err.message || 'network error';
  }

  /* ----------------------------------------------------------
     Rendering
     ---------------------------------------------------------- */

  function showSkeletons(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'skeleton';
      d.style.height = (150 + Math.round(Math.random() * 190)) + 'px';
      frag.appendChild(d);
    }
    el.grid.appendChild(frag);
  }

  function clearSkeletons() {
    el.grid.querySelectorAll('.skeleton').forEach((n) => n.remove());
  }

  function appendItems(items, { eager = 0 } = {}) {
    const frag = document.createDocumentFragment();
    const created = [];

    items.forEach((item, i) => {
      const fig = document.createElement('figure');
      fig.className = 'tile';
      fig.dataset.id = item.id;

      const img = document.createElement('img');
      // Only the first screenful competes eagerly for bandwidth.
      img.loading = i < eager ? 'eager' : 'lazy';
      img.decoding = 'async';
      if (i < eager) img.fetchPriority = 'high';
      img.alt = item.title || 'Image result';
      img.draggable = false;
      img.referrerPolicy = 'no-referrer';

      const ratio = aspectFrom(item.w, item.h);
      fig.style.aspectRatio = String(ratio);

      // Small credit line so you always know where a frame came from.
      if (item.source) {
        const tag = document.createElement('span');
        tag.className = 'tile-tag';
        tag.textContent = item.source;
        fig.appendChild(tag);
      }

      img.addEventListener('load', () => {
        // Images already in the cache never fire `load` after this
        // listener is attached, so `complete` is checked below too.
        fig.classList.add('shown');
      }, { once: true });

      img.addEventListener('error', () => {
        // Fall back to the provider's own file if the thumbnail is blocked
        const fallback = item.thumb !== item.full ? item.full : item.thumb;
        if (img.src !== fallback) {
          img.src = fallback;
          return;
        }
        fig.remove();
      });

      const index = state.items.length;
      fig.addEventListener('click', () => openViewer(index), { once: true });

      img.src = item.thumb || item.full;
      fig.appendChild(img);
      frag.appendChild(fig);
      created.push(fig);
      state.items.push(item);
    });

    el.grid.appendChild(frag);

    // Reveal anything already cached and complete (no `load` event will fire)
    requestAnimationFrame(() => {
      for (const t of created) {
        if (t.classList.contains('shown')) continue;
        const im = t.querySelector('img');
        if (im && im.complete && im.naturalWidth) t.classList.add('shown');
      }
    });
  }

  function setEmpty(show) {
    el.empty.classList.toggle('gone', !show);
  }

  /* ----------------------------------------------------------
     Sources panel
     ---------------------------------------------------------- */

  function renderSources() {
    el.sourcesCount.textContent = String(usableProviders().length);
    el.sheetBody.innerHTML = '';

    const groups = [];
    Providers.forEach((p) => {
      let g = groups.find((x) => x.name === p.group);
      if (!g) { g = { name: p.group, items: [] }; groups.push(g); }
      g.items.push(p);
    });

    groups.forEach((g) => {
      const sec = document.createElement('section');
      sec.className = 'src-group';

      const h = document.createElement('h3');
      h.className = 'src-group-name';
      h.textContent = g.name;
      sec.appendChild(h);

      g.items.forEach((p) => sec.appendChild(sourceRow(p)));

      el.sheetBody.appendChild(sec);
    });

    const foot = document.createElement('p');
    foot.className = 'src-foot';
    foot.innerHTML =
      'API keys are stored in this browser only (localStorage) and are sent ' +
      'only to the service they belong to. Images load straight from each ' +
      'provider — nothing is uploaded to a server.';
    el.sheetBody.appendChild(foot);
  }

  function sourceRow(p) {
    const row = document.createElement('div');
    row.className = 'src-row';

    const needsKey = p.needsKey === 'required';
    const hasKey = !!Settings.key(p.id);
    const on = !Settings.isOff(p.id) && (!needsKey || hasKey);

    // Toggle
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'src-switch' + (on ? ' on' : '');
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', 'Enable ' + p.label);
    sw.addEventListener('click', () => {
      const next = !sw.classList.contains('on');
      Settings.setOff(p.id, !next);
      renderSources();
      if (state.query) runSearch(state.query, { replace: true });
    });

    const body = document.createElement('div');
    body.className = 'src-body';

    const head = document.createElement('div');
    head.className = 'src-head';
    const name = document.createElement('span');
    name.className = 'src-name';
    name.textContent = p.label;
    head.appendChild(name);

    if (needsKey && !hasKey) {
      const badge = document.createElement('span');
      badge.className = 'src-badge';
      badge.textContent = 'key needed';
      head.appendChild(badge);
    } else if (p.needsKey === 'optional') {
      const badge = document.createElement('span');
      badge.className = 'src-badge src-badge-soft';
      badge.textContent = 'optional key';
      head.appendChild(badge);
    }

    body.appendChild(head);

    if (p.needsKey !== 'none') {
      const keyRow = document.createElement('div');
      keyRow.className = 'src-key';

      const input = document.createElement('input');
      input.type = 'password';
      input.className = 'src-key-input';
      input.placeholder = 'API key';
      input.value = Settings.key(p.id);
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', p.label + ' API key');
      input.addEventListener('change', () => {
        Settings.setKey(p.id, input.value);
        renderSources();
        if (state.query) runSearch(state.query, { replace: true });
      });
      keyRow.appendChild(input);

      if (p.keyUrl) {
        const a = document.createElement('a');
        a.className = 'src-key-link';
        a.href = p.keyUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Get a free key ↗';
        keyRow.appendChild(a);
      }

      body.appendChild(keyRow);
    }

    if (p.keyHint) {
      const hint = document.createElement('p');
      hint.className = 'src-hint';
      hint.textContent = p.keyHint;
      body.appendChild(hint);
    }

    row.append(sw, body);
    return row;
  }

  function openSheet() {
    renderSources();
    el.sheet.hidden = false;
    requestAnimationFrame(() => el.sheet.classList.add('open'));
    el.sourcesBtn.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }

  function closeSheet() {
    el.sheet.classList.remove('open');
    el.sourcesBtn.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    setTimeout(() => { el.sheet.hidden = true; }, 260);
  }

  el.sourcesBtn.addEventListener('click', () => {
    if (el.sheet.hidden) openSheet(); else closeSheet();
  });
  el.sheetClose.addEventListener('click', closeSheet);
  el.sheet.addEventListener('click', (e) => {
    if (e.target === el.sheet) closeSheet();
  });

  /* ----------------------------------------------------------
     Viewer (full screen)
     ---------------------------------------------------------- */

  let viewerToken = 0;

  function openViewer(index) {
    if (index < 0 || index >= state.items.length) return;

    state.index = index;
    renderViewer();

    el.viewer.classList.add('open');
    el.viewer.classList.add('showing-ui');
    el.viewer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    scheduleIdle();
    preloadNeighbours();
  }

  function closeViewer() {
    viewerToken++;              // invalidate any pending upgrade
    el.viewer.classList.remove('open');
    el.viewer.classList.remove('showing-ui', 'idle');
    el.viewer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    el.viewerImg.classList.remove('ready');
    el.viewerImg.removeAttribute('src');
    state.index = -1;
    clearTimeout(idleTimer);
  }

  function renderViewer() {
    const item = state.items[state.index];
    if (!item) return;

    const token = ++viewerToken;

    const has = state.items.length > 1;
    el.viewerPrev.disabled = !has || state.index === 0;
    el.viewerNext.disabled = !has || state.index === state.items.length - 1;

    const credit = item.link
      ? '<a href="' + esc(item.link) + '" target="_blank" rel="noopener">' +
        esc(item.source || 'source') + '</a>'
      : esc(item.source || '');

    el.viewerCount.innerHTML =
      (state.index + 1) + ' / ' + state.items.length + ' · ' + credit;

    const show = (src, isLarge) => {
      el.viewerImg.classList.remove('ready');
      el.viewerLoading.hidden = isLarge;

      const probe = new Image();
      probe.referrerPolicy = 'no-referrer';
      probe.decoding = 'async';

      probe.onload = () => {
        if (token !== viewerToken) return;   // user navigated away
        el.viewerImg.src = src;
        el.viewerImg.alt = item.title || '';
        el.viewerImg.classList.add('ready');
        el.viewerLoading.hidden = true;
      };

      probe.onerror = () => {
        if (token !== viewerToken) return;
        if (isLarge && item.thumb && src !== item.thumb) {
          show(item.thumb, false);           // large failed → stay on thumb
          return;
        }
        el.viewerLoading.hidden = true;
      };

      probe.src = src;
    };

    // 1. Paint the grid thumbnail straight away — it is usually already
    //    in the browser cache, so the viewer opens instantly.
    if (item.thumb && item.thumb !== item.full) {
      show(item.thumb, false);
      // 2. Then quietly upgrade to the projection-sized file.
      if (item.large && item.large !== item.thumb) show(item.large, true);
    } else {
      show(item.full, true);
    }
  }

  function step(delta) {
    const next = state.index + delta;
    if (next < 0 || next >= state.items.length) return;
    state.index = next;
    renderViewer();
    preloadNeighbours();
    scheduleIdle();
  }

  function preloadNeighbours() {
    if (saveData) return;

    const job = () => {
      // One step ahead is enough; two mostly wastes bandwidth.
      [state.index + 1].forEach((i) => {
        const it = state.items[i];
        if (!it) return;
        const src = it.large || it.full;
        if (!src) return;
        const im = new Image();
        im.referrerPolicy = 'no-referrer';
        im.src = src;
      });
    };

    if ('requestIdleCallback' in window) requestIdleCallback(job, { timeout: 1200 });
    else setTimeout(job, 120);
  }

  function scheduleIdle() {
    el.viewer.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (el.viewer.classList.contains('open')) el.viewer.classList.add('idle');
    }, 2800);
  }

  el.viewer.addEventListener('mousemove', scheduleIdle);
  el.viewer.addEventListener('touchstart', scheduleIdle, { passive: true });

  /* Click anywhere on the black area closes */
  el.viewer.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    closeViewer();
  });

  el.viewerClose.addEventListener('click', closeViewer);
  el.viewerPrev.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
  el.viewerNext.addEventListener('click', (e) => { e.stopPropagation(); step(1); });

  /* Swipe on touch devices */
  let touchX = null;
  let touchY = null;

  el.viewer.addEventListener('touchstart', (e) => {
    if (!e.changedTouches.length) return;
    touchX = e.changedTouches[0].clientX;
    touchY = e.changedTouches[0].clientY;
  }, { passive: true });

  el.viewer.addEventListener('touchend', (e) => {
    if (touchX === null || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    touchX = touchY = null;

    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) {
      dx < 0 ? step(1) : step(-1);
    }
  }, { passive: true });

  /* ----------------------------------------------------------
     Keyboard
     ---------------------------------------------------------- */

  document.addEventListener('keydown', (e) => {
    const viewerOpen = el.viewer.classList.contains('open');
    const sheetOpen = !el.sheet.hidden;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

    if (sheetOpen && e.key === 'Escape') {
      e.preventDefault();
      closeSheet();
      return;
    }

    if (viewerOpen) {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          closeViewer();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          step(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          step(1);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleBrowserFullscreen();
          break;
      }
      return;
    }

    if (e.key === '/' && !typing) {
      e.preventDefault();
      el.input.focus();
      el.input.select();
    } else if (e.key === 'Escape' && document.activeElement === el.input) {
      el.input.blur();
    }
  });

  async function toggleBrowserFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (_) { /* not available */ }
  }

  /* ----------------------------------------------------------
     Search UI wiring
     ---------------------------------------------------------- */

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(el.input.value);
    el.input.blur();
  });

  let debounce = 0;
  el.input.addEventListener('input', () => {
    el.clear.hidden = !el.input.value;
    clearTimeout(debounce);
    // Live search after a short pause — feels instant, avoids rate limits
    debounce = setTimeout(() => {
      if (el.input.value.trim().length > 1) runSearch(el.input.value, { replace: true });
    }, 700);
  });

  el.clear.addEventListener('click', () => {
    el.input.value = '';
    el.clear.hidden = true;
    el.input.focus();
  });

  el.status.addEventListener('click', (e) => {
    if (e.target.matches('[data-retry]')) {
      if (e.target.textContent.trim() === 'Open sources') openSheet();
      else runSearch(state.query, { replace: true });
    }
  });

  /* Suggestion chips — recents first, then the starter set */
  function renderChips() {
    if (!el.chips) return;
    el.chips.innerHTML = '';

    const recents = Recents.all().filter(
      (r) => !SUGGESTIONS.some((s) => s.toLowerCase() === r.toLowerCase())
    );

    [...recents, ...SUGGESTIONS].forEach((word) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (recents.includes(word) ? ' chip-recent' : '');
      b.textContent = word;
      b.addEventListener('click', () => runSearch(word));
      el.chips.appendChild(b);
    });
  }

  /* ----------------------------------------------------------
     Infinite scroll
     ---------------------------------------------------------- */

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadMore();
    }, { rootMargin: '600px 0px' });
    io.observe(el.sentinel);
  } else {
    window.addEventListener('scroll', () => {
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 700) loadMore();
    }, { passive: true });
  }

  /* ----------------------------------------------------------
     Header auto-hide
     ---------------------------------------------------------- */

  window.addEventListener('scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      if (y > 140 && y > lastScrollY) {
        el.header.classList.add('hidden');
      } else if (y < lastScrollY || y < 80) {
        el.header.classList.remove('hidden');
      }
      lastScrollY = y;
      scrollTicking = false;
    });
  }, { passive: true });

  /* ----------------------------------------------------------
     URL sync  (?q=cats)
     ---------------------------------------------------------- */

  function syncURL() {
    try {
      const url = new URL(window.location.href);
      if (state.query) url.searchParams.set('q', state.query);
      else url.searchParams.delete('q');
      history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }
  }

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */

  (function boot() {
    renderChips();
    renderSources();

    let initial = '';
    try {
      initial = new URL(window.location.href).searchParams.get('q') || '';
    } catch (_) { /* ignore */ }

    if (initial.trim()) {
      runSearch(initial, { replace: true });
    } else {
      setEmpty(true);
      el.input.focus({ preventScroll: true });
    }
  })();

})();
