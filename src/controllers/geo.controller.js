const { success, error } = require('../utils/response');
const { searchCityByName } = require('../utils/comuniGeo');

// ─── GET /api/geo/search-city?q=roma ───────────────────────────────────────
// Cerca un comune italiano per nome usando il dataset ISTAT locale (nessuna
// chiamata a Google Geocoding — usato dal filtro "Città" in community).
async function searchCity(req, res) {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return error(res, 'Digita almeno 2 caratteri');
  const results = searchCityByName(q, 8);
  return success(res, { results });
}

module.exports = { searchCity };
