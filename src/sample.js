'use strict';

// Demo data for trying PG Manager. Beta testers can load it from the dashboard
// of an empty account, and `npm run seed` creates a demo account with it.

const { localToday, addDays, addMonths } = require('./reminders');

async function isEmpty(db) {
  return (await db.get('SELECT COUNT(*) AS n FROM pgs')).n === 0;
}

async function loadSampleData(store) {
  const today = localToday();
  const thisMonth = today.slice(0, 7);

  const owner = await store.create('contacts', { name: 'Ravi Sharma', category: 'Owner', phone: '+91 98765 43210' });
  const warden = await store.create('contacts', { name: 'Mohan (Warden)', category: 'Warden', phone: '+91 90000 55555', available_hours: '24x7' });
  await store.create('contacts', { name: 'Lakshmi (Cook)', category: 'Cook', phone: '+91 90000 66666', available_hours: '6 am – 9 pm' });
  await store.create('contacts', { name: 'Suresh Plumbing', category: 'Plumber', phone: '+91 91234 56789', available_hours: 'Mon-Sat 9am-7pm' });

  const sunrise = await store.create('pgs', {
    name: 'Sunrise PG',
    address: '22 4th Cross, Koramangala',
    city: 'Bengaluru',
    pg_for: 'Gents',
    bed_prices: [
      { label: 'Single AC', beds: 2, price: 13000 },
      { label: '2-sharing AC', beds: 4, price: 9000 },
      { label: '3-sharing', beds: 6, price: 7000 },
    ],
    rent_due_day: 5,
    meals: 'Breakfast & dinner',
    gate_timings: 'Gate closes 10:30 pm',
    visiting_hours: '10 am – 7 pm',
    warden_contact_id: warden.id,
    owner_contact_id: owner.id,
  });
  const lotus = await store.create('pgs', {
    name: 'Lotus Ladies Hostel',
    address: '9 MG Road',
    city: 'Pune',
    pg_for: 'Ladies',
    total_beds: 8,
    bed_prices: [{ label: '2-sharing', beds: 4, price: 8500 }],
    rent_per_bed: 6500,
    rent_due_day: 1,
    meals: 'All 3 meals',
    gate_timings: 'Gate closes 9:30 pm',
  });

  const beds = async (pg) => store.list('beds', { pg_id: pg.id, sort: 'id', dir: 'asc' });
  const [s1, , s3, s4, , , s7, s8] = await beds(sunrise);
  const [l1, l2, , , l5] = await beds(lotus);

  const guest = (bed, data) => store.create('guests', { bed_id: bed.id, status: 'Active', ...data });
  const g1 = await guest(s1, { full_name: 'Rahul Verma', phone: '+91 90000 44444', check_in: addDays(today, -95), deposit: 13000, occupation: 'Working professional', organisation: 'Infosys', food: 'Veg', id_type: 'Aadhaar', id_number: 'XXXX-XXXX-4321', emergency_name: 'Suresh Verma', emergency_phone: '+91 90000 40000', emergency_relation: 'Father', police_verified: true });
  const g2 = await guest(s3, { full_name: 'Arjun Nair', phone: '+91 90000 22222', check_in: addDays(today, -60), deposit: 9000, occupation: 'Student', organisation: 'Christ University', food: 'Non-veg', id_type: 'College ID' });
  await guest(s4, { full_name: 'Vikram Singh', phone: '+91 90000 33333', check_in: addDays(today, -20), check_out: addDays(today, 5), deposit: 9000, occupation: 'Working professional' });
  await guest(s7, { full_name: 'Imran Khan', phone: '+91 90000 77777', check_in: addDays(today, -10), deposit: 7000, food: 'Non-veg' });
  await store.create('guests', { full_name: 'Dev Patel', phone: '+91 90000 88888', bed_id: s8.id, status: 'Booked', check_in: addDays(today, 3) });
  const g6 = await guest(l1, { full_name: 'Priya Iyer', phone: '+91 90000 11111', check_in: addDays(today, -150), deposit: 8500, occupation: 'Working professional', organisation: 'TCS', gender: 'Female', police_verified: true });
  await guest(l2, { full_name: 'Sneha Kulkarni', phone: '+91 90000 12121', check_in: addDays(today, -45), deposit: 8500, occupation: 'Student', gender: 'Female' });
  await guest(l5, { full_name: 'Ananya Rao', phone: '+91 90000 13131', check_in: addDays(today, -30), gender: 'Female' });
  await store.create('guests', { full_name: 'Meera Joshi', phone: '+91 90000 14141', pg_id: lotus.id, status: 'Checked out', check_in: addDays(today, -300), check_out: addDays(today, -40), rent: 6500 });

  // Rent paid for past months; this month only some guests have paid.
  const payAll = async (g, upTo) => {
    for (let period = g.check_in.slice(0, 7); period < upTo; period = addMonths(period, 1)) {
      await store.create('payments', { guest_id: g.id, kind: 'Rent', period, amount: g.rent, paid_on: `${period}-0${Math.min(g.rent_due_day || 5, 9)}`, method: 'UPI' });
    }
  };
  await payAll(g1, addMonths(thisMonth, 1));
  await payAll(g2, thisMonth);
  await payAll(g6, addMonths(thisMonth, 1));
  for (const g of await store.list('guests', { status: 'Active' })) {
    if (['Sneha Kulkarni', 'Vikram Singh'].includes(g.full_name)) await payAll(g, thisMonth);
  }
  await store.create('payments', { guest_id: g1.id, kind: 'Deposit', period: g1.check_in.slice(0, 7), amount: 13000, paid_on: g1.check_in, method: 'Bank Transfer' });

  await store.create('bills', { pg_id: sunrise.id, category: 'Electricity', provider: 'BESCOM', amount: 18400, due_date: addDays(today, 3) });
  await store.create('bills', { pg_id: sunrise.id, category: 'Groceries', provider: 'Metro Wholesale', amount: 22500, due_date: addDays(today, -2) });
  await store.create('bills', { pg_id: lotus.id, category: 'Salary', provider: 'Cook and cleaner', amount: 24000, due_date: addDays(today, -10), status: 'Paid', paid_on: addDays(today, -10) });

  await store.create('documents', { title: 'Rahul – Aadhaar card', doc_type: 'ID Proof', guest_id: g1.id, verified: true, verified_by: 'Mohan', verified_on: addDays(today, -94) });
  await store.create('documents', { title: 'Arjun – Police verification', doc_type: 'Police Verification', guest_id: g2.id, verified: false });
  await store.create('documents', { title: 'Sunrise PG – Trade licence', doc_type: 'Licence', pg_id: sunrise.id, verified: true, expires_on: addDays(today, 20) });
}

module.exports = { loadSampleData, isEmpty };
