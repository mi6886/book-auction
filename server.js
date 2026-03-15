const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bookadmin123';

// WeChat config
const WX_APPID = process.env.WX_APPID || 'wxab11b6507af6422a';
const WX_SECRET = process.env.WX_SECRET || '';
const WX_REDIRECT_BASE = process.env.WX_REDIRECT_BASE || 'https://book-auction.onrender.com';

// Simple session store (in-memory, resets on restart)
const sessions = {};
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

// Ensure data directories exist
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BOOKS_FILE = path.join(DATA_DIR, 'books.json');

[DATA_DIR, UPLOAD_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

if (!fs.existsSync(BOOKS_FILE)) {
  fs.writeFileSync(BOOKS_FILE, '[]', 'utf-8');
}

// Multer config for image upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `book_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype.split('/')[1]);
    cb(null, ext || mime);
  }
});

app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

// Admin password verification API
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

// Middleware: protect admin API routes (POST/PATCH/DELETE on /api/books)
function requireAdmin(req, res, next) {
  const adminPwd = req.headers['x-admin-password'];
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '需要管理员权限' });
  }
  next();
}

// Cookie parser (simple)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.trim().split('=');
      req.cookies[name] = decodeURIComponent(rest.join('='));
    });
  }
  next();
});

// Get current logged-in user from session cookie
function getSessionUser(req) {
  const sid = req.cookies && req.cookies.wx_session;
  if (sid && sessions[sid]) return sessions[sid];
  return null;
}

// WeChat OAuth: Step 1 - Redirect to WeChat authorization page
app.get('/auth/wechat', (req, res) => {
  const redirectUri = encodeURIComponent(`${WX_REDIRECT_BASE}/auth/wechat/callback`);
  const state = crypto.randomBytes(8).toString('hex');
  // 先尝试 snsapi_userinfo（需已认证），如失败可改为 snsapi_base
  const scope = 'snsapi_userinfo';
  const url = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${WX_APPID}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}#wechat_redirect`;
  res.redirect(url);
});

// WeChat OAuth: Step 2 - Handle callback, exchange code for user info
app.get('/auth/wechat/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('授权失败：缺少 code 参数');
  }

  try {
    // Exchange code for access_token
    const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WX_APPID}&secret=${WX_SECRET}&code=${code}&grant_type=authorization_code`;
    console.log('Requesting token with appid:', WX_APPID, 'secret length:', WX_SECRET.length);
    const tokenRes = await axios.get(tokenUrl);

    console.log('Token response:', JSON.stringify(tokenRes.data));
    const tokenData = tokenRes.data;

    if (tokenData.errcode) {
      return res.status(500).send(`微信授权失败(${tokenData.errcode}): ${tokenData.errmsg}<br><br>AppID: ${WX_APPID}<br>Secret长度: ${WX_SECRET.length}`);
    }

    const { access_token, openid, scope } = tokenData;
    let nickname = '微信用户';
    let headimgurl = '';

    // 如果是 snsapi_userinfo 授权，获取用户详细信息
    if (scope && scope.includes('snsapi_userinfo')) {
      try {
        const userRes = await axios.get(`https://api.weixin.qq.com/sns/userinfo?access_token=${access_token}&openid=${openid}&lang=zh_CN`);
        console.log('UserInfo response:', JSON.stringify(userRes.data));

        if (!userRes.data.errcode) {
          nickname = userRes.data.nickname || '微信用户';
          headimgurl = userRes.data.headimgurl || '';
        }
      } catch (ue) {
        console.error('Get userinfo failed:', ue.message);
      }
    }

    // Save user
    const users = readUsers();
    users[openid] = {
      openid,
      nickname,
      avatar: headimgurl,
      lastLogin: Date.now()
    };
    writeUsers(users);

    // Create session
    const sessionId = crypto.randomBytes(16).toString('hex');
    sessions[sessionId] = users[openid];

    // Set cookie and redirect to home
    res.setHeader('Set-Cookie', `wx_session=${sessionId}; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax`);
    res.redirect('/');
  } catch (err) {
    console.error('WeChat auth error:', err.message, err.response ? err.response.data : '');
    res.status(500).send(`微信登录失败: ${err.message}`);
  }
});

// API: Get current user info
app.get('/api/user/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.json({ loggedIn: false });
  }
  res.json({
    loggedIn: true,
    nickname: user.nickname,
    avatar: user.avatar,
    openid: user.openid
  });
});

