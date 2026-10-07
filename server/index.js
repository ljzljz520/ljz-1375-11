'use strict';
const path = require('path');
const { createApp } = require('./app');
const { seed } = require('./seed');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
seed(DATA_DIR);
const server = createApp(DATA_DIR);
server.listen(PORT, () => {
  console.log(`西安文化站·节庆路线与年历  http://localhost:${PORT}`);
  console.log(`  访客年历:  /calendar.html?year=2027&node=...&view=list`);
  console.log(`  编辑后台:  /app/`);
});
