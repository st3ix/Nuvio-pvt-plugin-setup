const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_KEY = (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY) || "307b7b8ef035c6aa336900aef4e203bd";
const API_BASE = "https://streamdata.vaplayer.ru";
const REFERER = "https://nextgencloudfabric.com/";
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    "Referer": REFERER,
    "Origin": REFERER,
};

async function fetchImdbId(tmdbId, mediaType) {
    try {
        const endpoint = mediaType === "tv" ? "tv" : "movie";
        const url = `${TMDB_API}/${endpoint}/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=external_ids`;
        const res = await fetch(url, { headers: { "User-Agent": HEADERS["User-Agent"], "Accept": "application/json" } });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.external_ids?.imdb_id || null;
    } catch {
        return null;
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        if (mediaType === "tv" && (season == null || episode == null)) return [];

        const imdbId = await fetchImdbId(tmdbId, mediaType);
        if (!imdbId) return [];

        const url = (season != null && episode != null)
            ? `${API_BASE}/api.php?imdb=${imdbId}&type=tv&season=${season}&episode=${episode}`
            : `${API_BASE}/api.php?imdb=${imdbId}&type=movie`;

        const res = await fetch(url, { headers: { ...HEADERS, "Accept": "application/json" } });
        if (!res.ok) return [];

        const data = await res.json();
        if (!data || data.status_code === "error" || !data.data) return [];

        let rawItems = [];
        if (Array.isArray(data.data.stream_urls)) {
            rawItems = data.data.stream_urls;
        } else if (typeof data.data.stream_urls === "object" && data.data.stream_urls !== null) {
            rawItems = Object.values(data.data.stream_urls);
        } else if (data.data.stream_url) {
            rawItems = [data.data.stream_url];
        }

        const streamMap = new Map();

        for (const item of rawItems) {
            let streamUrl = "";

            if (typeof item === "string") {
                streamUrl = item;
            } else if (item && typeof item === "object") {
                streamUrl = item.url || item.file || item.src || "";
            } else {
                continue;
            }

            if (!streamUrl) continue;

            const cleanUrl = streamUrl.trim().replace(/\/+$/, "");
            if (!streamMap.has(cleanUrl)) {
                streamMap.set(cleanUrl, cleanUrl);
            }
        }

        if (streamMap.size === 0) return [];

        const subs = data.data.default_subs || data.default_subs || [];
        const subtitles = (Array.isArray(subs) ? subs : [])
            .filter(s => s.url)
            .map(s => ({
                url: s.url,
                language: s.code || s.lang || "unknown",
                name: s.lang || s.code || "Unknown",
            }));

        return [...streamMap.values()].map(url => ({
            name: "VAplayer",
            title: "VAplayer",
            url,
            quality: "1080p",
            headers: HEADERS,
            subtitles,
        }));
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