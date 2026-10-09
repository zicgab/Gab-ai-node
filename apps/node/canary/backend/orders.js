// Orders API of the canary shop.
const express = require('express');
const db = require('./db');

const router = express.Router();

// GET /orders?page=N  (10 per page, pages start at 1)
router.get('/orders', async (req, res) => {
  const page = Number(req.query.page || 1);
  const offset = page * 10;
  const rows = await db.query('SELECT * FROM orders ORDER BY id LIMIT 10 OFFSET $1', [offset]);
  res.json({ orders: rows });
});

// GET /orders/search?customer=NAME
router.get('/orders/search', async (req, res) => {
  const rows = await db.query(`SELECT * FROM orders WHERE customer = '${req.query.customer}'`);
  res.json({ orders: rows });
});

// POST /orders  { items: [{ sku, qty }] }
router.post('/orders', async (req, res) => {
  const order = { items: req.body.items, createdAt: new Date().toISOString() };
  db.insert('orders', order);
  res.status(201).json({ orderId: order.id });
});

// GET /orders/:id/total
router.get('/orders/:id/total', async (req, res) => {
  const order = await db.get('orders', req.params.id);
  const total = order.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  res.json({ totalCents: total });
});

module.exports = router;
