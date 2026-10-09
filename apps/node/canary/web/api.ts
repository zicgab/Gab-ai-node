// Web client of the canary shop.
export async function createOrder(items: { sku: string; qty: number }[]): Promise<string> {
  const res = await fetch('/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });
  const body = await res.json();
  return body.id;
}

export async function orderTotal(id: string): Promise<number> {
  const res = await fetch(`/orders/${id}/total`);
  const body = await res.json();
  return body.totalCents;
}
