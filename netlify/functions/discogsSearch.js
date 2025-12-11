// netlify/functions/discogsSearch.js

async function googleSearch(query, apiKey) {
  const serpUrl =
    "https://serpapi.com/search?engine=google&q=" +
    encodeURIComponent(query) +
    "&api_key=" +
    encodeURIComponent(apiKey);

  const res = await fetch(serpUrl);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `SerpAPI error ${res.status}: ${text.slice(0, 500)}`
    );
  }
  return res.json();
}

// Normal: look in organic_results for a Discogs hit
function pickDiscogsOrganic(organic) {
  if (!organic || !Array.isArray(organic)) return null;
  return organic.find((r) => {
    const link = r.link || "";
    const displayed = r.displayed_link || "";
    const source = r.source || "";
    return (
      /discogs\.com/i.test(link) ||
      /discogs\.com/i.test(displayed) ||
      /discogs/i.test(source)
    );
  });
}

// Fallback: if organic scan fails, scan the *entire* SERP JSON string
// for the first discogs.com URL and wrap it in a result-like object.
function pickDiscogsFromAny(serp, debugInfo, prefix) {
  if (!serp) return null;

  const organic = serp.organic_results || [];
  const organicHit = pickDiscogsOrganic(organic);
  if (organicHit) {
    debugInfo[`${prefix}DiscogsSource`] = "organic_results";
    return organicHit;
  }

  const text = JSON.stringify(serp);
  const match = text.match(/https?:\/\/[^"\\]*discogs\.com[^"\\]*/i);
  if (match) {
    const url = match[0];
    debugInfo[`${prefix}DiscogsSource`] = "json_scan";
    debugInfo[`${prefix}DiscogsUrlFromScan`] = url;
    return { link: url, title: null, thumbnail: null };
  }

  return null;
}

// First non-Discogs organic result – used as a "hint" (e.g., eBay)
function pickHintResult(organic) {
  if (!organic || !Array.isArray(organic)) return null;
  return organic.find(
    (r) => r.link && !/discogs\.com/i.test(r.link)
  );
}

// Try to extract artist + title from something like:
// "Newk's Time (Blue Note Classic Vinyl Series) by Rollins, Sonny (Record, 2023)"
// "Sonny Rollins - Newk's Time (Blue Note Classic Vinyl Series)"
function parseArtistAndTitleFromTitle(title) {
  if (!title) return null;

  // Remove parenthetical clutter like (Blue Note Classic Vinyl Series), (Record, 2023), etc.
  let base = title.replace(/\s*\([^)]*\)\s*/g, " ");

  // Remove common suffix noise words at the end
  base = base.replace(
    /\s+\b(LP|Vinyl|Record|CD|Cassette|Album|Blu[- ]?ray|Box Set)\b.*$/i,
    ""
  );

  base = base.trim();

  // Pattern 1: "Album by Artist"
  const byMatch = base.match(/^(.*?)\s+by\s+(.+?)$/i);
  if (byMatch) {
    const album = byMatch[1].trim();
    const artist = byMatch[2].trim();
    if (artist && album) return { artist, title: album };
  }

  // Pattern 2: "Artist - Album" or "Artist – Album"
  const dashMatch = base.match(/^(.+?)\s+[-–]\s+(.+?)$/);
  if (dashMatch) {
    const artist = dashMatch[1].trim();
    const album = dashMatch[2].trim();
    if (artist && album) return { artist, title: album };
  }

  // No robust pattern hit
  return null;
}

