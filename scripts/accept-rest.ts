const base = process.env.API_BASE ?? 'http://localhost:3000';

async function request(path: string, options: RequestInit = {}, token?: string) {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof Buffer)) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status} ${text}`);
  return body;
}

async function login(phone: string) {
  const otp = await request('/v1/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone }) });
  const session = await request('/v1/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ phone, code: otp.devCode }),
  });
  return session.accessToken as string;
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const resident = await login('+919100000002');
const second = await login('+919100000003');
const outsider = await login('+919200000001');
const committee = await login('+919100000001');
const admin = await login('+919000000000');

const types = await request('/v1/services/types', {}, resident);
const electrician = types.items.find((item: { name: { en: string } }) => item.name.en === 'Electrician');
assert(electrician, 'electrician service type');
const providers = await request(`/v1/services/providers?type=${electrician.id}`, {}, resident);
const sponsored = providers.items[0];
assert(sponsored.isSponsored === true, 'sponsored provider is first');
assert(sponsored.recommendationCount >= 1, 'sponsored provider still shows real recommendations');
assert(!('flatNumber' in sponsored), 'provider payload has no flat');

const today = new Date();
today.setDate(today.getDate() + 1);
const date = today.toISOString().slice(0, 10);
const created = await request(
  '/v1/services/requests',
  {
    method: 'POST',
    body: JSON.stringify({ serviceTypeId: electrician.id, preferredDate: date, preferredSlot: 'MORNING', note: 'Tube light' }),
  },
  resident,
);
const joined = await request(`/v1/services/requests/${created.id}/join`, { method: 'POST', body: '{}' }, second);
assert(joined.joinerCount === 2, `expected 2 neighbours, got ${joined.joinerCount}`);
assert(joined.suggestedProvider?.name === 'Raju Electricals', `expected Raju, got ${joined.suggestedProvider?.name}`);
assert(typeof joined.suggestedProvider.whatsappUrl === 'string', 'whatsapp link for the provider');
console.log('Milestone 5: two neighbours see the suggested electrician');

const categories = await request('/v1/categories?kind=LISTING', {}, resident);
const furniture = categories.items[0];
const listing = await request(
  '/v1/listings',
  {
    method: 'POST',
    body: JSON.stringify({
      categoryId: furniture.id,
      type: 'SELL',
      title: 'Study lamp',
      pricePaise: 25000,
      photos: ['https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=800&q=70'],
      contactWhatsappAllowed: true,
      contactCallAllowed: false,
    }),
  },
  resident,
);
assert(listing.pricePaise === 25000, 'price stored as paise');
assert(!('phone' in listing) && !('flatNumber' in listing), 'listing hides phone and flat');
const contact = await request(
  `/v1/listings/${listing.id}/contact`,
  { method: 'POST', body: JSON.stringify({ channel: 'WHATSAPP' }) },
  second,
);
assert(String(contact.url).startsWith('https://wa.me/'), 'whatsapp contact opens a link');
const hidden = await fetch(`${base}/v1/listings/${listing.id}`, { headers: { authorization: `Bearer ${outsider}` } });
assert(hidden.status === 404, `other society cannot see a society-only listing, got ${hidden.status}`);
const banned = await fetch(`${base}/v1/listings`, {
  method: 'POST',
  headers: { authorization: `Bearer ${resident}`, 'content-type': 'application/json' },
  body: JSON.stringify({ categoryId: furniture.id, type: 'SELL', title: 'old pistol', pricePaise: 100 }),
});
assert(banned.status === 400, 'prohibited item is rejected');
await request(`/v1/listings/${listing.id}/sold`, { method: 'POST', body: '{}' }, resident);
console.log('Milestone 6: listing posted, contacted, and marked sold');

const alert = await request(
  '/v1/notices',
  {
    method: 'POST',
    body: JSON.stringify({ title: 'Lift stuck', body: 'Use the stairs. The lift on A wing is stuck.', isEmergency: true }),
  },
  committee,
);
assert(alert.isEmergency === true, 'emergency notice');
const notes = await request('/v1/me/notifications', {}, resident);
const emergency = notes.items.find((item: { type: string }) => item.type === 'emergency');
assert(emergency, 'resident received the emergency alert');
const home = await request('/v1/home', {}, resident);
assert(home.emergency?.isEmergency === true, 'home shows the emergency banner');
console.log('Milestone 7: society admin emergency reached a resident');

const campaign = await request(
  '/v1/admin/ads',
  {
    method: 'POST',
    body: JSON.stringify({
      advertiserName: 'Cool Air AC',
      kind: 'ORDER_BANNER',
      title: 'AC service this week',
      imageUrl: 'https://images.unsplash.com/photo-1581092918056-0c4c3acd3789?auto=format&fit=crop&w=800&q=70',
      actionType: 'WHATSAPP',
      actionValue: '+919830000009',
      dailyImpressionCap: 1000,
      targetSocietyIds: [],
    }),
  },
  admin,
);
const slot = await request('/v1/ads/slot?placement=order', {}, resident);
assert(slot.ad?.id === campaign.id, 'campaign is the order banner');
assert(slot.ad.label === 'sponsored', 'banner is labelled sponsored');
await request(`/v1/ads/${campaign.id}/impression`, { method: 'POST', body: '{}' }, resident);
await request(`/v1/ads/${campaign.id}/tap`, { method: 'POST', body: '{}' }, resident);
const report = await request('/v1/admin/ads/report', {}, admin);
const row = report.items.find((item: { adId: string }) => item.adId === campaign.id);
assert(row && row.impressions >= 1 && row.taps >= 1, 'admin report shows impressions and taps');
const dashboard = await request('/v1/admin/analytics/dashboard', {}, admin);
assert(typeof dashboard.weeklyActiveResidents === 'number', 'dashboard');
console.log('Milestone 8: sponsored banner recorded an impression and a tap');

const presign = await request(
  '/v1/uploads/presign',
  { method: 'POST', body: JSON.stringify({ contentType: 'image/jpeg', bytes: 1024 }) },
  resident,
);
assert(String(presign.uploadUrl).includes('X-Amz-Signature'), 'presigned upload');
assert(String(presign.publicUrl).includes('/v1/media/uploads/'), 'photo is served by the API');
console.log('Milestone 9: upload check, privacy on listings, and dashboard are in place');
