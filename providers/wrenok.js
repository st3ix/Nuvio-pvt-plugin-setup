const API_BASE = 'https://api.purstream.ad/api/v1';
const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_KEY = (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY) || "307b7b8ef035c6aa336900aef4e203bd";
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Referer': 'https://purstream.ad/'
};
const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2 };

function getSortTag(rank) {
    let bin = Math.max(0, 4 - rank).toString(2);
    while (bin.length < 20) bin = '0' + bin;
    return bin.split('').map(b => b === '1' ? '\uFEFF' : '\u200B').join('');
}

function parseLang(n) {
    const up = (n || '').toUpperCase();
    if (up.includes('VOSTFR')) return 'VOSTFR';
    if (up.includes('VF')) return 'VF';
    return 'MULTI';
}

function parseQuality(n) {
    const up = (n || '').toUpperCase();
    if (up.includes('4K')) return '4K';
    if (up.includes('1080')) return '1080p';
    if (up.includes('720')) return '720p';
    return '1080p';
}

function buildTitle(title, quality, lang, format, season, episode) {
    const dispLang = lang === 'VOSTFR' ? 'VOSTFR' : lang === 'VF' ? 'VF' : 'MULTI';
    const fmt = (format || 'M3U8').toUpperCase();
    const line1 = (season != null && episode != null) ? `S${season} E${episode} | ${title}` : title;
    return `${line1}\n${[quality, dispLang, fmt].join(' | ')}`;
}

async function getEnglishTitle(tmdbId, mediaType) {
    try {
        const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
        const res = await fetch(
            `${TMDB_API}/${endpoint}/${tmdbId}?api_key=${TMDB_KEY}&language=en-US`
        );
        const data = await res.json();
        return data.title || data.name || '';
    } catch {
        return '';
    }
}

async function findIdByTitle(title, preferType) {
    const res = await fetch(
        `${API_BASE}/search-bar/search/${encodeURIComponent(title)}`,
        { headers: HEADERS }
    );
    const data = await res.json();
    const items = data?.data?.items?.movies?.items || [];
    if (!items.length) throw new Error('No search results');
    const match = items.find(i => i.type === preferType) || items[0];
    return match.id;
}

async function fetchMovieSources(id) {
    const res = await fetch(`${API_BASE}/media/${id}/sheet`, { headers: HEADERS });
    const data = await res.json();
    return data.data.items.urls || [];
}

async function fetchEpisodeSources(id, season, episode) {
    const res = await fetch(
        `${API_BASE}/stream/${id}/episode?season=${season}&episode=${episode}`,
        { headers: HEADERS }
    );
    const data = await res.json();
    return data.data.items.sources || [];
}

function normalizeMovieSources(urls, title) {
    return urls
        .filter(u => u.url && (u.url.match(/\.m3u8/i) || u.url.match(/\.mp4/i)))
        .map(u => {
            const q = parseQuality(u.name);
            const l = parseLang(u.name);
            const f = u.url.match(/\.mp4/i) ? 'mp4' : 'm3u8';
            const tag = getSortTag(QUALITY_RANK[q] || 1);
            const t = buildTitle(title, q, l, f);
            return {
                name: tag + `Purstream \u2022 French \u2022 English`,
                title: tag + `Purstream \u2022 French \u2022 English`,
                url: u.url,
                quality: q,
                headers: HEADERS
            };
        });
}

function normalizeEpisodeSources(sources, title, season, episode) {
    return sources.map(s => {
        const q = parseQuality(s.source_name);
        const l = parseLang(s.source_name);
        const tag = getSortTag(QUALITY_RANK[q] || 1);
        const t = buildTitle(title, q, l, s.format || 'm3u8', season, episode);
        return {
            name: tag + `Purstream \u2022 French \u2022 English`,
            title: tag + `Purstream \u2022 French \u2022 English`,
            url: s.stream_url,
            quality: q,
            headers: HEADERS
        };
    });
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        const isTv = mediaType === 'tv';
        if (isTv && (season == null || episode == null)) return [];

        const title = await getEnglishTitle(tmdbId, mediaType);
        if (!title) return [];

        const id = await findIdByTitle(title, isTv ? 'tv' : 'movie');

        const streams = isTv
            ? normalizeEpisodeSources(await fetchEpisodeSources(id, season, episode), title, season, episode)
            : normalizeMovieSources(await fetchMovieSources(id), title);

        const seen = new Set();
        return streams.filter(s => s.url && !seen.has(s.url) && seen.add(s.url));
    } catch {
        return [];
    }
}


// Eclipsia resolution cap: retain 720p and 480p streams without reordering.
// Streams with no explicit resolution metadata are left untouched (e.g. adaptive HLS).
const __eclipsiaOriginalGetStreams = getStreams;
getStreams = async function (...args) {
    const streams = await __eclipsiaOriginalGetStreams(...args);
    if (!Array.isArray(streams)) return streams;
    return streams.filter((stream) => {
        if (!stream || typeof stream !== "object") return false;
        const metadata = [
            stream.quality, stream._resolution, stream.resolution, stream.height,
            stream.title, stream.name, stream.filename, stream.fileName, stream.label,
            stream.description, stream.url
        ].filter((value) => value != null).map(String).join(" ").toLowerCase();
        const heights = [];
        for (const match of metadata.matchAll(/(?:^|[^0-9])(2160|1440|1080|720|480|360|240)\s*p(?:\b|$)/gi)) {
            heights.push(Number(match[1]));
        }
        for (const match of metadata.matchAll(/(?:^|[^0-9])(4k)(?:\b|$)/gi)) heights.push(2160);
        for (const match of metadata.matchAll(/(?:^|[^0-9])\d{3,4}\s*x\s*(2160|1440|1080|720|480|360|240)(?:\b|$)/gi)) {
            heights.push(Number(match[1]));
        }
        if (typeof stream.height === "number" && stream.height > 0) heights.push(stream.height);
        if (!heights.length) return false;
        const height = Math.max(...heights);
        return height === 720 || height === 480;
    });
};

module.exports = { getStreams };