// API: Logout
app.post('/api/user/logout', (req, res) => {
  const sid = req.cookies && req.cookies.wx_session;
  if (sid) {
    delete sessions[sid];
  }
  res.setHeader('Set-Cookie', 'wx_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// Helper: read/write books
function readBooks() {
  return JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf-8'));
}

function writeBooks(books) {
  fs.writeFileSync(BOOKS_FILE, JSON.stringify(books, null, 2), 'utf-8');
}

// API: Get all books
app.get('/api/books', (req, res) => {
  const books = readBooks();
  res.json(books.sort((a, b) => b.createdAt - a.createdAt));
});

// API: Get single book
app.get('/api/books/:id', (req, res) => {
  const books = readBooks();
  const book = books.find(b => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: '书籍不存在' });
  res.json(book);
});

// API: Create book (with image upload) - admin only
app.post('/api/books', requireAdmin, upload.array('images', 5), (req, res) => {
  const { title, author, description, startPrice, bidStep, condition } = req.body;

  if (!title || !startPrice) {
    return res.status(400).json({ error: '书名和起拍价为必填项' });
  }

  const images = (req.files || []).map(f => `/uploads/${f.filename}`);

  const book = {
    id: `book_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    author: author || '',
    description: description || '',
    startPrice: parseFloat(startPrice),
    bidStep: parseFloat(bidStep) || 1,
    condition: condition || '九成新',
    images,
    bids: [],             // { name, amount, time }
    status: 'bidding',    // bidding, ended, sold
    createdAt: Date.now()
  };

  const books = readBooks();
  books.push(book);
  writeBooks(books);

  res.json(book);
});

// API: Place a bid (requires WeChat login)
app.post('/api/books/:id/bid', (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: '请先微信登录后再出价' });
  }

  const books = readBooks();
  const idx = books.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '书籍不存在' });

  const book = books[idx];
  if (book.status !== 'bidding') {
    return res.status(400).json({ error: '拍卖已结束，无法出价' });
  }

  const { amount } = req.body;
  const name = user.nickname;
  if (!amount) {
    return res.status(400).json({ error: '出价金额为必填项' });
  }

  const bidAmount = parseFloat(amount);
  const currentHighest = book.bids.length > 0
    ? book.bids[book.bids.length - 1].amount
    : book.startPrice;

  const minBid = book.bids.length > 0
    ? currentHighest + book.bidStep
    : book.startPrice;

  if (bidAmount < minBid) {
    return res.status(400).json({
      error: `出价必须不低于 ¥${minBid.toFixed(0)}`,
      minBid
    });
  }

  book.bids.push({
    name: name.trim(),
    amount: bidAmount,
    time: Date.now()
  });

  writeBooks(books);
  res.json(book);
});

// API: End auction (seller action) - admin only
app.post('/api/books/:id/end', requireAdmin, (req, res) => {
  const books = readBooks();
  const idx = books.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '书籍不存在' });

  const book = books[idx];
  book.status = 'ended';

  if (book.bids.length > 0) {
    const winner = book.bids[book.bids.length - 1];
    book.winner = { name: winner.name, amount: winner.amount };
  }

  writeBooks(books);
  res.json(book);
});

// API: Mark as sold - admin only
app.post('/api/books/:id/sold', requireAdmin, (req, res) => {
  const books = readBooks();
  const idx = books.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '书籍不存在' });

  books[idx].status = 'sold';
  writeBooks(books);
  res.json(books[idx]);
});

// API: Update book - admin only
app.patch('/api/books/:id', requireAdmin, (req, res) => {
  const books = readBooks();
  const idx = books.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '书籍不存在' });

  const { status } = req.body;
  if (status) books[idx].status = status;

  writeBooks(books);
  res.json(books[idx]);
});

// API: Delete book - admin only
app.delete('/api/books/:id', requireAdmin, (req, res) => {
  let books = readBooks();
  const book = books.find(b => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: '书籍不存在' });

  book.images.forEach(img => {
    const filePath = path.join(__dirname, img);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  books = books.filter(b => b.id !== req.params.id);
  writeBooks(books);
  res.json({ success: true });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`📚 书籍拍卖服务已启动: http://localhost:${PORT}`);
  console.log(`   管理后台: http://localhost:${PORT}/admin.html`);
});
