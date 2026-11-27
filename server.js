const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db = {
  maintenance: false,
  maintenanceMessage: 'Under maintenance. Back soon.',
  discordInvite: 'https://discord.gg/your-invite',
  discordWebhook: '',
  items: [
    {
      id: 'vip_role',
      name: 'VIP Discord Role',
      price: 2500,
      description: 'Claim a VIP role in our Discord server! Open a support ticket after buying.',
      stock: -1 // -1 means unlimited
    }
  ],
  users: {}
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = { ...db, ...loaded };
    if (!Array.isArray(db.items)) db.items = [];
  } catch (err) {
    console.error('Could not parse data.json, using default state:', err.message);
  }
}

function saveDB() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

async function notifyDiscord(title, description, color = 5814783) {
  if (!db.discordWebhook) return;
  try {
    await fetch(db.discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ title, description, color, timestamp: new Date().toISOString() }]
      })
    });
  } catch (err) {
    console.error('Discord webhook failed:', err.message);
  }
}

function auth(req, res, next) {
  const token = req.headers['authorization'];
  const found = Object.entries(db.users).find(([, u]) => u.token === token);
  if (!found) return res.status(401).json({ error: 'Unauthorized' });
  req.username = found[0];
  req.user = found[1];
  if (!Array.isArray(req.user.inventory)) req.user.inventory = [];
  next();
}

function adminOnly(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/status', (req, res) => {
  res.json({
    maintenance: db.maintenance,
    maintenanceMessage: db.maintenanceMessage,
    discordInvite: db.discordInvite
  });
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  const cleanUser = (username || '').trim().toLowerCase();
  if (cleanUser.length < 3 || !password || password.length < 4) {
    return res.status(400).json({ error: 'Username (3+ chars) and password (4+ chars) required.' });
  }
  if (db.users[cleanUser]) {
    return res.status(400).json({ error: 'Username already taken.' });
  }

  const isFirstUser = Object.keys(db.users).length === 0;
  const token = crypto.randomBytes(24).toString('hex');

  db.users[cleanUser] = {
    passwordHash: hashPassword(password),
    coins: 1000,
    isAdmin: isFirstUser,
    inventory: [],
    token
  };
  saveDB();

  await notifyDiscord('New Player Registered', `**${cleanUser}** joined with 1,000 coins.`, 3066993);
  res.json({
    token,
    username: cleanUser,
    coins: 1000,
    isAdmin: isFirstUser,
    inventory: []
  });
});

app.post('/api/login', (req, res) => {
  const cleanUser = (req.body.username || '').trim().toLowerCase();
  const user = db.users[cleanUser];
  if (!user || user.passwordHash !== hashPassword(req.body.password || '')) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  if (db.maintenance && !user.isAdmin) {
    return res.status(503).json({ error: db.maintenanceMessage, maintenance: true });
  }
  if (!Array.isArray(user.inventory)) user.inventory = [];

  user.token = crypto.randomBytes(24).toString('hex');
  saveDB();
  res.json({
    token: user.token,
    username: cleanUser,
    coins: user.coins,
    isAdmin: user.isAdmin,
    inventory: user.inventory
  });
});

app.get('/api/me', auth, (req, res) => {
  if (db.maintenance && !req.user.isAdmin) {
    return res.status(503).json({ error: db.maintenanceMessage, maintenance: true });
  }
  res.json({
    username: req.username,
    coins: req.user.coins,
    isAdmin: req.user.isAdmin,
    inventory: req.user.inventory
  });
});

app.post('/api/flip', auth, async (req, res) => {
  if (db.maintenance && !req.user.isAdmin) {
    return res.status(503).json({ error: db.maintenanceMessage, maintenance: true });
  }

  const bet = Math.floor(Number(req.body.bet));
  const choice = req.body.choice;
  if (!['heads', 'tails'].includes(choice)) {
    return res.status(400).json({ error: 'Choice must be heads or tails.' });
  }
  if (!bet || bet < 1 || bet > req.user.coins) {
    return res.status(400).json({ error: 'Invalid bet amount.' });
  }

  const outcome = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = outcome === choice;
  req.user.coins += won ? bet : -bet;
  saveDB();

  if (won && bet >= 500) {
    await notifyDiscord('Big Flip Win', `**${req.username}** won **${bet}** coins on ${choice}.`, 15844367);
  }

  res.json({ outcome, won, coins: req.user.coins });
});

