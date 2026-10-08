const express = require('express');
const { runCodeReview } = require('../services/langchainAgent');

const router = express.Router();

router.post('/', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: 'Code is required' });
        }
        const review = await runCodeReview(code);
        res.json({ review });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;