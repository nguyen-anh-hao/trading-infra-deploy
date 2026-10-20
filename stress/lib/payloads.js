// Request bodies shared by the scenarios.
//
// Prices and quantities are strings on purpose: every service uses fixed-point
// money and rejects (or silently truncates) binary floating point.

export function money(value) {
  return Number(value).toFixed(2);
}

export function qty(value) {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(n);
}

export function orderBody(symbol, side, type, price, quantity, tif, clientOrderID) {
  const body = {
    symbol: String(symbol).toUpperCase(),
    side: String(side).toUpperCase(),
    type: String(type || 'LIMIT').toUpperCase(),
    quantity: String(quantity),
    time_in_force: String(tif || 'GTC').toUpperCase(),
  };
  if (price !== undefined && price !== null && String(price) !== '') {
    body.price = money(price);
  }
  if (clientOrderID) {
    body.client_order_id = clientOrderID;
  }
  return JSON.stringify(body);
}

export function settleBody(input) {
  return JSON.stringify({
    trade_id: input.tradeId,
    symbol: String(input.symbol).toUpperCase(),
    price: money(input.price),
    quantity: String(input.quantity),
    buyer_fee: money(input.buyerFee || 0),
    seller_fee: money(input.sellerFee || 0),
    maker_order_id: input.makerOrderId || 0,
    taker_order_id: input.takerOrderId || 0,
    maker_account_id: input.makerAccountId,
    taker_account_id: input.takerAccountId,
    buyer_account_id: input.buyerAccountId,
    seller_account_id: input.sellerAccountId,
  });
}

export function riskCheckBody(accountID, symbol, side, price, quantity, fee) {
  return JSON.stringify({
    account_id: accountID,
    symbol: String(symbol).toUpperCase(),
    side: String(side).toUpperCase(),
    type: 'LIMIT',
    price: money(price),
    quantity: String(quantity),
    fee: money(fee || 0),
  });
}

export function riskApplyBody(accountID, symbol, side, price, quantity, fee, reserved) {
  return JSON.stringify({
    account_id: accountID,
    symbol: String(symbol).toUpperCase(),
    side: String(side).toUpperCase(),
    price: money(price),
    quantity: String(quantity),
    fee: money(fee || 0),
    reserved: money(reserved || 0),
  });
}

// parse engine/order responses without throwing on a rejected order.
export function safeJson(res) {
  try {
    return res.json();
  } catch (err) {
    return null;
  }
}
