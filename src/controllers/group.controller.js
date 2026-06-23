const crypto = require('crypto');
const prisma = require('../config/database');
const { success, error } = require('../utils/response');

// Codice invito breve e leggibile (6 caratteri, niente 0/O/1/I per evitare ambiguità)
function generateInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(0, alphabet.length)];
  return code;
}

/**
 * Verifica che l'utente sia owner o membro (collegato via userId) del gruppo.
 * @returns {Promise<object|null>} il gruppo se autorizzato, altrimenti null
 */
async function getGroupIfMember(groupId, userId) {
  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      OR: [
        { ownerId: userId },
        { members: { some: { userId } } },
      ],
    },
  });
  return group || null;
}

async function createGroup(req, res) {
  try {
    const { name, groupName, budget, members = [], participants = [] } = req.body;
    
    // Support both name and groupName
    const finalName = name || groupName;
    if (!finalName) return error(res, 'Nome gruppo obbligatorio');

    // Support both members and participants
    const finalMembers = (Array.isArray(members) && members.length > 0)
      ? members
      : (Array.isArray(participants) ? participants : []);

    // Safely parse budget to float if provided
    let parsedBudget = null;
    if (budget != null && String(budget).trim() !== '') {
      parsedBudget = parseFloat(budget);
      if (isNaN(parsedBudget)) {
        return error(res, 'Il budget inserito non è un numero valido');
      }
    }

    // Genera un codice invito unico (ritenta in caso di collisione)
    let inviteCode;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateInviteCode();
      const exists = await prisma.group.findUnique({ where: { inviteCode: candidate } });
      if (!exists) { inviteCode = candidate; break; }
    }

    const group = await prisma.group.create({
      data: {
        name: finalName,
        budget: parsedBudget,
        ownerId: req.userId,
        inviteCode,
        members: {
          create: finalMembers.map(m => ({
            name: m.name || m.email?.split('@')[0] || 'Membro',
            userId: m.userId || null,
          })),
        },
      },
      include: { members: true },
    });

    return success(res, { group }, 201);
  } catch (err) {
    console.error('Error creating group:', err);
    return error(res, 'Errore durante la creazione del gruppo: ' + err.message, 500);
  }
}

// ─── POST /api/group/join  { code } ─────────────────────────────────────────────
// L'amico inserisce il codice invito e viene aggiunto come membro del gruppo.
async function joinGroup(req, res) {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return error(res, 'Codice invito obbligatorio');

  const group = await prisma.group.findUnique({
    where: { inviteCode: code },
    include: { members: true },
  });
  if (!group) return error(res, 'Codice invito non valido', 404);

  // Già owner o già membro? Non duplicare.
  if (group.ownerId === req.userId || group.members.some(m => m.userId === req.userId)) {
    return success(res, { group, message: 'Sei già in questo gruppo' });
  }

  // Recupera il nome dell'utente per il membro
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { name: true, email: true },
  });

  await prisma.groupMember.create({
    data: {
      groupId: group.id,
      userId:  req.userId,
      name:    user?.name || user?.email?.split('@')[0] || 'Membro',
    },
  });

  const updated = await prisma.group.findUnique({
    where: { id: group.id },
    include: { members: true },
  });
  return success(res, { group: updated, message: 'Ti sei unito al gruppo' }, 201);
}

// ─── GET /api/group/:groupId/list ───────────────────────────────────────────────
async function getList(req, res) {
  const group = await getGroupIfMember(req.params.groupId, req.userId);
  if (!group) return error(res, 'Gruppo non trovato o accesso negato', 404);

  const items = await prisma.groupListItem.findMany({
    where:   { groupId: group.id },
    orderBy: [{ checked: 'asc' }, { createdAt: 'desc' }],
  });
  return success(res, { items, total: items.length });
}

// ─── POST /api/group/:groupId/list ──────────────────────────────────────────────
// Aggiunge UNA voce. source: manual | scan | receipt
async function addListItem(req, res) {
  const group = await getGroupIfMember(req.params.groupId, req.userId);
  if (!group) return error(res, 'Gruppo non trovato o accesso negato', 404);

  const name = String(req.body.name || '').trim();
  if (!name) return error(res, 'Nome prodotto obbligatorio');

  const allowed = new Set(['manual', 'scan', 'receipt']);
  const source = allowed.has(req.body.source) ? req.body.source : 'manual';

  const item = await prisma.groupListItem.create({
    data: {
      groupId:          group.id,
      name:             name.slice(0, 120),
      quantity:         Math.min(Math.max(parseFloat(req.body.quantity) || 1, 0.01), 1000),
      price:            req.body.price != null ? Math.max(parseFloat(req.body.price) || 0, 0) : null,
      barcode:          req.body.barcode ? String(req.body.barcode).slice(0, 64) : null,
      source,
      addedByUserId:    req.userId,
      assignedMemberId: req.body.assignedMemberId || null,
    },
  });
  return success(res, { item }, 201);
}

