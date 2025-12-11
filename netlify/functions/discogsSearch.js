// netlify/functions/discogsSearch.js

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

    // 1) Ask Google (via SerpAPI) for the top Discogs result
    const googleQuery = `site:discogs.com ${query}`;
    const serpUrl =
      "https://serpapi.com/search?engine=google&q=" +
      encodeURIComponent(googleQuery) +
      "&api_key=" +
      encodeURIComponent(apiKey);

    const serpRes = await fetch(serpUrl);
    if (!serpRes.ok) {
      const text = await serpRes.text();
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: "SerpAPI error",
          status: serpRes.status,
          body: text,
        }),
      };
    }
    const serp = await serpRes.json();

    const organic = serp.organic_results || [];
    const firstDiscogs = organic.find(
      (r) => r.link && r.link.includes("discogs.com")
    );

    if (!firstDiscogs) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: "No Discogs result found",
          googleQuery,
        }),
      };
    }

    let discogsUrl = firstDiscogs.link;
    let title = firstDiscogs.title || null;
    let coverImage = firstDiscogs.thumbnail || null;

    // 2) Try Discogs API to get better cover/title
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
      return await res.json();
    }

    if (releaseMatch) {
      const id = releaseMatch[1];
      discogsJson = await fetchDiscogsApi(`/releases/${id}`);
    } else if (masterMatch) {
      const id = masterMatch[1];
      discogsJson = await fetchDiscogsApi(`/masters/${id}`);
    }

    if (discogsJson) {
      if (!title && discogsJson.title) {
        title = discogsJson.title;
      }
      if (discogsJson.images && discogsJson.images.length > 0) {
        const img = discogsJson.images[0];
        coverImage = img.uri || img.uri150 || coverImage;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        query,
        googleQuery,
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
