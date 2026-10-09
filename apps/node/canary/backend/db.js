// Minimal database wrapper (stub for the canary).
module.exports = {
  query: async (sql, params = []) => [],
  insert: async (table, row) => ({ ...row, id: 1 }),
  get: async (table, id) => ({ id, items: [] }),
};
