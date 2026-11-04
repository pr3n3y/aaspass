const base = process.env.API_BASE ?? 'http://localhost:3000';

async function request(path: string, options: RequestInit = {}, token?: string) {
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status} ${text}`);
  }
  return body;
}

async function login(phone: string) {
  const otp = await request('/v1/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
  if (!otp.devCode) throw new Error('Dev OTP was not returned. Set SMS_PROVIDER=console.');
  const session = await request('/v1/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ phone, code: otp.devCode }),
  });
  return session as { accessToken: string; user: { id: string; phone: string; name: string } };
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const health = await request('/health');
assert(health.ok === true, 'health');

const resident = await login('+919100000002');
const me = await request('/v1/me', {}, resident.accessToken);
assert(me.phone === '+919100000002', 'me phone');
assert(me.flatNumber, 'own flat is visible to self');
console.log('Milestone 1: logged in and fetched /me');

const search = await request('/v1/search?q=doodh', {}, resident.accessToken);
const milk = search.products.find((product: { name: { en: string } }) => product.name.en === 'Milk');
assert(milk, 'typing doodh finds Milk');
console.log('Milestone 3: doodh finds Milk');

const deals = await request('/v1/deals', {}, resident.accessToken);
const milkDeal = deals.items.find((deal: { productId: string }) => deal.productId === milk.id);
assert(milkDeal, 'milk deal is listed');
assert(milkDeal.currentPricePaise === 6000, `starting price is tier 1, got ${milkDeal.currentPricePaise}`);

const second = await login('+919100000003');
const join = async (token: string) =>
  request(
    '/v1/orders',
    {
      method: 'POST',
      body: JSON.stringify({
        items: [{ dealId: milkDeal.id, quantity: 1 }],
        deliverySlot: 'EVENING',
        paymentMethod: 'COD',
      }),
    },
    token,
  );

const firstOrder = await join(resident.accessToken);
const secondOrder = await join(second.accessToken);
const after = await request(`/v1/deals/${milkDeal.id}`, {}, resident.accessToken);
assert(after.participantCount === 2, `expected 2 neighbours, got ${after.participantCount}`);
assert(after.currentPricePaise === 4800, `expected tier 2 price 4800, got ${after.currentPricePaise}`);
const refreshed = await request(`/v1/orders/${firstOrder.orders[0].id}`, {}, resident.accessToken);
assert(refreshed.totalPaise === 4800, `first order should reprice to 4800, got ${refreshed.totalPaise}`);
console.log('Milestone 4: second neighbour dropped the price to ₹48');

const outsider = await login('+919200000001');
const blocked = await fetch(`${base}/v1/deals/${milkDeal.id}`, {
  headers: { authorization: `Bearer ${outsider.accessToken}` },
});
assert(blocked.status === 403, `cross-society read should be 403, got ${blocked.status}`);
console.log('Cross-society access is blocked');

const admin = await login('+919000000000');
const past = new Date(Date.now() - 60_000).toISOString();
await request(
  `/v1/admin/deals/${milkDeal.id}`,
  { method: 'PATCH', body: JSON.stringify({ cutoffAt: past }) },
  admin.accessToken,
);
const cutoff = await request('/v1/admin/jobs/cutoff', { method: 'POST', body: '{}' }, admin.accessToken);
assert(cutoff.processed >= 1, 'cutoff processed the milk deal');
const confirmed = await request(`/v1/deals/${milkDeal.id}`, {}, resident.accessToken);
assert(confirmed.status === 'CONFIRMED', `deal status ${confirmed.status}`);
const confirmedOrder = await request(`/v1/orders/${secondOrder.orders[0].id}`, {}, second.accessToken);
assert(confirmedOrder.status === 'CONFIRMED', `order status ${confirmedOrder.status}`);
assert(confirmedOrder.finalTotalPaise === 4800, `final price ${confirmedOrder.finalTotalPaise}`);

const delivery = await request(`/v1/admin/deals/${milkDeal.id}/delivery-list`, {}, admin.accessToken);
assert(delivery.groups.length > 0, 'delivery list grouped by building');
await request(`/v1/admin/deals/${milkDeal.id}/mark-delivered`, { method: 'POST', body: '{}' }, admin.accessToken);
const home = await request('/v1/home', {}, resident.accessToken);
assert(home.savings.savedPaiseThisMonth === 2000, `savings ${home.savings.savedPaiseThisMonth}`);
console.log('Milestone 4: cutoff confirmed, admin marked delivered, savings updated');
console.log('Acceptance checks passed');
