const express = require('express');
const cors = require('cors');
require('dotenv').config();

const reviewRouter = require('./routes/review');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.use('/review', reviewRouter);

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});