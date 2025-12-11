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
