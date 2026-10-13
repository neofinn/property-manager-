'use strict';

// Fills an empty database with sample data so you can try the app.
// Usage: npm run seed   (respects DATA_DIR)

const path = require('node:path');
const db = require('../src/db');
const { Store } = require('../src/store');
const { localToday, addDays, addMonths } = require('../src/reminders');

const database = db.open(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const store = new Store(database);

if (database.prepare('SELECT COUNT(*) AS n FROM properties').get().n > 0) {
  console.log('Database already has data; skipping seed.');
  process.exit(0);
}

const today = localToday();
const thisMonth = today.slice(0, 7);

const owner = store.create('contacts', { name: 'Ravi Sharma', category: 'Owner', phone: '+91 98765 43210', email: 'ravi@example.com' });
const plumber = store.create('contacts', { name: 'Suresh Plumbing', category: 'Plumber', phone: '+91 91234 56789', available_hours: 'Mon-Sat 9am-7pm' });
store.create('contacts', { name: 'Bright Electricals', category: 'Electrician', phone: '+91 99887 76655', available_hours: 'Daily 10am-8pm' });

const p1 = store.create('properties', { name: 'Green Park 2BHK', type: 'Apartment', address: 'Flat 302, Green Park Residency, MG Road', city: 'Bengaluru', units: 1, monthly_rent: 25000, status: 'Occupied', owner_contact_id: owner.id });
const p2 = store.create('properties', { name: 'Lake View Villa', type: 'Villa', address: '14 Lake View Road', city: 'Pune', units: 1, monthly_rent: 60000, status: 'Occupied', owner_contact_id: owner.id });
const p3 = store.create('properties', { name: 'City Centre Shop', type: 'Commercial', address: 'Shop 5, City Centre Mall', city: 'Bengaluru', units: 1, monthly_rent: 40000, status: 'Vacant' });

const t1 = store.create('tenants', { full_name: 'Anita Desai', phone: '+91 90000 11111', email: 'anita@example.com', property_id: p1.id, unit: '302', move_in: addDays(today, -200), id_type: 'Aadhaar', id_number: 'XXXX-XXXX-1234', status: 'Active' });
const t2 = store.create('tenants', { full_name: 'Karan Mehta', phone: '+91 90000 22222', email: 'karan@example.com', property_id: p2.id, move_in: addDays(today, -330), id_type: 'PAN', id_number: 'ABCDE1234F', status: 'Active' });
store.create('tenants', { full_name: 'Neha Kapoor', phone: '+91 90000 33333', property_id: p3.id, status: 'Prospective' });

const a1 = store.create('agreements', { property_id: p1.id, tenant_id: t1.id, start_date: addDays(today, -200), end_date: addDays(today, 165), monthly_rent: 25000, security_deposit: 75000, rent_due_day: 5 });
const a2 = store.create('agreements', { property_id: p2.id, tenant_id: t2.id, start_date: addDays(today, -330), end_date: addDays(today, 35), monthly_rent: 60000, security_deposit: 180000, rent_due_day: 1 });

// Pay all past months except the current one for tenant 1, and a partial payment for tenant 2.
for (let period = a1.start_date.slice(0, 7); period < thisMonth; period = addMonths(period, 1)) {
  store.create('rent_payments', { agreement_id: a1.id, period, amount: 25000, paid_on: `${period}-04`, method: 'UPI' });
}
for (let period = a2.start_date.slice(0, 7); period < thisMonth; period = addMonths(period, 1)) {
  store.create('rent_payments', { agreement_id: a2.id, period, amount: 60000, paid_on: `${period}-01`, method: 'Bank Transfer' });
}
store.create('rent_payments', { agreement_id: a2.id, period: thisMonth, amount: 30000, paid_on: today, method: 'Bank Transfer', notes: 'Half paid, rest promised next week' });

// A PG let out bed-wise and a BnB let out room-wise.
const pg = store.create('properties', { name: 'Sunrise PG', type: 'PG', pg_for: 'Gents', food_included: true, address: '22 4th Cross, Koramangala', city: 'Bengaluru', units: 3, status: 'Occupied', owner_contact_id: owner.id });
const r101 = store.create('rooms', { property_id: pg.id, room_number: '101', floor: '1', sharing: 'Double', total_beds: 2, rent_per_bed: 9000, ac: true, attached_bath: true });
store.create('rooms', { property_id: pg.id, room_number: '102', floor: '1', sharing: 'Triple', total_beds: 3, rent_per_bed: 7000, attached_bath: true });
store.create('rooms', { property_id: pg.id, room_number: '201', floor: '2', sharing: 'Single', total_beds: 1, rent_per_bed: 13000, ac: true });
const [bed1] = store.list('beds', { room_id: r101.id, sort: 'bed_label', dir: 'asc' });
const t4 = store.create('tenants', { full_name: 'Rahul Verma', phone: '+91 90000 44444', bed_id: bed1.id, move_in: addDays(today, -40), id_type: 'Aadhaar', status: 'Active' });
store.create('agreements', { tenant_id: t4.id, bed_id: bed1.id, start_date: addDays(today, -40), end_date: addDays(today, 325), security_deposit: 18000, rent_due_day: 5 });
const bnb = store.create('properties', { name: 'Hilltop Homestay', type: 'BnB', address: '8 Coffee Estate Road', city: 'Coorg', status: 'Vacant' });
store.create('rooms', { property_id: bnb.id, room_number: 'Garden Suite', sharing: 'Private room', total_beds: 0, rent_per_room: 3500 });

store.create('bills', { property_id: p1.id, category: 'Electricity', provider: 'BESCOM', amount: 1840, bill_date: addDays(today, -12), due_date: addDays(today, 3), payer: 'Tenant' });
store.create('bills', { property_id: p2.id, category: 'Property Tax', amount: 12500, due_date: addDays(today, -4), payer: 'Owner' });
store.create('bills', { property_id: p1.id, category: 'Maintenance', provider: 'Society', amount: 3000, due_date: addDays(today, -20), status: 'Paid', paid_on: addDays(today, -22) });

store.create('documents', { title: 'Anita – Aadhaar card', doc_type: 'ID Proof', tenant_id: t1.id, verified: true, verified_by: 'Ravi', verified_on: addDays(today, -199) });
store.create('documents', { title: 'Karan – Police verification', doc_type: 'Police Verification', tenant_id: t2.id, verified: false });
store.create('documents', { title: 'Lake View rent agreement', doc_type: 'Rent Agreement', agreement_id: a2.id, property_id: p2.id, verified: true, expires_on: a2.end_date });

store.create('schedules', { title: 'Fix kitchen tap leak', kind: 'Maintenance', starts_at: `${addDays(today, 1)}T10:00`, ends_at: `${addDays(today, 1)}T11:00`, property_id: p1.id, contact_id: plumber.id });
store.create('schedules', { title: 'Show shop to Neha', kind: 'Property Visit', starts_at: `${addDays(today, 2)}T17:30`, property_id: p3.id });

console.log('Sample data added.');
