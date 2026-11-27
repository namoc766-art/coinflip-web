const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DATA_FILE = path.join(DATA_DIR, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Default database state
let db = {
  maintenance: false,
  maintenanceMessage: "We are upgrading our servers. Back shortly!",
  discordInvite: "https://discord.gg/your-invite",
  discordWebhook: "",
  users: {} // username -> { passwordHash, coins, isAdmin, token }
};

if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error("Failed to read data.json, starting fresh.");
  }
}

function saveDB() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

async function sendDiscordLog(title, description, color = 5814783) {
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
    console.error("Discord webhook error:", err.message);
  }
}

// Auth Middleware
function auth(req, res, next) {
  const token = req.headers['authorization'];
  const user = Object.entries(db.users).find(([, u]) => u.token === token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.username = user[0];
  req.user = user[1];
  next();
}

// Health check route for Render
app.get('/health', (req, res) => res.status(200).send('OK'));

// Public status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    maintenance: db.maintenance,
    maintenanceMessage: db.maintenanceMessage,
    discordInvite: db.discordInvite
  });
});

// Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: "Username (min 3) and password (min 4) required." });
  }
  const cleanUser = username.trim().toLowerCase();
  if (db.users[cleanUser]) {
    return res.status(400).json({ error: "Username already exists." });
  }

  // First registered user automatically becomes Admin
  const isFirstUser = Object.keys(db.users).length === 0;
  const token = crypto.randomBytes(24).toString('hex');

  db.users[cleanUser] = {
    passwordHash: hashPassword(password),
    coins: 1000,
    isAdmin: isFirstUser,
    token
  };
  saveDB();

  await sendDiscordLog("New User Registered", `**${cleanUser}** joined the site!`, 3066993);

  res.json({
    token,
    username: cleanUser,
    coins: 1000,
    isAdmin: isFirstUser
  });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const cleanUser = (username || "").trim().toLowerCase();
  const user = db.users[cleanUser];

  if (!user || user.passwordHash !== hashPassword(password || "")) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  if (db.maintenance && !user.isAdmin) {
    return res.status(503).json({ error: "Site is currently in Maintenance Mode." });
  }

  user.token = crypto.randomBytes(24).toString('hex');
  saveDB();

  res.json({
    token: user.token,
    username: cleanUser,
    coins: user.coins,
    isAdmin: user.isAdmin
  });
});

// Get current profile
app.get('/api/me', auth, (req, res) => {
  if (db.maintenance && !req.user.isAdmin) {
    return res.status(503).json({ error: "Maintenance Mode active", maintenance: true });
  }
  res.json({
    username: req.username,
    coins: req.user.coins,
    isAdmin: req.user.isAdmin
  });
});

// Flip Coin
app.post('/api/flip', auth, async (req, res) => {
  if (db.maintenance && !req.user.isAdmin) {
    return res.status(503).json({ error: "Site is under maintenance." });
  }

  const bet = Math.floor(Number(req.body.bet));
  const choice = req.body.choice;

  if (!['heads', 'tails'].includes(choice)) {
    return res.status(400).json({ error: "Choose heads or tails." });
  }
  if (!bet || bet <= 0 || bet > req.user.coins) {
    return res.status(400).json({ error: "Invalid bet amount." });
  }

  const outcome = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = outcome === choice;

  if (won) {
    req.user.coins += bet;
    if (bet >= 500) {
      sendDiscordLog("Big Coin Flip Win!", `**${req.username}** bet **${bet}** on ${choice.toUpperCase()} and won!`, 15844367);
    }
  } else {
    req.user.coins -= bet;
  }

  saveDB();
  res.json({ outcome, won, coins: req.user.coins });
});

// Discord Support Ticket
app.post('/api/support', auth, async (req, res) => {
  const { message } = req.body;
  if (!message || message.trim().length < 5) {
    return res.status(400).json({ error: "Please enter a detailed support message." });
  }
  await sendDiscordLog(
    `Support Ticket from ${req.username}`,
    `${message}\n\n**Balance:** ${req.user.coins} coins`,
    15158332
  );
  res.json({ success: true });
});

// --- ADMIN ROUTES ---
function adminOnly(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin access required." });
  next();
}

app.get('/api/admin/data', auth, adminOnly, (req, res) => {
  const userList = Object.entries(db.users).map(([name, u]) => ({
    username: name,
    coins: u.coins,
    isAdmin: u.isAdmin
  }));
  res.json({
    maintenance: db.maintenance,
    maintenanceMessage: db.maintenanceMessage,
    discordInvite: db.discordInvite,
    discordWebhook: db.discordWebhook,
    users: userList
  });
});

app.post('/api/admin/settings', auth, adminOnly, (req, res) => {
  const { maintenance, maintenanceMessage, discordInvite, discordWebhook } = req.body;
  if (typeof maintenance === 'boolean') db.maintenance = maintenance;
  if (typeof maintenanceMessage === 'string') db.maintenanceMessage = maintenanceMessage;
  if (typeof discordInvite === 'string') db.discordInvite = discordInvite;
  if (typeof discordWebhook === 'string') db.discordWebhook = discordWebhook;
  saveDB();
  res.json({ success: true });
});

app.post('/api/admin/user', auth, adminOnly, (req, res) => {
  const { targetUser, coins, isAdmin } = req.body;
  const user = db.users[targetUser];
  if (!user) return res.status(404).json({ error: "User not found." });

  if (coins !== undefined && !isNaN(Number(coins))) {
    user.coins = Math.max(0, Math.floor(Number(coins)));
  }
  if (typeof isAdmin === 'boolean') {
    user.isAdmin = isAdmin;
  }
  saveDB();
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CoinFlip server running on port ${PORT}`);
});
