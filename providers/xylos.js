const BASE_URL = "https://anikage.cc";
const API_BASE = "https://anikage.cc/api/media/anime";
const BKY_BASE = "https://og.bakayaro.live";
const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_KEY = (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY) || "307b7b8ef035c6aa336900aef4e203bd";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const SOURCES = ["koto", "kiwi", "wave"];
const LANGS = ["sub", "dub"];

const J_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
    "Referer": BASE_URL + "/",
    "Origin": BASE_URL,
};

const S_HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": BASE_URL + "/",
    "Origin": BASE_URL,
};

async function getJson(url) {
    try {
        const res = await fetch(url, { headers: J_HEADERS });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

async function getTmdbDetails(tmdbId, mediaType, season) {
    const endpoint = mediaType === "tv" ? "tv" : "movie";
    const [showData, seasonData] = await Promise.all([
        getJson(`${TMDB_API}/${endpoint}/${tmdbId}?api_key=${TMDB_KEY}`),
        mediaType === "tv" && season != null
            ? getJson(`${TMDB_API}/tv/${tmdbId}/season/${season}?api_key=${TMDB_KEY}`)
            : Promise.resolve(null),
    ]);
    if (!showData) return null;
    const title = mediaType === "tv" ? (showData.name || "") : (showData.title || "");
    const seasonName = seasonData && seasonData.name
        && seasonData.name.toLowerCase() !== `season ${season}`
        ? seasonData.name.trim()
        : null;
    return { title, seasonName };
}

function pickTitle(t) {
    t = t || {};
    return (t.english || t.romaji || t.native || "").trim();
}

async function searchSlug(query) {
    const data = await getJson(`${API_BASE}/search?q=${encodeURIComponent(query)}&limit=5`);
    const results = (data && data.data) || [];
    if (!results.length) return null;
    const q = query.toLowerCase();
    for (const r of results) {
        if (pickTitle(r.title).toLowerCase() === q) return r.slug;
    }
    return results[0].slug || null;
}

async function findSlug(title, season, seasonName) {
    const queries = [];
    if (seasonName) queries.push(seasonName);
    if (season != null && season > 1) queries.push(`${title} Season ${season}`);
    queries.push(title);
    for (const q of queries) {
        const slug = await searchSlug(q);
        if (slug) return slug;
    }
    return null;
}

async function fetchSources(slug, episode, provider, lang) {
    try {
        const data = await getJson(
            `${API_BASE}/${slug}/episodes/${episode}/sources?lang=${lang}&provider=${provider}`
        );
        if (!data) return [];

        const subtitles = (data.subtitles || [])
            .filter(s => s && s.file)
            .map(s => ({
                url: `${BKY_BASE}/stream/${s.file}`,
                language: s.label || "Subtitle",
                headers: S_HEADERS,
            }));

        const langLabel = lang === "dub" ? "English" : "Japanese";
        const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);

        return (data.sources || [])
            .filter(s => s && s.url)
            .map(s => {
                const isHls = s.isM3U8 !== false;
                return {
                    name: `AniKage \u2022 ${providerLabel} \u2022 ${langLabel}`,
                    title: `AniKage \u2022 ${providerLabel} \u2022 ${langLabel}`,
                    url: `${BKY_BASE}${isHls ? "/m3u8/" : "/stream/"}${s.url}`,
                    quality: "1080p",
                    headers: S_HEADERS,
                    subtitles: subtitles,
                };
            });
    } catch {
        return [];
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        if (mediaType === "tv" && (season == null || episode == null)) return [];
        const details = await getTmdbDetails(tmdbId, mediaType, season);
        if (!details || !details.title) return [];
        const slug = await findSlug(details.title, season, details.seasonName);
        if (!slug) return [];
        const epNum = mediaType === "movie" ? 1 : episode;
        const results = await Promise.all(
            SOURCES.flatMap(p => LANGS.map(l => fetchSources(slug, epNum, p, l)))
        );
        const seen = new Set();
        return results.flat().filter(s => s.url && !seen.has(s.url) && seen.add(s.url));
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