const BASE_URL = "https://anilight.live";
const API_BASE = "https://api.anilight.live/api";
const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_KEY = (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY) || "307b7b8ef035c6aa336900aef4e203bd";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const SUB_LANGS = {
    ar: "Arabic", baq: "Basque", cat: "Catalan", cze: "Czech", dan: "Danish", de: "German",
    dut: "Dutch", en: "English", es: "Spanish", fil: "Filipino", fin: "Finnish", fr: "French",
    glg: "Galician", gre: "Greek", heb: "Hebrew", hrv: "Croatian", hun: "Hungarian",
    id: "Indonesian", it: "Italian", ja: "Japanese", ko: "Korean", may: "Malay",
    nob: "Norwegian", pol: "Polish", pt: "Portuguese", ro: "Romanian", ru: "Russian",
    rum: "Romanian", swe: "Swedish", th: "Thai", tur: "Turkish", ukr: "Ukrainian",
    vi: "Vietnamese", zh: "Chinese"
};

let cachedSessionToken = null;

function buildHeaders(extraHeaders) {
    return Object.assign({
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `${BASE_URL}/`
    }, extraHeaders);
}

async function safeFetch(url, options) {
    try {
        const response = await fetch(url, options);
        return response.status !== 0 ? response : null;
    } catch (error) {
        return null;
    }
}

async function readJson(response) {
    if (!response || !response.ok) return null;
    try {
        return await response.json();
    } catch (error) {
        return null;
    }
}

async function fetchJson(url, headers) {
    return readJson(await safeFetch(url, { headers: headers || buildHeaders() }));
}

async function ensureSession(forceRefresh) {
    if (!forceRefresh && cachedSessionToken) return cachedSessionToken;

    const payload = await readJson(await safeFetch(`${API_BASE}/sources/verify`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ token: "direct" })
    }));
    if (payload && typeof payload.sessionToken === "string" && payload.sessionToken) {
        cachedSessionToken = payload.sessionToken;
    }
    return cachedSessionToken;
}

async function searchTitles(query) {
    const results = await fetchJson(`${API_BASE}/search?q=${encodeURIComponent(query)}&hideAdult=true`);
    return Array.isArray(results) ? results.filter((media) => media && media.isAdult !== true) : [];
}

async function fetchSources(animeId, episode, language, useBackup) {
    const url = `${API_BASE}/sources?id=${animeId}&episode=${episode}&language=${language}${useBackup ? "&backup=true" : ""}`;

    for (const forceRefresh of [false, true]) {
        const sessionToken = await ensureSession(forceRefresh);
        if (!sessionToken) return null;

        const response = await safeFetch(url, { headers: buildHeaders({ "x-source-session": sessionToken }) });
        if (response && response.status !== 401 && response.status !== 403) return readJson(response);
    }
    return null;
}

function extractTokens(entry) {
    return [].concat((entry && entry.url) || []).filter((token) => typeof token === "string" && token.trim());
}

