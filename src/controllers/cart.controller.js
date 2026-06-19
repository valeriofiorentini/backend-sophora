const prisma = require('../config/database');
const { success, error } = require('../utils/response');

async function getCart(req, res) {
  const items = await prisma.cartItem.findMany({
    where: { userId: req.userId },
    include: { product: { include: { store: true } } },
    orderBy: { addedAt: 'desc' },
  });

  const total = items.reduce((sum, item) => {
    const price = item.product.discountedPrice ?? item.product.price;
    return sum + price * item.quantity;
  }, 0);

  return success(res, { items, total: parseFloat(total.toFixed(2)) });
}

// Valida quantity: intero tra 1 e 999
function parseQuantity(q) {
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1 || n > 999) return null;
  return n;
}

async function addToCart(req, res) {
  const { productId } = req.body;
  if (!productId || typeof productId !== 'string') return error(res, 'productId obbligatorio');

  const quantity = parseQuantity(req.body.quantity ?? 1);
  if (quantity === null) return error(res, 'quantity deve essere un intero tra 1 e 999');

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return error(res, 'Prodotto non trovato', 404);

  const item = await prisma.cartItem.upsert({
    where: { userId_productId: { userId: req.userId, productId } },
    update: { quantity: { increment: quantity } },
    create: { userId: req.userId, productId, quantity },
    include: { product: true },
  });

  return success(res, { item }, 201);
}

async function updateCartItem(req, res) {
  const { productId, quantity } = req.body;
  if (!productId || quantity === undefined) return error(res, 'productId e quantity obbligatori');

  const qNum = Number(quantity);
  if (!Number.isInteger(qNum)) return error(res, 'quantity deve essere un numero intero');

  if (qNum <= 0) {
    await prisma.cartItem.deleteMany({ where: { userId: req.userId, productId } });
    return success(res, { message: 'Prodotto rimosso dal carrello' });
  }
  if (qNum > 999) return error(res, 'quantity massima: 999');

  // updateMany non lancia P2025 se l'item non esiste — gestiamo il caso esplicitamente
  const updated = await prisma.cartItem.updateMany({
    where: { userId: req.userId, productId },
    data: { quantity: qNum },
  });
  if (updated.count === 0) return error(res, 'Prodotto non presente nel carrello', 404);

  const item = await prisma.cartItem.findUnique({
    where: { userId_productId: { userId: req.userId, productId } },
    include: { product: true },
  });

  return success(res, { item });
}

async function removeFromCart(req, res) {
  await prisma.cartItem.deleteMany({ where: { userId: req.userId, productId: req.params.productId } });
  return success(res, { message: 'Prodotto rimosso' });
}

async function clearCart(req, res) {
  await prisma.cartItem.deleteMany({ where: { userId: req.userId } });
  return success(res, { message: 'Carrello svuotato' });
}

module.exports = { getCart, addToCart, updateCartItem, removeFromCart, clearCart };
