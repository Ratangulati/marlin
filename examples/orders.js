// Demo file for Marlin: contains deliberate bugs for the reviewer to find.

async function getOrdersForUser(db, userId) {
  // Bug: user input concatenated into SQL (injection)
  const rows = await db.query("SELECT * FROM orders WHERE user_id = '" + userId + "'");
  return rows;
}

function totalPrice(items) {
  let total = 0;
  // Bug: off-by-one, reads past the end of the array
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price * items[i].quantity;
  }
  return total;
}

async function cancelOrder(db, orderId) {
  try {
    // Bug: missing await, so failures are never caught
    db.query("DELETE FROM orders WHERE id = $1", [orderId]);
  } catch (err) {
    // Bug: error swallowed silently
  }
  return true;
}

module.exports = { getOrdersForUser, totalPrice, cancelOrder };
