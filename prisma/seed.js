const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Catene supermercati italiane
const chains = [
  'Conad', 'Coop', 'Esselunga', 'Carrefour', 'Lidl', 'Eurospin', 'Pam', 'Todis',
  'MD', 'Despar', 'Sigma', 'Crai', 'Penny', 'Tigre', 'Elite', 'Famila', 'Simply', 'Deco',
];

// Citta e quartieri con coordinate centro [nome, lat, lon]
const cities = [
  // --- Lazio / zona utente ---
  ['Roma', 41.9028, 12.4964], ['Guidonia Montecelio', 41.9930, 12.7280],
  ['Tivoli', 41.9633, 12.7958], ['Villa Adriana', 41.9420, 12.7750],
  ['Mentana', 42.0350, 12.6420], ['Monterotondo', 42.0530, 12.6160],
  ['Frascati', 41.8090, 12.6800], ['Pomezia', 41.6690, 12.5010],
  ['Fiumicino', 41.7710, 12.2370], ['Ostia', 41.7330, 12.2770],
  ['Albano Laziale', 41.7270, 12.6600], ['Latina', 41.4677, 12.9036],
  // --- Quartieri di Roma ---
  ['Roma Prati', 41.9090, 12.4640], ['Roma EUR', 41.8300, 12.4690],
  ['Roma Trastevere', 41.8890, 12.4690], ['Roma San Giovanni', 41.8860, 12.5090],
  ['Roma Tiburtina', 41.9100, 12.5300], ['Roma Montesacro', 41.9500, 12.5400],
  ['Roma Ostiense', 41.8650, 12.4800], ['Roma Tuscolano', 41.8650, 12.5450],
  ['Roma Trieste', 41.9250, 12.5080], ['Roma Aurelio', 41.9000, 12.4300],
  ['Roma Monteverde', 41.8800, 12.4500], ['Roma Garbatella', 41.8600, 12.4880],
  ['Roma Pigneto', 41.8880, 12.5320], ['Roma Centocelle', 41.8780, 12.5640],
  // --- Grandi citta ---
  ['Torino', 45.0703, 7.6869], ['Milano', 45.4642, 9.1900],
  ['Napoli', 40.8518, 14.2681], ['Bologna', 44.4949, 11.3426],
  ['Firenze', 43.7696, 11.2558], ['Genova', 44.4056, 8.9463],
  ['Palermo', 38.1157, 13.3615], ['Bari', 41.1171, 16.8719],
  ['Catania', 37.5079, 15.0830], ['Venezia', 45.4408, 12.3155],
  ['Verona', 45.4384, 10.9916], ['Padova', 45.4064, 11.8768],
  ['Brescia', 45.5416, 10.2118], ['Cagliari', 39.2238, 9.1217],
  ['Bergamo', 45.6983, 9.6773], ['Trieste', 45.6495, 13.7768],
  ['Parma', 44.8015, 10.3279], ['Modena', 44.6471, 10.9252],
  ['Reggio Calabria', 38.1110, 15.6470], ['Perugia', 43.1107, 12.3908],
  ['Pescara', 42.4618, 14.2161], ['Livorno', 43.5485, 10.3106],
  ['Salerno', 40.6824, 14.7681], ['Rimini', 44.0678, 12.5695],
  ['Ancona', 43.6158, 13.5189], ['Lecce', 40.3515, 18.1750],
];

const productTemplates = [
  { name: 'Latte Intero 1L', barcode: '8001234567890', price: 1.39, category: 'Latticini', isOnSale: false },
  { name: 'Pane in cassetta', barcode: '8001234567891', price: 1.99, discountedPrice: 1.49, category: 'Pane', isOnSale: true },
  { name: 'Pasta Barilla 500g', barcode: '8076800195057', price: 0.99, category: 'Pasta', isOnSale: false },
  { name: 'Olio EVO 750ml', barcode: '8001234567892', price: 7.49, discountedPrice: 5.99, category: 'Condimenti', isOnSale: true },
  { name: 'Acqua Naturale 1.5L', barcode: '8001234567893', price: 0.29, category: 'Bevande', isOnSale: false },
];

const PER_CITY = 18; // negozi per citta (52 citta x 18 = ~936)
const jitter = (n) => (Math.random() - 0.5) * n;
const slug = (s) => `seed-${s.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

async function main() {
  // Pulisce i negozi di esempio precedenti (i prodotti vengono eliminati in cascata)
  await prisma.store.deleteMany({ where: { id: { startsWith: 'seed-' } } });

  let n = 0;
  for (const [city, lat, lon] of cities) {
    for (let i = 0; i < PER_CITY; i++) {
      const chain = chains[n % chains.length];
      const name = `${chain} ${city} ${i + 1}`;
      const data = {
        id: slug(name),
        name,
        address: city,
        latitude: +(lat + jitter(0.05)).toFixed(6),
        longitude: +(lon + jitter(0.05)).toFixed(6),
        chain,
        rating: +(3.4 + Math.random() * 1.5).toFixed(1),
      };
      const store = await prisma.store.create({ data });
      const products = productTemplates.map((p) => ({
        ...p,
        price: +(p.price + jitter(0.4)).toFixed(2),
        storeId: store.id,
      }));
      for (const p of products) {
        await prisma.product.create({ data: p }).catch(() => {});
      }
      n++;
    }
  }
  const count = await prisma.store.count();
  console.log('Seed completato. Negozi totali nel DB:', count);
}

main().catch(console.error).finally(() => prisma.$disconnect());
