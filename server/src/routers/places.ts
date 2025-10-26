// routers/places.ts
import express from "express";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" }); // load local env if present

const router = express.Router();

/**
 * POST /api/places/search  (legacy Places Web Service)
 * Body:
 * {
 *   query: string,
 *   locationBias?: { lat:number, lng:number, radiusMeters?:number },
 *   maxResults?: number
 * }
 *
 * Response:
 * {
 *   place?: {
 *     id?: string; // place_id
 *     displayName?: { text?: string };
 *     formattedAddress?: string;
 *     location?: { latitude: number; longitude: number };
 *     googleMapsUri?: string;
 *     photoUrl?: string; // resolved via legacy Photo API (302 Location)
 *   }
 * }
 */
router.post("/search", async (req, res) => {
  try {
    const { query, locationBias, maxResults = 3 } = req.body ?? {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing 'query' string." });
    }

    const key = process.env.PLACES_API_KEY;
    if (!key) {
      return res.status(500).json({ error: "Missing PLACES_API_KEY on server." });
    }

    // --- Legacy Text Search ---
    // Docs: https://developers.google.com/maps/documentation/places/web-service/search-text
    const params = new URLSearchParams({
      query,
      key,
      language: "en",
    });

    // Optional biasing around a lat/lng + radius
    if (locationBias?.lat && locationBias?.lng) {
      params.set("location", `${locationBias.lat},${locationBias.lng}`);
      params.set("radius", String(Math.max(200, Math.min(locationBias.radiusMeters ?? 2500, 50000))));
    }

    // We’ll fetch and then pick the first with a valid photo; otherwise first result
    const tsUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`;
    const tsResp = await fetch(tsUrl);
    if (!tsResp.ok) {
      const errTxt = await tsResp.text().catch(() => "");
      return res.status(tsResp.status).json({ error: `legacy textsearch failed: ${errTxt}` });
    }
    const tsJson = (await tsResp.json().catch(() => ({}))) as any;
    const results: any[] = Array.isArray(tsJson?.results) ? tsJson.results : [];
    if (results.length === 0) {
      return res.json({ place: null });
    }

    // Helper: resolve a legacy photo URL by following the 302 Location
    // Docs: https://developers.google.com/maps/documentation/places/web-service/legacy/photos
    const resolveLegacyPhotoUrl = async (
      photo_reference: string,
      opts?: { maxWidth?: number; maxHeight?: number }
    ): Promise<string | undefined> => {
      const p = new URLSearchParams({ key, photo_reference });
      if (opts?.maxWidth) p.set("maxwidth", String(opts.maxWidth));
      if (opts?.maxHeight && !opts?.maxWidth) p.set("maxheight", String(opts.maxHeight));
      const photoEndpoint = `https://maps.googleapis.com/maps/api/place/photo?${p.toString()}`;

      // Try to capture the 302 Location without downloading the image
      const resp = await fetch(photoEndpoint, { redirect: "manual" });
      // Some environments still follow; fall back to resp.url if Location missing
      const loc = resp.headers.get("location");
      if (loc) return loc;

      // If redirect was auto-followed, resp.url should be the CDN image URL
      if (resp.ok && resp.url && !resp.url.includes("place/photo")) {
        return resp.url;
      }

      // As a last resort, try a normal GET (follow) and return the final URL
      const follow = await fetch(photoEndpoint, { redirect: "follow" });
      if (follow.ok && follow.url && !follow.url.includes("place/photo")) {
        return follow.url;
      }
      return undefined;
    };

    // Prefer the first result that has a photo; otherwise pick results[0]
    let chosen = results[0];
    let photoUrl: string | undefined;

    for (const r of results.slice(0, Math.max(1, Math.min(10, maxResults)))) {
      const photoRef: string | undefined = r?.photos?.[0]?.photo_reference;
      if (photoRef) {
        try {
          const url = await resolveLegacyPhotoUrl(photoRef, { maxWidth: 640 });
          if (url) {
            chosen = r;
            photoUrl = url;
            break;
          }
        } catch {
          // non-fatal, try the next candidate
        }
      }
    }

    // Shape output to match your frontend expectations
    const out = {
      id: chosen?.place_id,
      displayName: chosen?.name ? { text: chosen.name } : undefined,
      formattedAddress: chosen?.formatted_address,
      location: chosen?.geometry?.location
        ? {
            latitude: chosen.geometry.location.lat,
            longitude: chosen.geometry.location.lng,
          }
        : undefined,
      googleMapsUri: chosen?.place_id
        ? `https://www.google.com/maps/place/?q=place_id:${chosen.place_id}`
        : undefined,
      ...(photoUrl ? { photoUrl } : {}),
    };

    return res.json({ place: out });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "places.search server error" });
  }
});

export const places = router;