// ─── POST /api/group/:groupId/list/bulk ─────────────────────────────────────────
// Aggiunge PIÙ voci in una volta (es. tutti i prodotti di uno scontrino scansionato)
async function addListItemsBulk(req, res) {
  const group = await getGroupIfMember(req.params.groupId, req.userId);
  if (!group) return error(res, 'Gruppo non trovato o accesso negato', 404);

  const allowed = new Set(['manual', 'scan', 'receipt']);
  const source = allowed.has(req.body.source) ? req.body.source : 'receipt';
  const raw = Array.isArray(req.body.items) ? req.body.items : [];
  const data = raw
    .filter(i => i && String(i.name || '').trim())
    .slice(0, 200)
    .map(i => ({
      groupId:       group.id,
      name:          String(i.name).trim().slice(0, 120),
      quantity:      Math.min(Math.max(parseFloat(i.quantity) || 1, 0.01), 1000),
      price:         i.price != null ? Math.max(parseFloat(i.price) || 0, 0) : null,
      barcode:       i.barcode ? String(i.barcode).slice(0, 64) : null,
      source,
      addedByUserId: req.userId,
    }));

  if (data.length === 0) return error(res, 'Nessuna voce valida da aggiungere');

  await prisma.groupListItem.createMany({ data });
  const items = await prisma.groupListItem.findMany({
    where: { groupId: group.id }, orderBy: [{ checked: 'asc' }, { createdAt: 'desc' }],
  });
  return success(res, { items, added: data.length }, 201);
}

// ─── PUT /api/group/:groupId/list/:itemId ───────────────────────────────────────
// Aggiorna una voce: spunta (checked), quantità, assegnazione, prezzo.
async function updateListItem(req, res) {
  const group = await getGroupIfMember(req.params.groupId, req.userId);
  if (!group) return error(res, 'Gruppo non trovato o accesso negato', 404);

  const existing = await prisma.groupListItem.findFirst({
    where: { id: req.params.itemId, groupId: group.id },
  });
  if (!existing) return error(res, 'Voce non trovata', 404);

  const { name, quantity, price, checked, assignedMemberId } = req.body;
  const updated = await prisma.groupListItem.update({
    where: { id: existing.id },
    data: {
      ...(name             !== undefined && { name: String(name).trim().slice(0, 120) }),
      ...(quantity         !== undefined && { quantity: Math.min(Math.max(parseFloat(quantity) || existing.quantity, 0.01), 1000) }),
      ...(price            !== undefined && { price: price != null ? Math.max(parseFloat(price) || 0, 0) : null }),
      ...(checked          !== undefined && { checked: Boolean(checked) }),
      ...(assignedMemberId !== undefined && { assignedMemberId: assignedMemberId || null }),
    },
  });
  return success(res, { item: updated });
}

// ─── DELETE /api/group/:groupId/list/:itemId ────────────────────────────────────
async function deleteListItem(req, res) {
  const group = await getGroupIfMember(req.params.groupId, req.userId);
  if (!group) return error(res, 'Gruppo non trovato o accesso negato', 404);

  const existing = await prisma.groupListItem.findFirst({
    where: { id: req.params.itemId, groupId: group.id },
  });
  if (!existing) return error(res, 'Voce non trovata', 404);

  await prisma.groupListItem.delete({ where: { id: existing.id } });
  return success(res, { message: 'Voce rimossa' });
}

async function getGroups(req, res) {
  const groups = await prisma.group.findMany({
    where: {
      OR: [
        { ownerId: req.userId },
        { members: { some: { userId: req.userId } } },
      ],
    },
    include: { members: true, _count: { select: { scannedProducts: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return success(res, { groups });
}

async function getGroupById(req, res) {
  const group = await prisma.group.findUnique({
    where: { id: req.params.groupId },
    include: {
      members: true,
      scannedProducts: { orderBy: { timestamp: 'desc' } },
    },
  });
  if (!group) return error(res, 'Gruppo non trovato', 404);

  // Calculate totals per member
  const memberTotals = {};
  for (const member of group.members) {
    memberTotals[member.id] = { member, total: 0, items: [] };
  }

  for (const sp of group.scannedProducts) {
    if (sp.groupMemberId && memberTotals[sp.groupMemberId]) {
      const price = sp.price * sp.quantity;
      memberTotals[sp.groupMemberId].total += price;
      memberTotals[sp.groupMemberId].items.push(sp);
    }
  }

  const groupTotal = Object.values(memberTotals).reduce((s, m) => s + m.total, 0);

  return success(res, { group, memberTotals: Object.values(memberTotals), groupTotal });
}

async function deleteGroup(req, res) {
  const group = await prisma.group.findUnique({ where: { id: req.params.groupId } });
  if (!group) return error(res, 'Gruppo non trovato', 404);
  if (group.ownerId !== req.userId) return error(res, 'Non autorizzato', 403);

  await prisma.group.delete({ where: { id: req.params.groupId } });
  return success(res, { message: 'Gruppo eliminato' });
}

module.exports = {
  createGroup, getGroups, getGroupById, deleteGroup,
  joinGroup, getList, addListItem, addListItemsBulk, updateListItem, deleteListItem,
};
