const router = require('express').Router();
const ctrl = require('../controllers/users');
router.get('/', (req, res) => {
  const { page, limit } = req.query;
  const auth = req.headers['authorization'];
  res.json([]);
});
router.get('/:id', ctrl.getUser);
router.post('/', async (req, res) => {
  const { name, email } = req.body;
  res.status(201).json({ name, email });
});
router.route('/:id/avatar').put(upload.single('file'), (req, res) => {}).delete((req, res) => {});
module.exports = router;
