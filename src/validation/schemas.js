/**
 * Schemi zod per le route di scrittura.
 *
 * Nota sui form multipart (feed, edit-profile): multer consegna TUTTI i campi
 * come stringhe e i campi omessi come stringa vuota. Gli helper qui sotto
 * normalizzano '' e null a undefined prima della coercizione, così
 * rating="" non diventa 0 e i campi opzionali restano davvero opzionali.
 *
 * Tutti gli schemi usano .passthrough(): i campi non modellati passano
 * invariati (nessuna rottura se un controller legge un campo extra).
 */
const { z } = require('zod');

const empty = v => (v === '' || v === null || v === undefined ? undefined : v);

const optStr  = max => z.preprocess(empty, z.string().max(max).optional());
const reqStr  = max => z.string().min(1).max(max);
const optNum  = (min, max) => z.preprocess(empty, z.coerce.number().min(min).max(max).optional());
const optBool = () =>
  z.preprocess(v => {
    const e = empty(v);
    if (e === undefined) return undefined;
    if (e === 'true' || e === true) return true;
    if (e === 'false' || e === false) return false;
    return e; // valore strano → fallisce z.boolean()
  }, z.boolean().optional());
const optDate = () =>
  z.preprocess(empty, z.coerce.date().optional());
// Campo che può arrivare come stringa JSON o come oggetto: normalizza a stringa
const optJsonStr = max =>
  z.preprocess(v => {
    const e = empty(v);
    if (e === undefined) return undefined;
    if (typeof e === 'string') return e;
    try { return JSON.stringify(e); } catch { return e; }
  }, z.string().max(max).optional());

// ─── Auth ─────────────────────────────────────────────────────────────────────
// Email e password hanno già validazione dedicata nel controller
// (anti-enumeration, regole password): qui blocchiamo solo tipi e lunghezze.
const signupSchema = z.object({
  email:    reqStr(254),
  password: reqStr(128),
  name:     optStr(100),
  surname:  optStr(100),
  username: optStr(50),
  phone:    optStr(30),
  country:  optStr(60),
  language: optStr(5),
}).passthrough();

const loginSchema = z.object({
  email:    reqStr(254),
  password: reqStr(128),
}).passthrough();

// ─── Profilo ──────────────────────────────────────────────────────────────────
const editProfileSchema = z.object({
  name:           optStr(100),
  surname:        optStr(100),
  username:       optStr(50),
  phone:          optStr(30),
  country:        optStr(60),
  language:       optStr(5),
  monthlyBudget:  optNum(0, 1_000_000),
  yearlyBudget:   optNum(0, 12_000_000),
  deviceToken:    optStr(500),
  b2bDataSharing: optBool(),
}).passthrough();

const fcmTokenSchema = z.object({
  fcmToken:  reqStr(500),
  latitude:  optNum(-90, 90),
  longitude: optNum(-180, 180),
}).passthrough();

const locationSchema = z.object({
  latitude:  z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
}).passthrough();

// ─── Community (multipart: tutti i campi arrivano come stringhe) ─────────────
const feedCreateSchema = z.object({
  name:          optStr(200),
  storeName:     optStr(200),
  description:   optStr(2000),
  rating:        optNum(0, 5),
  type:          z.preprocess(empty, z.enum(['review', 'discount']).optional()),
  isDiscount:    optBool(),
  location:      optJsonStr(2000),
  storeLocation: optJsonStr(2000),
}).passthrough();

const feedUpdateSchema = z.object({
  description: optStr(2000),
  storeName:   optStr(200),
  rating:      optNum(0, 5),
}).passthrough();

// ─── Dispensa ─────────────────────────────────────────────────────────────────
const pantryItemSchema = z.object({
  name:      reqStr(120),
  category:  optStr(40),
  quantity:  optNum(0.01, 1000),
  unit:      optStr(16),
  barcode:   optStr(64),
  notes:     optStr(500),
  expiresAt: optDate(),
}).passthrough();

const pantryUpdateSchema = z.object({
  name:      optStr(120),
  category:  optStr(40),
  quantity:  optNum(0.01, 1000),
  unit:      optStr(16),
  notes:     optStr(500),
  expiresAt: optDate(),
  inStock:   optBool(),
}).passthrough();

// ─── Prodotti scansionati ─────────────────────────────────────────────────────
const scannedProductSchema = z.object({
  name:          optStr(200),
  productName:   optStr(200),
  price:         z.coerce.number().min(0).max(100_000),
  quantity:      optNum(1, 999),
  barcode:       optStr(64),
  storeId:       optStr(64),
  storeName:     optStr(200),
  groupId:       optStr(64),
  groupMemberId: optStr(64),
}).passthrough()
  .refine(d => d.name || d.productName, { message: 'name o productName obbligatorio' });

// ─── Gruppi ───────────────────────────────────────────────────────────────────
const groupCreateSchema = z.object({
  name:      optStr(100),
  groupName: optStr(100),
  budget:    optNum(0, 1_000_000),
  members:      z.array(z.any()).max(50).optional(),
  participants: z.array(z.any()).max(50).optional(),
}).passthrough()
  .refine(d => d.name || d.groupName, { message: 'name o groupName obbligatorio' });

const groupJoinSchema = z.object({
  code: reqStr(20),
}).passthrough();

module.exports = {
  signupSchema,
  loginSchema,
  editProfileSchema,
  fcmTokenSchema,
  locationSchema,
  feedCreateSchema,
  feedUpdateSchema,
  pantryItemSchema,
  pantryUpdateSchema,
  scannedProductSchema,
  groupCreateSchema,
  groupJoinSchema,
};
