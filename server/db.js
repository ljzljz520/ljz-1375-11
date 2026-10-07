/**
 * 关系型 JSON 存储（零依赖）。
 * 按需求分库：
 *  - instances 库：年度活动实例（event_instances）——组织方逐年公布，须有来源确认
 *  - rules     库：周期规则（recurrence_rules）与年历版本/缓存（calendar_versions）
 *  - articles  库：历史文章（articles）——发布后冻结，不随公告改写
 *  - content   库：编辑内容（nodes/edges/routes/route_steps/announcements/releases）
 * 每张表带自增主键、版本号（乐观锁）与基本索引；可用 --pg 切换到 Postgres 适配器（见 README）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATABASES = {
  instances: { file: 'db_instances.json', tables: ['event_instances'] },
  rules: { file: 'db_rules.json', tables: ['recurrence_rules', 'calendar_versions'] },
  articles: { file: 'db_articles.json', tables: ['articles'] },
  content: { file: 'db_content.json', tables: ['nodes', 'edges', 'routes', 'route_steps', 'announcements', 'releases'] },
};

class DB {
  constructor(dir) {
    this.dir = dir;
    this.data = {};
    for (const [name, spec] of Object.entries(DATABASES)) {
      const fp = path.join(dir, spec.file);
      let raw = {};
      if (fs.existsSync(fp)) {
        try { raw = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { raw = {}; }
      }
      raw._seq = raw._seq || {};
      for (const t of spec.tables) {
        raw[t] = raw[t] || [];
        raw._seq[t] = raw._seq[t] || 0;
      }
      this.data[name] = raw;
    }
  }

  _table(dbName, table) {
    const spec = DATABASES[dbName];
    if (!spec.tables.includes(table)) throw new Error(`未知表 ${dbName}.${table}`);
    return this.data[dbName][table];
  }

  insert(dbName, table, row) {
    const store = this.data[dbName];
    store._seq[table] += 1;
    const now = new Date().toISOString();
    const rec = {
      id: `${table}_${store._seq[table]}`,
      version: 1,
      created_at: now,
      updated_at: now,
      ...row,
    };
    this._table(dbName, table).push(rec);
    this.flush(dbName);
    return rec;
  }

  find(dbName, table, predicate) {
    return this._table(dbName, table).filter(predicate);
  }
  findOne(dbName, table, predicate) {
    return this._table(dbName, table).find(predicate) || null;
  }
  get(dbName, table, id) {
    return this.findOne(dbName, table, (r) => r.id === id);
  }
  all(dbName, table) {
    return [...this._table(dbName, table)];
  }
  count(dbName, table, predicate) {
    return predicate ? this._table(dbName, table).filter(predicate).length : this._table(dbName, table).length;
  }

  /** 乐观锁更新：expectedVersion 不匹配抛 409，不覆盖他人并发改动。 */
  update(dbName, table, id, patch, expectedVersion) {
    const rec = this.get(dbName, table, id);
    if (!rec) {
      const err = new Error(`${table}.${id} 不存在`);
      err.code = 404;
      throw err;
    }
    if (expectedVersion !== undefined && expectedVersion !== null &&
        Number(expectedVersion) !== Number(rec.version)) {
      const err = new Error('版本冲突：资源已被他人修改');
      err.code = 409;
      err.current = rec;
      throw err;
    }
    Object.assign(rec, patch, { version: rec.version + 1, updated_at: new Date().toISOString() });
    this.flush(dbName);
    return rec;
  }

  /** 物理替换（仅用于内部快照/缓存表），不步进版本。 */
  replace(dbName, table, id, replacer) {
    const rows = this._table(dbName, table);
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    rows[i] = replacer(rows[i]);
    this.flush(dbName);
    return rows[i];
  }

  flush(dbName) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(
      path.join(this.dir, DATABASES[dbName].file),
      JSON.stringify(this.data[dbName], null, 2),
    );
  }

  flushAll() {
    for (const dbName of Object.keys(DATABASES)) this.flush(dbName);
  }
}

module.exports = { DB, DATABASES };
