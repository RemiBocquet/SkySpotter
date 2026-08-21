// SkySpotter — worker v9 : relais CORS, routes par GET (anti bot-challenge),
// secours HexDB indépendant, caches routes + aéroports.
//
// Changements de la v9 :
//   - User-Agent explicite sur tous les appels amont. airplanes.live rejette
//     les requêtes anonymes venant de centres de données, ce qui faisait
//     échouer les trois sources et renvoyer un 403 trompeur au navigateur.
//   - En cas d'échec total, réponse 502 avec le détail de chaque source,
//     au lieu de relayer le statut de la dernière (qui laissait croire que
//     le Worker lui-même refusait la requête).
//   - CORS restreint à une liste d'origines au lieu de « * ».
//   - Coordonnées validées avant d'être insérées dans les URL amont.

const ORIGINES = [
  "https://skyspotter.remibocquet.fr",
  "https://remibocquet.github.io",   // tant que GitHub Pages sert encore
  "http://localhost:8000",           // mise au point locale
];

const UA = "SkySpotter/9 (+https://skyspotter.remibocquet.fr)";
// ===========================================================================

const ROUTE_CACHE = new Map();   // callsign -> objet route (JSON string)
const AIRPORT_CACHE = new Map(); // icao -> objet aéroport (JSON string)
const CACHE_MAX = 1000;

// En-têtes envoyés aux API amont. Sans User-Agent, plusieurs d'entre elles
// répondent 403 à un appel venant d'un centre de données.
const AMONT = { Accept: "application/json", "User-Agent": UA };

/* CORS : l'origine n'est renvoyée que si elle figure dans la liste. Une page
   tierce ne peut donc plus lire les réponses de ce relais depuis le
   navigateur d'un visiteur. `Vary: Origin` évite qu'un cache serve à un
   demandeur l'en-tête calculé pour un autre. */
function cors(request) {
  const entetes = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  const origine = request.headers.get("Origin");
  if (origine && ORIGINES.includes(origine)) {
    entetes["Access-Control-Allow-Origin"] = origine;
  }
  return entetes;
}

const json = (request, body, status = 200, extra = {}) =>
  new Response(body, {
    status,
    headers: { ...cors(request), "Content-Type": "application/json", ...extra },
  });

// Un nombre, et rien d'autre : ces valeurs partent dans une URL amont.
const nombre = (s) => (/^-?\d{1,3}(\.\d{1,6})?$/.test(s) ? s : null);

function capPut(map, key, val) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
  map.set(key, val);
}

async function edgeGet(kind, key) {
  try {
    const hit = await caches.default.match(
      new Request(`https://skyspotter.cache/${kind}/` + encodeURIComponent(key))
    );
    return hit ? await hit.text() : null;
  } catch (e) {
    return null;
  }
}

function edgePut(kind, key, body, ctx, maxAge) {
  try {
    ctx.waitUntil(
      caches.default.put(
        new Request(`https://skyspotter.cache/${kind}/` + encodeURIComponent(key)),
        new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=" + (maxAge || 86400),
          },
        })
      )
    );
  } catch (e) {}
}

async function getAirport(icao, ctx) {
  let body = AIRPORT_CACHE.get(icao) || (await edgeGet("airport", icao));
  if (!body) {
    try {
      const r = await fetch(
        "https://hexdb.io/api/v1/airport/icao/" + encodeURIComponent(icao),
        { headers: AMONT }
      );
      if (!r.ok) return null;
      body = await r.text();
      capPut(AIRPORT_CACHE, icao, body);
      edgePut("airport", icao, body, ctx, 604800); // 7 jours
    } catch (e) {
      return null;
    }
  } else {
    capPut(AIRPORT_CACHE, icao, body);
  }
  try {
    const a = JSON.parse(body);
    return {
      icao: a.icao || icao,
      iata: a.iata || "",
      name: a.airport || a.name || icao,
      location: a.municipality || a.region_name || "",
    };
  } catch (e) {
    return null;
  }
}

/* Résout UNE route : adsb.lol en GET, puis HexDB. Retourne l'objet route
   au format attendu par le client, jamais null. */
