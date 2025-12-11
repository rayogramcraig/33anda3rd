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

function pickDiscogsResult(organic) {
  if (!organic || !Array.isArray(organic)) return null;
  return organic.find(
    (r) => r.link && r.link.includes("discogs.com")
  );
}

// First non-Discogs organic result – used as a "hint" (e.g., eBay)
function pickHintResult(organic) {
  if (!organic || !Array.isArray(organic)) return null;
  return organic.find(
    (r) => r.link && !r.link.includes("discogs.com")
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
    let debugInfo = {};

    // 1) First pass: restrict to Discogs
    let serp = await googleSearch(primaryGoogleQuery, apiKey);
    let organic = serp.organic_results || [];
    debugInfo.primaryOrganicCount = organic.length;

    let chosen = pickDiscogsResult(organic);

    // 2) Fallback: general Google search (no site: filter)
    if (!chosen) {
      const fallbackGoogleQuery = query;
      searchSource = "fallback";
      debugInfo.fallbackGoogleQuery = fallbackGoogleQuery;

      const serp2 = await googleSearch(fallbackGoogleQuery, apiKey);
      const organic2 = serp2.organic_results || [];
      debugInfo.fallbackOrganicCount = organic2.length;

      chosen = pickDiscogsResult(organic2);
      organic = organic2;

      // 2b) Still nothing from Discogs – use top non-Discogs result
      //     as a hint (e.g., eBay title), then re-search Discogs.
      if (!chosen) {
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
            const organic3 = serp3.organic_results || [];
            debugInfo.hintOrganicCount = organic3.length;

            const hintChosen = pickDiscogsResult(organic3);
            if (hintChosen) {
              chosen = hintChosen;
              organic = organic3;
              searchSource = "hint"; // mark that we used the hint flow
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
        debug: debugInfo, // keep for now; remove if you don't want it in the client
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