// --- SHOP ROUTES ---
app.get('/api/shop', auth, (req, res) => {
  if (db.maintenance && !req.user.isAdmin) {
    return res.status(503).json({ error: db.maintenanceMessage, maintenance: true });
  }
  res.json({ items: db.items, inventory: req.user.inventory });
});

app.post('/api/shop/buy', auth, async (req, res) => {
  if (db.maintenance && !req.user.isAdmin) {
    return res.status(503).json({ error: db.maintenanceMessage, maintenance: true });
  }

  const item = db.items.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  if (item.stock === 0) return res.status(400).json({ error: 'Item is out of stock.' });
  if (req.user.coins < item.price) {
    return res.status(400).json({ error: 'Not enough coins.' });
  }

  req.user.coins -= item.price;
  if (item.stock > 0) item.stock -= 1;

  req.user.inventory.push({
    id: item.id,
    name: item.name,
    price: item.price,
    boughtAt: new Date().toISOString()
  });

  saveDB();

  await notifyDiscord(
    'Shop Purchase',
    `**${req.username}** bought **${item.name}** for **${item.price}** coins!`,
    10181046
  );

  res.json({
    coins: req.user.coins,
    inventory: req.user.inventory,
    items: db.items
  });
});

app.post('/api/support', auth, async (req, res) => {
  const message = (req.body.message || '').trim();
  if (message.length < 4) {
    return res.status(400).json({ error: 'Please write a longer message.' });
  }
  await notifyDiscord(
    `Support Request: ${req.username}`,
    `${message}\n\nCoins: ${req.user.coins}`,
    15158332
  );
  res.json({ ok: true });
});

// --- ADMIN ROUTES ---
app.get('/api/admin/data', auth, adminOnly, (req, res) => {
  const users = Object.entries(db.users).map(([username, u]) => ({
    username,
    coins: u.coins,
    isAdmin: u.isAdmin,
    itemCount: Array.isArray(u.inventory) ? u.inventory.length : 0
  }));
  res.json({
    maintenance: db.maintenance,
    maintenanceMessage: db.maintenanceMessage,
    discordInvite: db.discordInvite,
    discordWebhook: db.discordWebhook,
    items: db.items,
    users
  });
});

app.post('/api/admin/settings', auth, adminOnly, (req, res) => {
  if (typeof req.body.maintenance === 'boolean') db.maintenance = req.body.maintenance;
  if (typeof req.body.maintenanceMessage === 'string') db.maintenanceMessage = req.body.maintenanceMessage;
  if (typeof req.body.discordInvite === 'string') db.discordInvite = req.body.discordInvite;
  if (typeof req.body.discordWebhook === 'string') db.discordWebhook = req.body.discordWebhook;
  saveDB();
  res.json({ ok: true });
});

app.post('/api/admin/items', auth, adminOnly, (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  const price = Math.floor(Number(req.body.price));
  const stockRaw = req.body.stock;
  const stock = stockRaw === '' || stockRaw === undefined || Number(stockRaw) < 0
    ? -1
    : Math.floor(Number(stockRaw));

  if (!name || Number.isNaN(price) || price < 1) {
    return res.status(400).json({ error: 'Valid item name and price (1+) required.' });
  }

  db.items.push({
    id: crypto.randomBytes(6).toString('hex'),
    name,
    price,
    description: description || 'Shop item',
    stock
  });
  saveDB();
  res.json({ ok: true, items: db.items });
});

app.delete('/api/admin/items/:id', auth, adminOnly, (req, res) => {
  db.items = db.items.filter(i => i.id !== req.params.id);
  saveDB();
  res.json({ ok: true, items: db.items });
});

app.post('/api/admin/user', auth, adminOnly, (req, res) => {
  const user = db.users[req.body.targetUser];
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (req.body.coins !== undefined && !Number.isNaN(Number(req.body.coins))) {
    user.coins = Math.max(0, Math.floor(Number(req.body.coins)));
  }
  if (typeof req.body.isAdmin === 'boolean') {
    user.isAdmin = req.body.isAdmin;
  }
  saveDB();
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
