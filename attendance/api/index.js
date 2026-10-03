'use strict';
// Vercel serverless entry point: the whole Express app runs as one function.
// Static files in /public are served by Vercel's CDN; see vercel.json.
const { createApp } = require('../server');

module.exports = createApp();