async function resolveStreamUrl(token) {
    const balancerUrl = `${API_BASE}/lb/e/${token}`;
    const response = await safeFetch(balancerUrl, { headers: buildHeaders(), redirect: "manual" });
    if (!response) return null;

    const location = (response.headers.get("location") || "").trim();
    if (/^https?:\/\//i.test(location)) return location;
    if (response.status >= 300 && response.status < 400) return balancerUrl;
    if (response.ok) return (response.url && response.url !== balancerUrl) ? response.url : balancerUrl;
    return null;
}

async function probeHlsPlaylist(url) {
    const response = await safeFetch(url, { headers: buildHeaders() });
    if (!response || !response.ok) return null;

    let playlist;
    try {
        playlist = await response.text();
    } catch (error) {
        return null;
    }
    if (!playlist || playlist.replace(/^\uFEFF/, "").indexOf("#EXTM3U") !== 0) return null;

    const heights = [...playlist.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((match) => parseInt(match[1], 10));
    return { url: url, height: Math.max(0, ...heights) || null };
}

function formatLanguageLabel(rawLabel) {
    const label = String(rawLabel || "").trim();
    if (/[\sA-Z]/.test(label)) return label;

    const [code, ...variantParts] = label.split("-");
    const languageName = SUB_LANGS[code.toLowerCase()];
    if (!languageName || !variantParts.length) return languageName || label;

    const variant = { signs: "Signs", sdh: "SDH" }[variantParts[0]] || variantParts.join("-");
    return `${languageName} (${variant})`;
}

function collectSubtitleTracks(tracks) {
    const seenLabels = new Set();
    const subtitles = [];

    tracks.forEach((track) => {
        if (!track || (track.kind && track.kind !== "captions")) return;

        const token = typeof track.url === "string" ? track.url.trim() : "";
        const rawLabel = (track.label && String(track.label).trim()) || (track.lang && String(track.lang).trim());
        if (!token || !rawLabel) return;

        const label = formatLanguageLabel(rawLabel);
        if (seenLabels.has(label.toLowerCase())) return;
        seenLabels.add(label.toLowerCase());

        subtitles.push({
            url: `${API_BASE}/proxy/captions?token=${encodeURIComponent(token)}`,
            language: label,
            name: label
        });
    });
    return subtitles;
}

function normalizeTitle(title) {
    return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getTitleVariants(media) {
    const title = media.title || {};
    return [title.english, title.romaji, title.userPreferred, title.native].filter(Boolean);
}

function getNormalizedTitles(media) {
    return getTitleVariants(media).map(normalizeTitle).filter(Boolean);
}

function parseSeasonNumber(title) {
    const text = String(title || "").toLowerCase();
    let match = text.match(/season\s*(\d+)/) || text.match(/(\d+)(?:st|nd|rd|th)\s*season/);
    if (match) return parseInt(match[1], 10);

    match = text.match(/\b(ii|iii|iv|v)\b\s*$/);
    return match ? { ii: 2, iii: 3, iv: 4, v: 5 }[match[1]] : null;
}

function findSeasonNumber(media) {
    return getTitleVariants(media).map(parseSeasonNumber).find((season) => season != null);
}

function scoreMatch(media, target) {
    const targetNames = target.names.map(normalizeTitle).filter(Boolean);

    let score = 0;
    getNormalizedTitles(media).forEach((title) => {
        targetNames.forEach((name) => {
            if (title === name) score = Math.max(score, 10);
            else if (title.startsWith(name) || name.startsWith(title)) score = Math.max(score, 6);
            else if (title.includes(name) || name.includes(title)) score = Math.max(score, 4);
        });
    });
    if (score === 0) return 0;

    if (target.year && media.seasonYear) {
        const yearDelta = Math.abs(media.seasonYear - target.year);
        score += yearDelta === 0 ? 5 : yearDelta === 1 ? 2 : -3;
    }

    if (target.mediaType === "movie") {
        score += media.format === "MOVIE" ? 4 : -4;
    } else if (media.format === "MOVIE") {
        score -= 3;
    }

    if (target.mediaType === "tv") {
        const candidateSeason = findSeasonNumber(media);
        if (target.season > 1) {
            if (candidateSeason === target.season) score += 6;
            else if (candidateSeason != null) score -= 4;
        } else if (candidateSeason != null && candidateSeason > 1) {
            score -= 4;
        }
    }
    return score;
}

async function fetchTmdbMetadata(tmdbId, mediaType, season) {
    const isTv = mediaType === "tv";
    const query = `?api_key=${TMDB_KEY}&language=en-US`;
    const headers = { "User-Agent": USER_AGENT };

    const [details, seasonDetails] = await Promise.all([
        fetchJson(`${TMDB_API}/${isTv ? "tv" : "movie"}/${tmdbId}${query}`, headers),
        isTv && season != null ? fetchJson(`${TMDB_API}/tv/${tmdbId}/season/${season}${query}`, headers) : null
    ]);
    if (!details) return null;

    const dateString = isTv
        ? ((seasonDetails && seasonDetails.air_date) || details.first_air_date || "")
        : (details.release_date || "");
    const names = [...new Set((isTv
        ? [details.name, details.original_name]
        : [details.title, details.original_title]).filter(Boolean))];

    const episodes = (seasonDetails && Array.isArray(seasonDetails.episodes)) ? seasonDetails.episodes : [];
    const episodeAirTimes = {};
    episodes.forEach((episode) => {
        const airTime = Date.parse(episode && episode.air_date);
        if (!isNaN(airTime)) episodeAirTimes[episode.episode_number] = airTime;
    });
    const airTimes = Object.values(episodeAirTimes);

    return {
        names: names,
        year: parseInt(String(dateString).slice(0, 4), 10) || null,
        seasonName: seasonDetails && seasonDetails.name ? seasonDetails.name : null,
        episodeCount: episodes.length || null,
        windowStart: airTimes.length ? Math.min(...airTimes) : null,
        windowEnd: airTimes.length ? Math.max(...airTimes) : null,
        episodeAirTimes: episodeAirTimes
    };
}

async function findMatches(metadata, mediaType, season, episode) {
    const queries = new Set(metadata.names);

    if (mediaType === "tv" && season > 1) {
        metadata.names.forEach((name) => queries.add(`${name} Season ${season}`));
        if (metadata.seasonName && !/^season\s*\d+$/i.test(metadata.seasonName)) {
            queries.add(`${metadata.names[0]} ${metadata.seasonName}`);
            queries.add(metadata.seasonName);
        }
    }

    if (mediaType === "tv" && ((metadata.episodeCount && metadata.episodeCount > 14) || (episode && episode > 14))) {
        ["Part 2", "Part 3", "2nd Cour", "Cour 2", "Season 2"].forEach((suffix) => {
            queries.add(`${metadata.names[0]} ${suffix}`);
        });
    }

    const searchResults = await Promise.all([...queries].slice(0, 9).map(searchTitles));
    const mediaById = new Map(searchResults.flat().filter((media) => media && media.id != null).map((media) => [media.id, media]));
    const allMedia = [...mediaById.values()];

    const target = {
        names: metadata.names.concat(metadata.seasonName || []),
        year: metadata.year,
        mediaType: mediaType,
        season: season || 1
    };
    const ranked = allMedia
        .map((media) => ({ media: media, score: scoreMatch(media, target) }))
        .filter((candidate) => candidate.score >= 10)
        .sort((a, b) => b.score - a.score);

    return { ranked: ranked, all: allMedia };
}

function getStartTimestamp(media) {
    const date = media.startDate;
    return date && date.year ? Date.UTC(date.year, (date.month || 1) - 1, date.day || 1) : null;
}

function buildCourGroup(allMedia, topMatch, metadata, season) {
    const targetNames = metadata.names.map(normalizeTitle).filter(Boolean);

    const group = allMedia.filter((media) => {
        if (media.format === "MOVIE") return false;
        if (media.id === topMatch.id) return true;

        const startsWithTarget = getNormalizedTitles(media).some((title) =>
            targetNames.some((name) => title.startsWith(name) || name.startsWith(title)));
        if (!startsWithTarget) return false;

        const candidateSeason = findSeasonNumber(media);
        if (season > 1 ? (candidateSeason != null && candidateSeason !== season) : (candidateSeason != null && candidateSeason > 1)) {
            return false;
        }

        const startTimestamp = getStartTimestamp(media);
        if (startTimestamp == null) return false;

        if (metadata.windowStart != null) {
            return startTimestamp >= metadata.windowStart - 60 * 86400000
                && startTimestamp <= metadata.windowEnd + 60 * 86400000;
        }
        return metadata.year ? Math.abs(new Date(startTimestamp).getUTCFullYear() - metadata.year) <= 1 : false;
    });

    return group.sort((a, b) => (getStartTimestamp(a) || 0) - (getStartTimestamp(b) || 0));
}

function mapEpisodeToCour(courGroup, metadata, episode) {
    if (courGroup.length < 2) return null;

    let episodeOffset = 0;
    for (let index = 0; index < courGroup.length; index++) {
        const courEpisodeCount = courGroup[index].episodes;
        const isLast = index === courGroup.length - 1;

        if (courEpisodeCount == null && !isLast) break;
        if (isLast || episode <= episodeOffset + courEpisodeCount) {
            if (episode > episodeOffset) return { id: courGroup[index].id, episode: episode - episodeOffset };
            break;
        }
        episodeOffset += courEpisodeCount;
    }

    const airTime = metadata.episodeAirTimes[episode];
    if (airTime == null) return null;

    let matchedCour = null;
    courGroup.forEach((media) => {
        const startTimestamp = getStartTimestamp(media);
        if (startTimestamp != null && startTimestamp <= airTime + 30 * 86400000) matchedCour = media;
    });
    if (!matchedCour) return null;

    let episodesBefore = 0;
    for (let index = 0; courGroup[index].id !== matchedCour.id; index++) {
        episodesBefore += courGroup[index].episodes || 0;
    }
    return episode > episodesBefore ? { id: matchedCour.id, episode: episode - episodesBefore } : null;
}

function parseHeight(qualityLabel) {
    const height = parseInt(String(qualityLabel || "").replace(/\D/g, ""), 10);
    return height >= 100 && height <= 4320 ? height : null;
}

async function buildStreams(animeId, episode, language) {
    const isDub = language === "dub";
    const audioName = isDub ? "English" : "Japanese";
    const streams = [];
    const seenUrls = new Set();

    function addStream(provider, url, height, isHls) {
        if (seenUrls.has(url) || (height && height !== 1080)) return;
        seenUrls.add(url);

        const label = `${provider} \u2022 ${audioName}`;
        const stream = {
            name: label,
            title: label,
            url: url,
            quality: height ? `${height}p` : "Auto",
        };
        if (isHls) stream.type = "hls";
        streams.push(stream);
    }

    const [primary, backup] = await Promise.all([
        fetchSources(animeId, episode, language, false),
        fetchSources(animeId, episode, language, true)
    ]);

    const primaryStreams = await Promise.all(((primary && primary.sources) || []).map(async (entry) => {
        const token = extractTokens(entry)[0];
        const url = token && await resolveStreamUrl(token);
        return url ? { url: url, height: parseHeight(entry.quality) } : null;
    }));
    primaryStreams.forEach((stream) => stream && addStream("AniLight", stream.url, stream.height, false));

    let backupPlaylist = null;
    for (const entry of (backup && backup.sources) || []) {
        const playlists = await Promise.all(extractTokens(entry).map(async (token) => {
            const url = await resolveStreamUrl(token);
            return url && probeHlsPlaylist(url);
        }));
        backupPlaylist = playlists.find((playlist) => playlist && (!playlist.height || playlist.height === 1080));
        if (backupPlaylist) break;
    }
    if (backupPlaylist) addStream("MegaPlay", backupPlaylist.url, null, true);

    const subtitles = collectSubtitleTracks([...((primary && primary.tracks) || []), ...((backup && backup.tracks) || [])]);
    if (subtitles.length) streams.forEach((stream) => { stream.subtitles = subtitles; });
    return streams;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        const isTv = mediaType === "tv";
        if (!/^\d+$/.test(String(tmdbId)) || (!isTv && mediaType !== "movie") || (isTv && (season == null || episode == null))) {
            return [];
        }

        const metadata = await fetchTmdbMetadata(tmdbId, mediaType, isTv ? season : null);
        if (!metadata || !metadata.names.length) return [];

        const matches = await findMatches(metadata, mediaType, season, episode);
        if (!matches.ranked.length) return [];

        const attempts = new Map();
        function addAttempt(animeId, targetEpisode) {
            attempts.set(`${animeId}:${targetEpisode}`, { animeId: animeId, episode: targetEpisode });
        }

        const topMatches = matches.ranked.slice(0, 2).map((candidate) => candidate.media);
        if (isTv) {
            const courMapping = mapEpisodeToCour(buildCourGroup(matches.all, topMatches[0], metadata, season), metadata, episode);
            if (courMapping) addAttempt(courMapping.id, courMapping.episode);
        }
        topMatches.forEach((media) => addAttempt(media.id, isTv ? episode : 1));

        for (const attempt of attempts.values()) {
            const streamLists = await Promise.all(["sub", "dub"].map((language) =>
                buildStreams(attempt.animeId, attempt.episode, language)));

            const seenUrls = new Set();
            const uniqueStreams = streamLists.flat().filter((stream) => !seenUrls.has(stream.url) && seenUrls.add(stream.url));
            if (uniqueStreams.length) return uniqueStreams;
        }
        return [];
    } catch (error) {
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