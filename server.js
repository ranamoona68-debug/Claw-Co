const express = require('express'), path = require('path'), fs = require('fs');
const multer = require('multer'), jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'claw123', 10);
if (!process.env.ADMIN_PASSWORD) console.warn('⚠ Using default admin password "claw123". Set ADMIN_PASSWORD before going live.');

const uploads = path.join(__dirname, 'uploads');
fs.mkdirSync(uploads, { recursive: true });
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'claw.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, color TEXT DEFAULT '#e8a2b8', description TEXT DEFAULT '', image TEXT);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, addr TEXT, pay TEXT, total INTEGER, status TEXT DEFAULT 'New', created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, product_id INTEGER, name TEXT, qty INTEGER, price INTEGER);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, name TEXT, stars INTEGER, text TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
`);
// upgrade older databases (keeps all existing data)
const has = (t, c) => db.prepare('PRAGMA table_info(' + t + ')').all().some(x => x.name === c);
if (!has('products', 'shapes')) db.exec("ALTER TABLE products ADD COLUMN shapes TEXT DEFAULT ''");
if (!has('products', 'colors')) db.exec("ALTER TABLE products ADD COLUMN colors TEXT DEFAULT ''");
if (!has('order_items', 'options')) db.exec("ALTER TABLE order_items ADD COLUMN options TEXT DEFAULT ''");
if (!has('products', 'category')) db.exec("ALTER TABLE products ADD COLUMN category TEXT DEFAULT 'nails-hands'");
if (!has('products', 'sale_price')) db.exec("ALTER TABLE products ADD COLUMN sale_price INTEGER DEFAULT 0");
if (!has('products', 'packs')) db.exec("ALTER TABLE products ADD COLUMN packs TEXT DEFAULT ''");
if (!has('products', 'images')) db.exec("ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'");
db.exec("UPDATE products SET images = json_array(image) WHERE image IS NOT NULL AND (images IS NULL OR images = '' OR images = '[]')");
if (!db.prepare('SELECT COUNT(*) c FROM products').get().c) {
  const ins = db.prepare('INSERT INTO products(name,price,stock,color,description) VALUES (?,?,?,?,?)');
  [['Rosé Chrome',1800,25,'#e8a2b8','Mirror rose chrome, almond shape, 24 pcs.'],
   ['Midnight Noir',1600,18,'#241a2e','Glossy black coffin set with silver accents.'],
   ['Cherry Gloss',1500,30,'#c2183d','Juicy cherry red, short square, 20 pcs.'],
   ['Milky French',1700,22,'#f7e6e0','Soft milky base with classic white tips.'],
   ['Lilac Dream',1900,12,'#b9a3e3','Pastel lilac with tiny gold flakes.'],
   ['Gold Rush',2200,8,'#d9a441','Luxe metallic gold stiletto set.']].forEach(r => ins.run(...r));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploads,
    filename: (_, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(f.originalname).toLowerCase())
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(f.mimetype))
});

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use('/uploads', express.static(uploads));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  try { jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Please log in' }); }
};
const clean = (s, n = 500) => String(s || '').trim().slice(0, n);
const imgs = p => { let a = []; try { a = JSON.parse(p.images || '[]'); } catch {} if (!a.length && p.image) a = [p.image]; return a; };
const parsePacks = t => list(t).map(x => { const i = x.lastIndexOf(':'), n = x.slice(0, i).trim(), pr = parseInt(x.slice(i + 1)); return i > 0 && n && pr > 0 ? { name: n, price: pr } : null; }).filter(Boolean);
const withPacks = (req, f) => { const pk = parsePacks(f.packs); if (pk.length) f.price = Math.min(...pk.map(x => x.price)); return f; };
const CATS = ['nails-hands', 'nails-feet', 'acc-glue', 'acc-stickers', 'acc-files', 'acc-other'];
const list = t => String(t || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
const colorName = c => c.replace(/\s*#[0-9a-f]{3,6}\s*$/i, '').trim();

/* ---------- Public API ---------- */
app.get('/api/products', (_, res) => res.json(db.prepare(`
  SELECT p.*, COALESCE((SELECT AVG(stars) FROM reviews WHERE product_id=p.id),0) rating,
  (SELECT COUNT(*) FROM reviews WHERE product_id=p.id) reviews FROM products p ORDER BY id`).all().map(r => ({ ...r, images: imgs(r) }))));

app.get('/api/products/:id/reviews', (req, res) =>
  res.json(db.prepare('SELECT id,name,stars,text,created FROM reviews WHERE product_id=? ORDER BY id DESC').all(req.params.id)));

app.post('/api/products/:id/reviews', (req, res) => {
  const name = clean(req.body.name), text = clean(req.body.text), stars = parseInt(req.body.stars);
  if (!name || !text || !(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Name, review and 1-5 stars required' });
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'No such product' });
  db.prepare('INSERT INTO reviews(product_id,name,stars,text) VALUES (?,?,?,?)').run(req.params.id, name, stars, text);
  res.json({ ok: true });
});

app.post('/api/orders', (req, res) => {
  const { items } = req.body || {}, name = clean(req.body.name), email = clean(req.body.email), addr = clean(req.body.addr);
  if (!name || !email || !addr || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Please fill in all details' });
  try {
    const id = db.transaction(() => {
      let total = 0; const lines = [], need = {};
      for (const it of items) {
        const p = db.prepare('SELECT * FROM products WHERE id=?').get(it.id), q = parseInt(it.q);
        if (!p || !(q > 0)) throw new Error('Invalid item in cart');
        need[p.id] = (need[p.id] || 0) + q;
        if (p.stock < need[p.id]) throw new Error(p.name + ' only has ' + p.stock + ' left');
        const shapes = list(p.shapes), colors = list(p.colors).map(colorName);
        const shape = clean(it.shape), color = clean(it.color);
        if (shapes.length && !shapes.includes(shape)) throw new Error('Please choose a shape for ' + p.name);
        if (colors.length && !colors.includes(color)) throw new Error('Please choose a colour for ' + p.name);
        const packs = parsePacks(p.packs), pack = packs.length ? clean(it.pack) : '', pk = packs.find(x => x.name === pack);
        if (packs.length && !pk) throw new Error('Please choose a pack for ' + p.name);
        const unit = Math.round((pk ? pk.price : p.price) * (p.sale_price > 0 && p.sale_price < p.price ? p.sale_price : p.price) / p.price);
        total += unit * q; lines.push([p, q, [pack, shape, color].filter(Boolean).join(', '), unit]);
      }
      const oid = db.prepare('INSERT INTO orders(name,email,addr,pay,total) VALUES (?,?,?,?,?)').run(name, email, addr, clean(req.body.pay) || 'Cash on delivery', total).lastInsertRowid;
      for (const [p, q, opt, unit] of lines) {
        db.prepare('INSERT INTO order_items(order_id,product_id,name,qty,price,options) VALUES (?,?,?,?,?,?)').run(oid, p.id, p.name, q, unit, opt);
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(q, p.id);
      }
      return oid;
    })();
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Admin API ---------- */
app.post('/api/admin/login', (req, res) => {
  if (!bcrypt.compareSync(String(req.body.password || ''), ADMIN_HASH)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: jwt.sign({ admin: true }, SECRET, { expiresIn: '8h' }) });
});

app.get('/api/admin/stats', auth, (_, res) => res.json({
  revenue: db.prepare("SELECT COALESCE(SUM(total),0) v FROM orders WHERE status!='Cancelled'").get().v,
  orders: db.prepare('SELECT COUNT(*) v FROM orders').get().v,
  products: db.prepare('SELECT COUNT(*) v FROM products').get().v,
  reviews: db.prepare('SELECT COUNT(*) v FROM reviews').get().v
}));

const fields = req => withPacks(req, {
  name: clean(req.body.name), price: parseInt(req.body.price) || 0, stock: parseInt(req.body.stock) || 0,
  color: /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#e8a2b8', description: clean(req.body.description, 2000),
  category: CATS.includes(req.body.category) ? req.body.category : 'nails-hands', sale_price: Math.max(0, parseInt(req.body.sale_price) || 0),
  shapes: list(req.body.shapes).join(', '), colors: list(req.body.colors).join(', '),
  packs: parsePacks(req.body.packs).map(x => x.name + ':' + x.price).join(', ')
});
const files = req => (req.files || []).map(f => '/uploads/' + f.filename);
const rmFile = u => { try { fs.unlinkSync(path.join(uploads, path.basename(u))); } catch {} };
app.post('/api/admin/products', auth, upload.array('images', 8), (req, res) => {
  const f = fields(req); if (!f.name) return res.status(400).json({ error: 'Name required' });
  const im = files(req);
  db.prepare('INSERT INTO products(name,price,stock,color,description,shapes,colors,packs,category,sale_price,image,images) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(f.name, f.price, f.stock, f.color, f.description, f.shapes, f.colors, f.packs, f.category, f.sale_price, im[0] || null, JSON.stringify(im));
  res.json({ ok: true });
});
app.put('/api/admin/products/:id', auth, upload.array('images', 8), (req, res) => {
  const f = fields(req); if (!f.name) return res.status(400).json({ error: 'Name required' });
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No such product' });
  const old = imgs(p), fresh = files(req);
  let keep = old;
  if (req.body.keep !== undefined) { try { keep = JSON.parse(req.body.keep).filter(u => old.includes(u)); } catch { keep = old; } }
  const all = keep.concat(fresh).slice(0, 8);
  old.concat(fresh).filter(u => !all.includes(u)).forEach(rmFile);
  db.prepare('UPDATE products SET name=?,price=?,stock=?,color=?,description=?,shapes=?,colors=?,packs=?,category=?,sale_price=?,image=?,images=? WHERE id=?')
    .run(f.name, f.price, f.stock, f.color, f.description, f.shapes, f.colors, f.packs, f.category, f.sale_price, all[0] || null, JSON.stringify(all), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/products/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (p) imgs(p).forEach(rmFile);
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM reviews WHERE product_id=?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/api/admin/orders', auth, (_, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?');
  res.json(orders.map(o => ({ ...o, items: items.all(o.id) })));
});
app.patch('/api/admin/orders/:id', auth, (req, res) => {
  if (!['New', 'Packed', 'Shipped', 'Delivered', 'Cancelled'].includes(req.body.status)) return res.status(400).json({ error: 'Bad status' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});
app.get('/api/admin/reviews', auth, (_, res) => res.json(db.prepare(
  'SELECT r.*, p.name product FROM reviews r LEFT JOIN products p ON p.id=r.product_id ORDER BY r.id DESC').all()));
app.delete('/api/admin/reviews/:id', auth, (req, res) => {
  db.prepare('DELETE FROM reviews WHERE id=?').run(req.params.id); res.json({ ok: true });
});

app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));
app.listen(PORT, () => console.log(`CLAW & CO running → http://localhost:${PORT}  (admin: /#admin)`));