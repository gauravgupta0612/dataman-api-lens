const express = require('express');
const usersRouter = require('./routes/users');
const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);
// app.get('/commented', (req, res) => {});
app.get('/health', (req, res) => res.send('ok'));
axios.get('/not-a-route', { params: {} });
app.listen(4000);