async function resolveRoute(p, ctx) {
  const cs = p.callsign;

  // 1) adsb.lol (GET unitaire : passe mieux que le POST routeset)
  try {
    const r = await fetch(
      `https://api.adsb.lol/api/0/route/${encodeURIComponent(cs)}/${p.lat}/${p.lng}`,
      { headers: AMONT }
    );
    if (r.ok) {
      const o = await r.json();
      const iata = (o && o._airport_codes_iata) || "";
      if (iata && !/unknown/i.test(iata)) {
        // L'endpoint GET ne fournit pas le détail des aéroports (villes) :
        // on l'enrichit via l'annuaire HexDB (mis en cache 7 jours).
        if (!Array.isArray(o._airports) || o._airports.length < 2) {
          const icaos = (o.airport_codes || "")
            .split("-")
            .map((s) => s.trim())
            .filter(Boolean);
          if (icaos.length >= 2) {
            const aps = [];
            for (const c of icaos) {
              const a = await getAirport(c, ctx);
              if (a) aps.push(a);
            }
            if (aps.length >= 2) o._airports = aps;
          }
        }
        const body = JSON.stringify(o);
        capPut(ROUTE_CACHE, cs, body);
        edgePut("route", cs, body, ctx);
        return o;
      }
      // route "unknown" côté adsb.lol : on tente quand même HexDB.
    }
  } catch (e) {}

  // 2) HexDB (fournisseur indépendant, codes OACI type "LFPO-LFRS")
  try {
    const r = await fetch(
      "https://hexdb.io/api/v1/route/icao/" + encodeURIComponent(cs),
      { headers: AMONT }
    );
    if (r.ok) {
      const h = await r.json();
      const codes = ((h && h.route) || "")
        .split("-")
        .map((s) => s.trim())
        .filter(Boolean);
      if (codes.length >= 2 && !/unknown/i.test(h.route)) {
        const aps = [];
        for (const c of codes) {
          const a = await getAirport(c, ctx);
          if (a) aps.push(a);
        }
        const o = {
          callsign: cs,
          _airport_codes_iata: codes
            .map((c) => {
              const a = aps.find((x) => x.icao === c);
              return (a && a.iata) || c;
            })
            .join("-"),
          _airports: aps,
        };
        const body = JSON.stringify(o);
        capPut(ROUTE_CACHE, cs, body);
        edgePut("route", cs, body, ctx);
        return o;
      }
    }
  } catch (e) {}

  return { callsign: cs, airport_codes: "unknown" };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(request) });
    }

    const url = new URL(request.url);

    if (url.pathname === "/version") {
      return json(request, '{"version":9}');
    }

    // ---- /point/{lat}/{lon}/{rayon_nm} : failover multi-amont ------
    if (url.pathname.startsWith("/point/")) {
      const p = url.pathname.split("/");
      const lat = nombre(p[2]);
      const lon = nombre(p[3]);
      const nm = nombre(p[4]);
      if (!lat || !lon || !nm) {
        return json(request, '{"error":"coordonnees invalides","ac":[]}', 400);
      }

      const upstreams = [
        `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
        `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${nm}`,
        `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
      ];

      // On retient ce qu'a répondu chaque source : sans ce détail, une panne
      // amont est indiscernable d'un refus du Worker lui-même.
      const details = [];
      for (const u of upstreams) {
        const hote = new URL(u).hostname;
        try {
          const up = await fetch(u, { headers: AMONT });
          if (up.ok) return json(request, await up.text());
          details.push({ source: hote, statut: up.status });
        } catch (e) {
          details.push({ source: hote, erreur: String(e && e.message) });
        }
      }

      // 502 : c'est la passerelle qui n'a pas obtenu de réponse valable.
      // Relayer le statut d'une source ferait accuser le Worker à tort.
      return json(
        request,
        JSON.stringify({ error: "upstreams down", details, ac: [] }),
        502
      );
    }

    // ---- /routes : résolution groupée (POST {planes:[...]}) --------
    if (url.pathname === "/routes" && request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return json(request, '{"error":"bad json"}', 400);
      }

      const planes = Array.isArray(payload && payload.planes)
        ? payload.planes.slice(0, 100)
        : [];
      const results = [];
      const missing = [];

      for (const p of planes) {
        const cs = ((p && p.callsign) || "").trim();
        if (!cs) continue;
        const cached = ROUTE_CACHE.get(cs) || (await edgeGet("route", cs));
        if (cached) {
          try {
            results.push(JSON.parse(cached));
            capPut(ROUTE_CACHE, cs, cached);
            continue;
          } catch (e) {}
        }
        missing.push({
          callsign: cs,
          lat: Number(p.lat) || 0,
          lng: Number(p.lng) || 0,
        });
      }

      // Budget sous-requêtes du plan gratuit : on traite quelques nouveaux
      // indicatifs par appel ; le client redemande le reste 20 s après.
      const batch = missing.slice(0, 8);
      const resolved = await Promise.all(batch.map((p) => resolveRoute(p, ctx)));
      results.push(...resolved);

      return json(request, JSON.stringify(results));
    }

    // ---- /route/{callsign}/{lat}/{lng} : GET unitaire --------------
    if (url.pathname.startsWith("/route/")) {
      const parts = url.pathname.split("/");
      const cs = decodeURIComponent(parts[2] || "");
      const cached = ROUTE_CACHE.get(cs) || (await edgeGet("route", cs));
      if (cached) return json(request, cached, 200, { "X-Cache": "HIT" });
      const o = await resolveRoute(
        { callsign: cs, lat: parts[3] || "0", lng: parts[4] || "0" },
        ctx
      );
      return json(request, JSON.stringify(o));
    }

    return json(request, JSON.stringify({ error: "not found" }), 404);
  },
};
