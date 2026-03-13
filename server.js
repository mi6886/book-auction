const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bookadmin123';

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

// API: Place a bid
app.post('/api/books/:id/bid', (req, res) => {
  const books = readBooks();
  const idx = books.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '书籍不存在' });

  const book = books[idx];
  if (book.status !== 'bidding') {
    return res.status(400).json({ error: '拍卖已结束，无法出价' });
  }

  const { name, amount } = req.body;
  if (!name || !amount) {
    return res.status(400).json({ error: '昵称和出价金额为必填项' });
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
