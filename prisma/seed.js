const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Catene supermercati italiane
const chains = [
  'Conad', 'Coop', 'Esselunga', 'Carrefour', 'Lidl', 'Eurospin', 'Pam', 'Todis',
  'MD', 'Despar', 'Sigma', 'Crai', 'Penny', 'Tigre', 'Elite', 'Famila', 'Simply', 'Deco',
];

// Citta, quartieri e province con coordinate centro [nome, lat, lon]
const cities = [
  // --- Lazio / zona utente ---
  ['Roma', 41.9028, 12.4964], ['Guidonia Montecelio', 41.9930, 12.7280],
  ['Tivoli', 41.9633, 12.7958], ['Villa Adriana', 41.9420, 12.7750],
  ['Mentana', 42.0350, 12.6420], ['Monterotondo', 42.0530, 12.6160],
  ['Frascati', 41.8090, 12.6800], ['Pomezia', 41.6690, 12.5010],
  ['Fiumicino', 41.7710, 12.2370], ['Ostia', 41.7330, 12.2770],
  ['Albano Laziale', 41.7270, 12.6600], ['Latina', 41.4677, 12.9036],
  // --- Quartieri e zone di Roma ---
  ['Roma Prati', 41.9090, 12.4640], ['Roma EUR', 41.8300, 12.4690],
  ['Roma Trastevere', 41.8890, 12.4690], ['Roma San Giovanni', 41.8860, 12.5090],
  ['Roma Tiburtina', 41.9100, 12.5300], ['Roma Montesacro', 41.9500, 12.5400],
  ['Roma Ostiense', 41.8650, 12.4800], ['Roma Tuscolano', 41.8650, 12.5450],
  ['Roma Trieste', 41.9250, 12.5080], ['Roma Aurelio', 41.9000, 12.4300],
  ['Roma Monteverde', 41.8800, 12.4500], ['Roma Garbatella', 41.8600, 12.4880],
  ['Roma Pigneto', 41.8880, 12.5320], ['Roma Centocelle', 41.8780, 12.5640],
  ['Roma Salaria', 41.9300, 12.5000], ['Roma Infernetto', 41.7600, 12.3500],
  ['Roma Spinaceto', 41.7900, 12.4500], ['Roma Casalpalocco', 41.7700, 12.3600],
  ['Roma Axa', 41.7750, 12.3300], ['Roma Tor Bella Monaca', 41.8650, 12.6300],
  ['Roma Cinecitta', 41.8500, 12.5700], ['Roma Appio', 41.8700, 12.5200],
  ['Roma Magliana', 41.8400, 12.4500], ['Roma Portuense', 41.8500, 12.4500],
  ['Roma Boccea', 41.9050, 12.4100], ['Roma Primavalle', 41.9150, 12.4150],
  ['Roma Talenti', 41.9450, 12.5500], ['Roma Cassia', 41.9600, 12.4300],
  ['Roma Prima Porta', 42.0000, 12.4800], ['Roma San Basilio', 41.9450, 12.5800],
  ['Roma Marconi', 41.8550, 12.4700], ['Roma Laurentino', 41.8100, 12.4800],
  ['Roma Ardeatino', 41.8400, 12.5100], ['Roma Ponte Milvio', 41.9350, 12.4700],
  ['Roma Flaminio', 41.9250, 12.4750], ['Roma Nomentano', 41.9200, 12.5200],
  // --- Provincia di Roma / Castelli / litorale ---
  ['Aprilia', 41.5950, 12.6480], ['Velletri', 41.6870, 12.7770],
  ['Anzio', 41.4480, 12.6280], ['Nettuno', 41.4570, 12.6620],
  ['Ciampino', 41.8000, 12.6000], ['Marino', 41.7690, 12.6590],
  ['Grottaferrata', 41.7880, 12.6680], ['Genzano di Roma', 41.7050, 12.6920],
  ['Ariccia', 41.7220, 12.6720], ['Colleferro', 41.7280, 13.0030],
  ['Valmontone', 41.7770, 12.9210], ['Palestrina', 41.8390, 12.8870],
  ['Zagarolo', 41.8400, 12.8300], ['Subiaco', 41.9250, 13.1000],
  ['Bracciano', 42.1030, 12.1770], ['Cerveteri', 41.9960, 12.0990],
  ['Ladispoli', 41.9550, 12.0760], ['Fiano Romano', 42.1670, 12.5950],
  ['Fonte Nuova', 41.9920, 12.6180], ['San Cesareo', 41.8270, 12.8000],
  ['Civitavecchia', 42.0930, 11.7960],
  // --- Capoluoghi Lazio ---
  ['Frosinone', 41.6400, 13.3500], ['Rieti', 42.4030, 12.8600], ['Viterbo', 42.4200, 12.1070],
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
  // --- Altre province ---
  ['Como', 45.8080, 9.0850], ['Varese', 45.8200, 8.8250], ['Monza', 45.5840, 9.2740],
  ['Novara', 45.4450, 8.6200], ['Cuneo', 44.3840, 7.5430], ['Asti', 44.9000, 8.2060],
  ['Alessandria', 44.9130, 8.6150], ['La Spezia', 44.1070, 9.8280], ['Savona', 44.3080, 8.4810],
  ['Piacenza', 45.0520, 9.6930], ['Ferrara', 44.8350, 11.6200], ['Ravenna', 44.4180, 12.2030],
  ['Forli', 44.2230, 12.0410], ['Cesena', 44.1390, 12.2470], ['Pisa', 43.7160, 10.4010],
  ['Lucca', 43.8430, 10.5050], ['Prato', 43.8800, 11.0970], ['Pistoia', 43.9330, 10.9170],
  ['Arezzo', 43.4630, 11.8800], ['Siena', 43.3190, 11.3310], ['Grosseto', 42.7600, 11.1130],
  ['Terni', 42.5630, 12.6430], ['Pesaro', 43.9100, 12.9130], ['Teramo', 42.6590, 13.7040],
  ['Chieti', 42.3510, 14.1680], ['L Aquila', 42.3500, 13.4000], ['Caserta', 41.0720, 14.3330],
  ['Benevento', 41.1300, 14.7780], ['Avellino', 40.9140, 14.7930], ['Foggia', 41.4620, 15.5440],
  ['Brindisi', 40.6380, 17.9460], ['Taranto', 40.4640, 17.2470], ['Barletta', 41.3190, 16.2810],
  ['Matera', 40.6660, 16.6040], ['Potenza', 40.6420, 15.8050], ['Cosenza', 39.2980, 16.2540],
  ['Catanzaro', 38.9100, 16.5870], ['Messina', 38.1940, 15.5560], ['Siracusa', 37.0750, 15.2870],
  ['Ragusa', 36.9270, 14.7250], ['Trapani', 38.0180, 12.5150], ['Agrigento', 37.3110, 13.5760],
  ['Sassari', 40.7260, 8.5590], ['Olbia', 40.9230, 9.4990], ['Udine', 46.0710, 13.2340],
  ['Treviso', 45.6670, 12.2430], ['Vicenza', 45.5450, 11.5350], ['Mantova', 45.1560, 10.7910],
  ['Cremona', 45.1330, 10.0220], ['Pavia', 45.1850, 9.1560], ['Lecco', 45.8560, 9.3930],
  ['Trento', 46.0700, 11.1190], ['Bolzano', 46.4980, 11.3540], ['Aosta', 45.7370, 7.3150],
];