exports.handler = async (event, context) => {
  try {
    const query = event.queryStringParameters.query || "";
    if (!query) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing query parameter" }),
      };
    }

    const apiKey = process.env.SERPAPI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Missing SERPAPI_API_KEY environment variable",
        }),
      };
    }

    const primaryGoogleQuery = `site:discogs.com ${query}`;
    let searchSource = "primary";
    let discogsUrl = null;
    let title = null;
    let coverImage = null;
    const debugInfo = {};

    // 1) First pass: restrict to Discogs
    let serp = await googleSearch(primaryGoogleQuery, apiKey);
    debugInfo.primaryQuery = primaryGoogleQuery;
    debugInfo.primaryHasOrganic =
      !!serp.organic_results && serp.organic_results.length;

    let chosen = pickDiscogsFromAny(serp, debugInfo, "primary");

    // 2) Fallback: general Google search (no site: filter)
    if (!chosen) {
      const fallbackGoogleQuery = query;
      searchSource = "fallback";
      debugInfo.fallbackGoogleQuery = fallbackGoogleQuery;

      const serp2 = await googleSearch(fallbackGoogleQuery, apiKey);
      debugInfo.fallbackHasOrganic =
        !!serp2.organic_results && serp2.organic_results.length;

      chosen = pickDiscogsFromAny(serp2, debugInfo, "fallback");

      // 2b) Still nothing from Discogs – use top non-Discogs result
      //     as a hint (e.g., eBay title), then re-search Discogs.
      if (!chosen) {
        const organic2 = serp2.organic_results || [];
        const hint = pickHintResult(organic2);
        debugInfo.hintTitle = hint ? hint.title : null;
        debugInfo.hintLink = hint ? hint.link : null;

        if (hint && hint.title) {
          const parsed = parseArtistAndTitleFromTitle(hint.title);
          debugInfo.hintParsed = parsed;

          if (parsed) {
            const hintDiscogsQuery = `site:discogs.com "${parsed.artist}" "${parsed.title}"`;
            debugInfo.hintDiscogsQuery = hintDiscogsQuery;

            const serp3 = await googleSearch(hintDiscogsQuery, apiKey);
            debugInfo.hintHasOrganic =
              !!serp3.organic_results && serp3.organic_results.length;

            const hintChosen = pickDiscogsFromAny(
              serp3,
              debugInfo,
              "hint"
            );
            if (hintChosen) {
              chosen = hintChosen;
              searchSource = "hint";
            }
          }
        }
      }
    }

    if (!chosen || !chosen.link) {
      // Still no Discogs link found at all
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: "No Discogs link found in Google results",
          query,
          searchSource,
          debug: debugInfo,
        }),
      };
    }

    discogsUrl = chosen.link;
    title = chosen.title || null;
    coverImage = chosen.thumbnail || null;

    // 3) Try Discogs API for richer metadata
    let discogsJson = null;
    const releaseMatch = discogsUrl.match(/\/release\/(\d+)/);
    const masterMatch = discogsUrl.match(/\/master\/(\d+)/);

    const userAgent =
      "33anda3rd/1.0 +https://33anda3rd.netlify.app/";
    const discogsHeaders = { "User-Agent": userAgent };
    const discogsToken = process.env.DISCOGS_TOKEN; // optional

    if (discogsToken) {
      discogsHeaders["Authorization"] = `Discogs token=${discogsToken}`;
    }

    async function fetchDiscogsApi(path) {
      const res = await fetch("https://api.discogs.com" + path, {
        headers: discogsHeaders,
      });
      if (!res.ok) return null;
      return res.json();
    }

    if (releaseMatch) {
      const id = releaseMatch[1];
      discogsJson = await fetchDiscogsApi(`/releases/${id}`);
    } else if (masterMatch) {
      const id = masterMatch[1];
      discogsJson = await fetchDiscogsApi(`/masters/${id}`);
    }

    if (discogsJson) {
      if (!title && discogsJson.title) title = discogsJson.title;
      if (discogsJson.images && discogsJson.images.length > 0) {
        const img = discogsJson.images[0];
        coverImage = img.uri || img.uri150 || coverImage;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        query,
        searchSource,
        primaryGoogleQuery,
        discogsUrl,
        title,
        coverImage,
        debug: debugInfo, // keep for now; remove later if you want
      }),
    };
  } catch (err) {
    console.error("discogsSearch error", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal error",
        details: err.message,
      }),
    };
  }
};
