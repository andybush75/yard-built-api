// The one list of permission keys the server recognizes. Must match the PERMISSIONS list in
// src/public/index.html (which also carries the human-readable labels shown in Settings).
const PERMISSION_KEYS = [
  "buttonMaker",
  "voidTickets",
  "editPricing",
  "manageUsers",
  "assignWorkOrderItems",
  "adjustInventory",
  "regradeInventory",
  "packInventory",
  "addCommodity",
  "payRemittances",
  "editBankAccounts",
];

function unknownKeys(list) {
  if (!Array.isArray(list)) return ["(not a list)"];
  return list.filter((k) => !PERMISSION_KEYS.includes(k));
}

module.exports = { PERMISSION_KEYS, unknownKeys };