const productTemplates = [
  { name: 'Latte Intero 1L', barcode: '8001234567890', price: 1.39, category: 'Latticini', isOnSale: false },
  { name: 'Pane in cassetta', barcode: '8001234567891', price: 1.99, discountedPrice: 1.49, category: 'Pane', isOnSale: true },
  { name: 'Pasta Barilla 500g', barcode: '8076800195057', price: 0.99, category: 'Pasta', isOnSale: false },
  { name: 'Olio EVO 750ml', barcode: '8001234567892', price: 7.49, discountedPrice: 5.99, category: 'Condimenti', isOnSale: true },
  { name: 'Acqua Naturale 1.5L', barcode: '8001234567893', price: 0.29, category: 'Bevande', isOnSale: false },
];

const PER_CITY = 6; // ~150 localita x 6 = ~900 negozi
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
      const store = await prisma.store.create({
        data: {
          id: slug(name),
          name,
          address: city,
          latitude: +(lat + jitter(0.05)).toFixed(6),
          longitude: +(lon + jitter(0.05)).toFixed(6),
          chain,
          rating: +(3.4 + Math.random() * 1.5).toFixed(1),
        },
      });
      for (const p of productTemplates) {
        await prisma.product
          .create({ data: { ...p, price: +(p.price + jitter(0.4)).toFixed(2), storeId: store.id } })
          .catch(() => {});
      }
      n++;
    }
  }
  console.log('Citta/localita:', cities.length, '| Negozi totali nel DB:', await prisma.store.count());
}

main().catch(console.error).finally(() => prisma.$disconnect());
