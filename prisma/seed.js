const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Seed sample stores in Milan
  const stores = [
    { name: 'Esselunga Porta Vittoria', address: 'Via Vallazze 6, Milano', latitude: 45.464, longitude: 9.221, chain: 'Esselunga', rating: 4.2 },
    { name: 'Carrefour Market Loreto', address: 'Viale Monza 1, Milano', latitude: 45.488, longitude: 9.213, chain: 'Carrefour', rating: 3.9 },
    { name: 'Lidl Milano Piola', address: 'Via Ventura 5, Milano', latitude: 45.478, longitude: 9.226, chain: 'Lidl', rating: 4.0 },
    { name: 'Pam Panorama', address: 'Via Canonica 10, Milano', latitude: 45.476, longitude: 9.176, chain: 'Pam', rating: 3.7 },
    { name: 'Conad Milano Centro', address: 'Corso Buenos Aires 50, Milano', latitude: 45.481, longitude: 9.207, chain: 'Conad', rating: 4.1 },
  ];

  for (const s of stores) {
    const store = await prisma.store.upsert({
      where: { id: `seed-${s.name.replace(/\s/g, '-').toLowerCase()}` },
      update: {},
      create: { id: `seed-${s.name.replace(/\s/g, '-').toLowerCase()}`, ...s },
    });

    // Seed a few products per store
    const products = [
      { name: 'Latte Intero 1L', barcode: '8001234567890', price: 1.39, category: 'Latticini', isOnSale: false },
      { name: 'Pane in cassetta', barcode: '8001234567891', price: 1.99, discountedPrice: 1.49, category: 'Pane', isOnSale: true },
      { name: 'Pasta Barilla 500g', barcode: '8076800195057', price: 0.99, category: 'Pasta', isOnSale: false },
      { name: 'Olio EVO 750ml', barcode: '8001234567892', price: 7.49, discountedPrice: 5.99, category: 'Condimenti', isOnSale: true },
      { name: 'Acqua Naturale 1.5L', barcode: '8001234567893', price: 0.29, category: 'Bevande', isOnSale: false },
    ].map(p => ({
      ...p,
      price: p.price + (Math.random() - 0.5) * 0.3, // slight price variation per store
      storeId: store.id,
    }));

    for (const p of products) {
      await prisma.product.create({ data: p }).catch(() => {});
    }
  }

  console.log('Seed completato');
}

main().catch(console.error).finally(() => prisma.$disconnect());
