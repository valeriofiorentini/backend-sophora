/**
 * money — helper per convertire i campi Decimal di Prisma in Number al confine
 * API. I campi monetari sono Decimal(10,2) nel DB (no deriva float), ma Prisma
 * li restituisce come oggetti Decimal → serializzati come STRINGA in JSON, e il
 * client fa aritmetica (sum + price). Qui li si riporta a Number prima di
 * inviarli, così il contratto verso il client resta "numeri".
 */
function toNum(v) {
  return v == null ? v : Number(v);
}

// Converte price/discountedPrice di un Product (e del suo store annidato, se
// presente) da Decimal a Number. Ritorna un nuovo oggetto (non muta l'input).
function serializeProduct(p) {
  if (!p) return p;
  return {
    ...p,
    price: toNum(p.price),
    discountedPrice: toNum(p.discountedPrice),
  };
}

module.exports = { toNum, serializeProduct };
