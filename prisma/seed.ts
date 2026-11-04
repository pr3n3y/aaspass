import { Prisma, PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { i18n } from '../src/lib/i18n.ts';

const prisma = new PrismaClient();

const photo = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=800&q=70`;

const NAMES = [
  'Sunita Patil',
  'Asha More',
  'Meena Joshi',
  'Rekha Kulkarni',
  'Lata Deshmukh',
  'Kavita Shah',
  'Pooja Jadhav',
  'Nirmala Pawar',
  'Savita Naik',
  'Anita Bhosale',
  'Geeta Chavan',
  'Shobha Rane',
  'Vandana Kadam',
  'Usha Salvi',
  'Mangala Tare',
  'Ramesh Patil',
  'Suresh More',
  'Mahesh Joshi',
  'Prakash Kulkarni',
  'Nitin Deshmukh',
  'Ajay Shah',
  'Vijay Jadhav',
  'Santosh Pawar',
  'Deepak Naik',
  'Rahul Bhosale',
  'Kiran Chavan',
  'Amit Rane',
  'Sachin Kadam',
  'Ganesh Salvi',
  'Yogesh Tare',
];

async function wipe() {
  await prisma.adStatDaily.deleteMany();
  await prisma.ad.deleteMany();
  await prisma.analyticsEvent.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.appNotification.deleteMany();
  await prisma.report.deleteMany();
  await prisma.block.deleteMany();
  await prisma.pollVote.deleteMany();
  await prisma.pollOption.deleteMany();
  await prisma.poll.deleteMany();
  await prisma.eventRsvp.deleteMany();
  await prisma.event.deleteMany();
  await prisma.suggestion.deleteMany();
  await prisma.lostFoundItem.deleteMany();
  await prisma.userConsent.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.otpRequest.deleteMany();
  await prisma.standingRequest.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.dealTier.deleteMany();
  await prisma.dealSociety.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.providerRecommendation.deleteMany();
  await prisma.serviceRequestJoiner.deleteMany();
  await prisma.serviceRequest.deleteMany();
  await prisma.serviceProvider.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.notice.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.building.deleteMany();
  await prisma.vendor.deleteMany();
  await prisma.society.deleteMany();
}

async function main() {
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await wipe();

  const society = await prisma.society.create({
    data: {
      name: 'Green Valley CHS',
      slug: 'green-valley-virar',
      area: 'Virar West',
      city: 'Virar',
      pincode: '401303',
      lat: new Prisma.Decimal('19.455800'),
      lng: new Prisma.Decimal('72.811500'),
      code: 'GV4K2M',
      subscriptionStatus: 'NONE',
      subscriptionPriceInr: 100,
    },
  });

  const other = await prisma.society.create({
    data: {
      name: 'Palm Court',
      slug: 'palm-court-nalasopara',
      area: 'Nalasopara East',
      city: 'Nalasopara',
      pincode: '401209',
      code: 'PLM9Q2',
    },
  });

  const wings = await Promise.all(
    ['A Wing', 'B Wing', 'C Wing'].map((name) =>
      prisma.building.create({ data: { societyId: society.id, name } }),
    ),
  );
  const otherWing = await prisma.building.create({
    data: { societyId: other.id, name: 'A Wing' },
  });

  await prisma.user.create({
    data: {
      phone: '+919000000000',
      name: 'Aaspaas Admin',
      language: 'EN',
      role: 'SUPER_ADMIN',
      membershipStatus: 'APPROVED',
    },
  });

  const residents = [];
  for (let index = 0; index < NAMES.length; index += 1) {
    const phone = `+9191000000${String(index + 1).padStart(2, '0')}`;
    const pending = index >= 28;
    const user = await prisma.user.create({
      data: {
        phone,
        name: NAMES[index],
        language: index % 5 === 0 ? 'HI' : 'MR',
        role: index === 0 ? 'SOCIETY_ADMIN' : 'RESIDENT',
        societyId: society.id,
        buildingId: wings[index % 3].id,
        flatNumber: `${(index % 5) + 1}0${(index % 4) + 1}`,
        membershipStatus: pending ? 'PENDING' : 'APPROVED',
      },
    });
    residents.push(user);
  }

  await prisma.user.create({
    data: {
      phone: '+919200000001',
      name: 'Pallavi Rane',
      language: 'MR',
      role: 'RESIDENT',
      societyId: other.id,
      buildingId: otherWing.id,
      flatNumber: '201',
      membershipStatus: 'APPROVED',
    },
  });

  const milkVendor = await prisma.vendor.create({
    data: {
      name: 'Patil Milk Supply',
      phone: '+919820000001',
      whatsapp: '+919820000001',
      address: 'Shop 4, Virar West market',
      area: 'Virar West',
      isVerified: true,
      status: 'ACTIVE',
    },
  });
  const vegVendor = await prisma.vendor.create({
    data: {
      name: 'More Vegetables',
      phone: '+919820000002',
      whatsapp: '+919820000002',
      address: 'Stall 12, Virar market',
      area: 'Virar West',
      isVerified: true,
      status: 'ACTIVE',
    },
  });
  const grocer = await prisma.vendor.create({
    data: {
      name: 'Joshi General Store',
      phone: '+919820000003',
      whatsapp: '+919820000003',
      address: 'Green Valley road, Virar West',
      area: 'Virar West',
      isVerified: true,
      status: 'ACTIVE',
    },
  });
  const vendors = { milk: milkVendor, veg: vegVendor, grocer };

  const productCategoryInput = [
    ['Vegetables', 'सब्ज़ी', 'भाज्या', 'photo-1540420773420-3366772f4999', ['vegetables', 'bhaji', 'sabzi', 'भाजी', 'सब्जी']],
    ['Fruits', 'फल', 'फळे', 'photo-1619566636858-adf3ef46400b', ['fruits', 'phal', 'फल', 'फळे']],
    ['Milk and Dairy', 'दूध और डेयरी', 'दूध आणि दुग्ध', 'photo-1550583724-b2692b85b150', ['milk', 'doodh', 'dudh', 'dairy', 'दूध']],
    ['Grocery and Atta', 'किराना और आटा', 'किराणा आणि पीठ', 'photo-1574323347407-f5e1ad6d020b', ['grocery', 'atta', 'aata', 'kirana', 'आटा', 'पीठ']],
    ['Cold Drinks and Snacks', 'कोल्ड ड्रिंक और स्नैक्स', 'कोल्ड ड्रिंक आणि स्नॅक्स', 'photo-1554866585-cd94860890b7', ['cold drink', 'snacks', 'thanda', 'कोल्ड']],
    ['Festival Items', 'त्योहार का सामान', 'सणाचे सामान', 'photo-1604594849809-dfedbc827105', ['festival', 'diwali', 'diwali', 'त्योहार']],
    ['Cleaning Items', 'सफाई का सामान', 'स्वच्छतेचे सामान', 'photo-1563453392212-326f5e854473', ['cleaning', 'safai', 'सफाई']],
    ['Stationery', 'स्टेशनरी', 'स्टेशनरी', 'photo-1456735190827-d1262f71b8a3', ['stationery', 'notebook', 'pen', ' वही']],
  ] as const;

  const productCategories: Record<string, string> = {};
  for (let index = 0; index < productCategoryInput.length; index += 1) {
    const [en, hi, mr, image, keywords] = productCategoryInput[index];
    const category = await prisma.category.create({
      data: {
        kind: 'PRODUCT',
        nameI18n: i18n(en, hi, mr),
        imageUrl: photo(image),
        searchKeywords: [...keywords],
        sortOrder: index + 1,
      },
    });
    productCategories[en] = category.id;
  }

  const serviceInput = [
    ['Electrician', 'इलेक्ट्रीशियन', 'इलेक्ट्रीशियन', 'photo-1621905251189-08b45d6a269e', ['electrician', 'bijli', 'wire', 'इलेक्ट्रीशियन']],
    ['Plumber', 'प्लंबर', 'प्लंबर', 'photo-1607472586893-edb57bdc0e39', ['plumber', 'nal', 'pipe', 'प्लंबर']],
    ['Maid', 'मेड', 'बाई', 'photo-1581578731548-c64695cc6952', ['maid', 'bai', 'kaamwali', 'बाई']],
    ['Cook', 'कुक', 'स्वयंपाकी', 'photo-1556910103-1c02745aae4d', ['cook', 'bawarchi', 'cook']],
    ['AC Repair', 'एसी रिपेयर', 'एसी दुरुस्ती', 'photo-1631545806609-6b6e0c6c0c0a', ['ac', 'ac repair', 'एसी']],
    ['Carpenter', 'बढ़ई', 'सुतार', 'photo-1601058268499-e52658b8bb88', ['carpenter', 'sutar', 'badhai']],
    ['Washing machine repair', 'वॉशिंग मशीन रिपेयर', 'वॉशिंग मशीन दुरुस्ती', 'photo-1626806787461-102c1bfaaea1', ['washing', 'machine', 'washer']],
    ['Pest control', 'पेस्ट कंट्रोल', 'पेस्ट कंट्रोल', 'photo-1581578731548-c64695cc6952', ['pest', 'cockroach', 'कीड़े']],
    ['Driver', 'ड्राइवर', 'ड्रायव्हर', 'photo-1449965408869-eaa3f722e40d', ['driver', 'driver']],
    ['Tutor', 'ट्यूटर', 'शिक्षक', 'photo-1503676260728-1c00da094a0b', ['tutor', 'teacher', 'tuition']],
    ['Babysitter', 'बेबीसिटर', 'बेबीसिटर', 'photo-1544776193-352d25ca82cd', ['babysitter', 'nanny']],
    ['Home cleaning', 'घर की सफाई', 'घर स्वच्छता', 'photo-1581578731548-c64695cc6952', ['cleaning', 'safai', 'सफाई']],
    ['Movers', 'मूवर्स', 'सामान हलवायचे', 'photo-1600518464441-9154a4dea21b', ['movers', 'shifting', 'packers']],
    ['Water purifier', 'वॉटर प्यूरीफायर', 'वॉटर प्युरिफायर', 'photo-1563453392212-326f5e854473', ['ro', 'purifier', 'aquaguard']],
    ['Internet installation', 'इंटरनेट इंस्टॉलेशन', 'इंटरनेट बसवणे', 'photo-1544197150-b99a580bb7a8', ['internet', 'wifi', 'broadband']],
    ['Mechanic', 'मैकेनिक', 'मेकॅनिक', 'photo-1486262715619-67b85e0b08d3', ['mechanic', 'bike', 'car']],
  ] as const;

  const serviceCategories: Record<string, string> = {};
  for (let index = 0; index < serviceInput.length; index += 1) {
    const [en, hi, mr, image, keywords] = serviceInput[index];
    const imageId = image.startsWith('photo-1631545806609') ? 'photo-1581092918056-0c4c3acd3789' : image;
    const category = await prisma.category.create({
      data: {
        kind: 'SERVICE',
        nameI18n: i18n(en, hi, mr),
        imageUrl: photo(imageId),
        searchKeywords: [...keywords],
        sortOrder: index + 1,
      },
    });
    serviceCategories[en] = category.id;
  }

  const listingInput = [
    ['Furniture', 'फर्नीचर', 'फर्निचर', ['furniture', 'sofa', 'bed', 'सोफा']],
    ['Phones and Electronics', 'फोन और इलेक्ट्रॉनिक्स', 'फोन आणि इलेक्ट्रॉनिक्स', ['phone', 'mobile', 'electronics']],
    ['Appliances', 'उपकरण', 'उपकरणे', ['appliance', 'mixer', 'fridge']],
    ['Baby Items', 'बच्चों का सामान', 'बाळाचे सामान', ['baby', 'cot', 'pram']],
    ['Books', 'किताबें', 'पुस्तके', ['books', 'kitaab']],
    ['Clothes', 'कपड़े', 'कपडे', ['clothes', 'kapde']],
    ['Bikes and Cars', 'बाइक और कार', 'बाइक आणि कार', ['bike', 'car', 'cycle']],
    ['Home Decor', 'घर की सजावट', 'घर सजावट', ['decor', 'curtain']],
    ['Gym Items', 'जिम का सामान', 'जिमचे सामान', ['gym', 'dumbbell']],
    ['Parking', 'पार्किंग', 'पार्किंग', ['parking', 'slot']],
    ['Room for rent', 'कमरा किराए पर', 'खोली भाड्याने', ['room', 'rent', 'flatmate']],
  ] as const;
  const listingCategories: string[] = [];
  for (let index = 0; index < listingInput.length; index += 1) {
    const [en, hi, mr, keywords] = listingInput[index];
    const category = await prisma.category.create({
      data: {
        kind: 'LISTING',
        nameI18n: i18n(en, hi, mr),
        imageUrl: photo('photo-1555041469-a586c61ea9bc'),
        searchKeywords: [...keywords],
        sortOrder: index + 1,
      },
    });
    listingCategories.push(category.id);
  }
  const listingCategory = { id: listingCategories[0] };

  const products = [
    ['Milk and Dairy', 'milk', 'Milk', 'दूध', 'दूध', '1 litre', '1 लीटर', '1 लीटर', 6800, ['milk', 'doodh', 'dudh', 'dood', 'दूध', 'taaza', 'amul'], 'photo-1550583724-b2692b85b150'],
    ['Milk and Dairy', 'milk', 'Curd', 'दही', 'दही', '500 g', '500 ग्राम', '500 ग्रॅम', 4000, ['curd', 'dahi', 'yogurt', 'दही'], 'photo-1488477181946-6428a0291777'],
    ['Milk and Dairy', 'milk', 'Paneer', 'पनीर', 'पनीर', '200 g', '200 ग्राम', '200 ग्रॅम', 9000, ['paneer', 'paneer', 'पनीर'], 'photo-1631452180519-c014fe946bc7'],
    ['Vegetables', 'veg', 'Tomato', 'टमाटर', 'टोमॅटो', '1 kg', '1 किलो', '1 किलो', 4000, ['tomato', 'tamatar', 'टमाटर'], 'photo-1546470427-227c7369a9e2'],
    ['Vegetables', 'veg', 'Onion', 'प्याज', 'कांदा', '1 kg', '1 किलो', '1 किलो', 3500, ['onion', 'pyaz', 'kanda', 'कांदा', 'प्याज'], 'photo-1618512496248-a07fe83aa8cb'],
    ['Vegetables', 'veg', 'Potato', 'आलू', 'बटाटा', '1 kg', '1 किलो', '1 किलो', 3000, ['potato', 'aloo', 'batata', 'आलू', 'बटाटा'], 'photo-1518977676601-b53f82aba655'],
    ['Vegetables', 'veg', 'Spinach', 'पालक', 'पालक', '1 bunch', '1 गड्डी', '1 जुडी', 2000, ['spinach', 'palak', 'पालक'], 'photo-1576045057995-568f588f82fb'],
    ['Fruits', 'veg', 'Banana', 'केला', 'केळी', '1 dozen', '1 दर्जन', '1 डझन', 5000, ['banana', 'kela', 'keli', 'केला'], 'photo-1571771894821-ce9b6c11b08e'],
    ['Fruits', 'veg', 'Apple', 'सेब', 'सफरचंद', '1 kg', '1 किलो', '1 किलो', 18000, ['apple', 'seb', 'सेब'], 'photo-1560806887-1e4cd0b6cbd6'],
    ['Grocery and Atta', 'grocer', 'Wheat flour', 'आटा', 'पीठ', '5 kg', '5 किलो', '5 किलो', 28000, ['atta', 'aata', 'wheat', 'आटा', 'पीठ', 'gehun'], 'photo-1574323347407-f5e1ad6d020b'],
    ['Grocery and Atta', 'grocer', 'Rice', 'चावल', 'तांदूळ', '5 kg', '5 किलो', '5 किलो', 42000, ['rice', 'chawal', 'tandul', 'चावल', 'तांदूळ'], 'photo-1586201375761-83865001e31c'],
    ['Grocery and Atta', 'grocer', 'Toor dal', 'तूर दाल', 'तूर डाळ', '1 kg', '1 किलो', '1 किलो', 16000, ['dal', 'toor', 'arhar', 'दाल', 'डाळ'], 'photo-1585996746348-1c1b0e0e0e0e'],
    ['Grocery and Atta', 'grocer', 'Sunflower oil', 'सूरजमुखी तेल', 'सूर्यफूल तेल', '1 litre', '1 लीटर', '1 लीटर', 15000, ['oil', 'tel', 'तेल'], 'photo-1474979266404-7eaacbcd87c5'],
    ['Cold Drinks and Snacks', 'grocer', 'Cola', 'कोल्ड ड्रिंक', 'कोल्ड ड्रिंक', '750 ml', '750 मिली', '750 मिली', 4000, ['cola', 'cold drink', 'thanda', 'कोल्ड'], 'photo-1554866585-cd94860890b7'],
    ['Cold Drinks and Snacks', 'grocer', 'Biscuits', 'बिस्कुट', 'बिस्किट', '1 pack', '1 पैक', '1 पॅक', 3000, ['biscuit', 'cookies', 'बिस्कुट'], 'photo-1558961363-fa8fdf82db35'],
    ['Festival Items', 'grocer', 'Diya pack', 'दिए', 'दिवे', '1 pack', '1 पैक', '1 पॅक', 9900, ['diya', 'diwali', 'diye', 'दिवा'], 'photo-1604594849809-dfedbc827105'],
    ['Cleaning Items', 'grocer', 'Floor cleaner', 'फर्श क्लीनर', 'फरशी क्लिनर', '1 litre', '1 लीटर', '1 लीटर', 18000, ['cleaner', 'phenyl', 'फिनाईल', 'safai'], 'photo-1563453392212-326f5e854473'],
    ['Cleaning Items', 'grocer', 'Detergent', 'डिटर्जेंट', 'डिटर्जंट', '1 kg', '1 किलो', '1 किलो', 12000, ['detergent', 'surf', 'washing', 'डिटर्जेंट'], 'photo-1610557892470-55d9e80c0bce'],
    ['Stationery', 'grocer', 'Notebook', 'कॉपी', 'वह्या', '1 piece', '1 नग', '1 नग', 4000, ['notebook', 'copy', 'वही', 'कॉपी'], 'photo-1531346878377-a5be20888e57'],
    ['Stationery', 'grocer', 'Pen pack', 'पेन', 'पेन', '10 pens', '10 पेन', '10 पेन', 5000, ['pen', 'pens', 'पेन'], 'photo-1583485088034-697b5bc54ccd'],
  ] as const;

  const productIds: Record<string, { id: string; mrp: number; image: string; vendorId: string }> = {};
  for (const row of products) {
    const [categoryName, vendorKey, en, hi, mr, unitEn, unitHi, unitMr, mrp, keywords, image] = row;
    const imageId = image.includes('1585996746348') ? 'photo-1614373532432-65b42f05f377' : image;
    const created = await prisma.product.create({
      data: {
        vendorId: vendors[vendorKey].id,
        categoryId: productCategories[categoryName],
        nameI18n: i18n(en, hi, mr),
        imageUrl: photo(imageId),
        unitI18n: i18n(unitEn, unitHi, unitMr),
        mrpPaise: mrp,
        searchKeywords: [...keywords],
      },
    });
    productIds[en] = { id: created.id, mrp, image: photo(imageId), vendorId: vendors[vendorKey].id };
  }

  const inDays = (days: number) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
  };

  const dealInput = [
    ['Milk', 2, 5, 2, [{ min: 1, price: 6000 }, { min: 2, price: 4800 }], 'EVENING'],
    ['Tomato', 5, 6, 3, [{ min: 5, price: 3000 }, { min: 10, price: 2500 }], 'MORNING'],
    ['Onion', 5, 6, 3, [{ min: 5, price: 2800 }, { min: 12, price: 2200 }], 'MORNING'],
    ['Wheat flour', 4, 4, 4, [{ min: 4, price: 25000 }, { min: 10, price: 23000 }], 'AFTERNOON'],
    ['Floor cleaner', 3, 3, 5, [{ min: 3, price: 15000 }, { min: 8, price: 13000 }], 'EVENING'],
  ] as const;

  for (const [name, minParticipants, cutoffDays, deliveryDays, tiers, slot] of dealInput) {
    const product = productIds[name];
    const productRow = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    await prisma.deal.create({
      data: {
        productId: product.id,
        vendorId: product.vendorId,
        titleI18n: productRow.nameI18n as Prisma.InputJsonValue,
        bannerUrl: product.image,
        minParticipants,
        maxQuantity: 5,
        cutoffAt: inDays(cutoffDays),
        deliveryDate: inDays(deliveryDays),
        deliverySlot: slot,
        status: 'OPEN',
        tiers: { create: tiers.map((tier) => ({ minParticipants: tier.min, pricePaise: tier.price })) },
        societies: { create: [{ societyId: society.id }, { societyId: other.id }] },
      },
    });
  }

  const providerNames = [
    ['Raju Electricals', 'Electrician'],
    ['Shinde Wires', 'Electrician'],
    ['Naik Plumbing', 'Plumber'],
    ['Patil Pipes', 'Plumber'],
    ['Bai Surekha', 'Maid'],
    ['Bai Lata', 'Maid'],
    ['Cook Anita', 'Cook'],
    ['Home Cook Ravi', 'Cook'],
    ['Cool Air AC', 'AC Repair'],
    ['Frost Care', 'AC Repair'],
    ['Sutar Ganesh', 'Carpenter'],
    ['Woodwork Ajay', 'Carpenter'],
  ] as const;

  let rajuId = '';
  for (let index = 0; index < providerNames.length; index += 1) {
    const [name, service] = providerNames[index];
    const provider = await prisma.serviceProvider.create({
      data: {
        categoryId: serviceCategories[service],
        name,
        phone: `+9198300000${String(index + 1).padStart(2, '0')}`,
        whatsapp: `+9198300000${String(index + 1).padStart(2, '0')}`,
        photoUrl: photo('photo-1506794778202-cad84cf45f1d'),
        areasServed: ['Virar West', 'Nalasopara'],
        isVerified: index % 2 === 0,
        isSponsored: index === 0,
        sponsorUntil: index === 0 ? inDays(30) : null,
      },
    });
    if (index === 0) rajuId = provider.id;
  }

  await prisma.providerRecommendation.createMany({
    data: [
      { providerId: rajuId, userId: residents[1].id, societyId: society.id, usedIt: true, rating: 5 },
      { providerId: rajuId, userId: residents[2].id, societyId: society.id, usedIt: true, rating: 4 },
    ],
  });

  const meeting = new Date();
  meeting.setDate(meeting.getDate() + 3);
  meeting.setHours(11, 0, 0, 0);
  await prisma.event.create({
    data: { societyId: society.id, title: 'Sunday meeting', place: 'Clubhouse', eventDate: meeting },
  });
  await prisma.poll.create({
    data: {
      societyId: society.id,
      question: 'When should the water tank be cleaned?',
      options: { create: [{ label: 'This Sunday' }, { label: 'Next Sunday' }] },
    },
  });

  const listingTitles = [
    'Wooden sofa',
    'Study table',
    'Steel almirah',
    'Baby cot',
    'Ceiling fan',
    'Gas stove',
    'Plastic chairs',
    'Bookshelf',
    'Dining table',
    'Mattress',
    'Water drum',
    'Kids bicycle',
    'Iron',
    'Curtains',
    'Shoe rack',
  ];
  for (let index = 0; index < listingTitles.length; index += 1) {
    await prisma.listing.create({
      data: {
        societyId: society.id,
        sellerId: residents[index + 2].id,
        categoryId: listingCategory.id,
        type: index === 7 ? 'FREE' : index === 10 ? 'RENT' : 'SELL',
        title: listingTitles[index],
        description: 'Used, working, pickup from the building gate.',
        pricePaise: index === 7 ? 0 : (index + 1) * 50000,
        photos: [photo('photo-1555041469-a586c61ea9bc')],
        contactWhatsappAllowed: true,
        contactCallAllowed: false,
        visibility: 'SOCIETY',
        status: 'ACTIVE',
        expiresAt: inDays(30),
      },
    });
  }

  await prisma.notice.createMany({
    data: [
      {
        societyId: society.id,
        authorId: residents[0].id,
        title: 'Water supply tomorrow morning',
        body: 'Water will come from 6 am to 8 am. Please store one bucket.',
        category: 'WATER',
        isPinned: true,
      },
      {
        societyId: society.id,
        authorId: residents[0].id,
        title: 'Society meeting on Sunday',
        body: 'Meeting at the clubhouse at 11 am. Maintenance is on the agenda.',
        category: 'MEETING',
      },
      {
        societyId: society.id,
        authorId: residents[0].id,
        title: 'Diwali cleaning on Friday',
        body: 'Please keep the corridor clear before 10 am.',
        category: 'FESTIVAL',
      },
    ],
  });

  await prisma.ad.create({
    data: {
      advertiserName: 'Joshi General Store',
      kind: 'VENDOR_STRIP',
      titleI18n: i18n('Joshi General Store', 'जोशी जनरल स्टोर', 'जोशी जनरल स्टोअर'),
      imageUrl: photo('photo-1578916171728-46686eac8d58'),
      actionType: 'WHATSAPP',
      actionValue: '+919820000003',
      startAt: inDays(-1),
      endAt: inDays(30),
      dailyImpressionCap: 5000,
      targetSocietyIds: [society.id],
      status: 'ACTIVE',
    },
  });

  try {
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS products_keywords_gin ON products USING GIN (search_keywords)',
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS categories_keywords_gin ON categories USING GIN (search_keywords)',
    );
  } catch (error) {
    console.warn('Search indexes were not created', error instanceof Error ? error.message : error);
  }

  console.log('Seeded Green Valley CHS code GV4K2M');
  console.log('Super admin +919000000000');
  console.log('Society admin +919100000001');
  console.log('Residents +919100000002 and +919100000003');
  console.log('Other society resident +919200000001');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
