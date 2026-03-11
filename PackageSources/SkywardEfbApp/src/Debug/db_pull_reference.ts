/**
 * Reference only.
 *
 * This file documents the removed "world airport DB pull" flow that used to run
 * automatically from `SkywardOverviewMap.tsx` after the map received GPS data.
 *
 * The flow is intentionally NOT imported anywhere. The live EFB app no longer
 * exports airport data to the local server.
 *
 * Previous behavior summary:
 * - Wait ~10 seconds after first valid GPS update.
 * - Start a world grid scan using `FacilityLoader`.
 * - Search airport facilities cell-by-cell with nearest search sessions.
 * - Subdivide dense cells.
 * - POST batches to:
 *   - `http://127.0.0.1:5000/debug/msfs-airports-export/start`
 *   - `http://127.0.0.1:5000/debug/msfs-airports-export/batch`
 *   - `http://127.0.0.1:5000/debug/msfs-airports-export/finish`
 * - Serialize fields such as:
 *   - `icao`, `ident`, `iata`
 *   - `name`, `name_raw`
 *   - `city`, `city_raw`
 *   - `region`, `lat`, `lon`
 *   - `airport_class`, `airport_private_type`, `towered`
 *   - `frequencies`, `runways`, `counts`
 *
 * If this capability is needed again later, re-implement it as an explicit debug
 * action instead of an automatic map-side effect.
 */

export {};
