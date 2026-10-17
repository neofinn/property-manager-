'use strict';

// Single source of truth for every PG Manager entity. The server builds tables
// and validates input from it; the browser renders lists and forms from it.
//
// Field types: text, textarea, email, phone, number, money, date, month,
// select, ref (foreign key to another resource), bool, file, and pricelist
// (rows of { label, <extra>, price }, stored as JSON).
//
// A ref field with `dependsOn` only offers choices that belong to the record
// picked in that other field (e.g. beds of the chosen PG).

// Guests in these states hold their bed.
const BED_HOLDING = ['Active', 'Booked'];

const resources = {
  pgs: {
    label: 'PGs',
    singular: 'PG',
    display: 'name',
    fields: [
      { name: 'name', label: 'PG name', type: 'text', required: true, list: true, section: 'PG' },
      { name: 'address', label: 'Address', type: 'textarea', required: true },
      { name: 'city', label: 'City', type: 'text', list: true },
      { name: 'pg_for', label: 'PG for', type: 'select', options: ['Gents', 'Ladies', 'Co-living', 'Students', 'Working professionals', 'Anyone'], list: true },
      { name: 'total_beds', section: 'Beds & prices', label: 'Total beds', type: 'number', min: 0, max: 5000, hint: 'Beds are created automatically. Left empty, it is the sum of the bed price lines' },
      {
        name: 'bed_prices',
        label: 'Bed prices',
        type: 'pricelist',
        item: { label: 'Bed type', placeholder: 'e.g. 2-sharing AC, 1st floor' },
        extra: { name: 'beds', label: 'Qty (beds)', unit: 'beds' },
        priceLabel: 'Rate / bed',
        amount: true,
        addLabel: '+ Add line',
        hint: 'Beds of each type are created with this rate. Changing a rate updates the beds of that type',
      },
      { name: 'rent_per_bed', label: 'Default bed rate', type: 'money', min: 0, hint: 'For beds beyond the price lines' },
      { name: 'rent_due_day', label: 'Rent due day (1-28)', type: 'number', min: 1, max: 28, default: 5 },
      { name: 'meals', label: 'Meals (mess)', type: 'select', options: ['No food', 'Breakfast only', 'Breakfast & dinner', 'All 3 meals'], section: 'Rules & staff' },
      { name: 'gate_timings', label: 'Gate / in-time', type: 'text', placeholder: 'e.g. Gate closes 10:30 pm' },
      { name: 'visiting_hours', label: 'Visiting hours', type: 'text', placeholder: 'e.g. 10 am – 7 pm' },
      { name: 'warden_contact_id', label: 'Warden / caretaker', type: 'ref', ref: 'contacts', onDelete: 'SET NULL' },
      { name: 'owner_contact_id', label: 'Owner', type: 'ref', ref: 'contacts', onDelete: 'SET NULL' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  beds: {
    label: 'Beds',
    singular: 'Bed',
    display: 'bed_label',
    fields: [
      { name: 'pg_id', label: 'PG', type: 'ref', ref: 'pgs', required: true, onDelete: 'CASCADE', list: true },
      { name: 'bed_label', label: 'Bed', type: 'text', required: true, placeholder: 'e.g. B1, Window bed', list: true },
      { name: 'bed_type', label: 'Bed type', type: 'text', placeholder: 'e.g. 2-sharing AC', list: true },
      { name: 'rent', label: 'Rate / month', type: 'money', min: 0, list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Available', 'Under Maintenance', 'Blocked'], default: 'Available', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  guests: {
    label: 'Guests',
    singular: 'Guest',
    display: 'full_name',
    fields: [
      { name: 'full_name', label: 'Full name', type: 'text', required: true, list: true, section: 'Guest' },
      { name: 'phone', label: 'Phone', type: 'phone', required: true, list: true },
      { name: 'pg_id', label: 'PG', type: 'ref', ref: 'pgs', onDelete: 'SET NULL', list: true, section: 'Bed, stay & rent' },
      { name: 'bed_id', label: 'Bed', type: 'ref', ref: 'beds', dependsOn: 'pg_id', onDelete: 'SET NULL', list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Booked', 'Checked out'], default: 'Active', list: true },
      { name: 'check_in', label: 'Check-in date', type: 'date', list: true },
      { name: 'check_out', label: 'Check-out date', type: 'date', hint: 'Planned or actual' },
      { name: 'rent', label: 'Monthly rent', type: 'money', min: 0, list: true, hint: "Taken from the bed's rate if left empty" },
      { name: 'deposit', label: 'Security deposit', type: 'money', min: 0 },
      { name: 'rent_due_day', label: 'Rent due day (1-28)', type: 'number', min: 1, max: 28, hint: "The PG's due day if left empty" },
      { name: 'email', label: 'Email', type: 'email', section: 'Personal details' },
      { name: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'] },
      { name: 'date_of_birth', label: 'Date of birth', type: 'date' },
      { name: 'occupation', label: 'Occupation', type: 'select', options: ['Student', 'Working professional', 'Business', 'Other'] },
      { name: 'organisation', label: 'College / company', type: 'text' },
      { name: 'food', label: 'Food preference', type: 'select', options: ['Veg', 'Non-veg', 'Eggetarian', 'No meals'] },
      { name: 'permanent_address', label: 'Permanent address', type: 'textarea' },
      { name: 'id_type', label: 'ID type', type: 'select', options: ['Aadhaar', 'PAN', 'Passport', 'Driving Licence', 'Voter ID', 'College ID', 'Other'], section: 'ID & verification' },
      { name: 'id_number', label: 'ID number', type: 'text' },
      { name: 'id_proof', label: 'ID proof', type: 'file' },
      { name: 'photo', label: 'Photo', type: 'file' },
      { name: 'police_verified', label: 'Police verification done', type: 'bool', default: 0 },
      { name: 'emergency_name', label: 'Emergency contact name', type: 'text', section: 'Emergency contact' },
      { name: 'emergency_phone', label: 'Emergency contact phone', type: 'phone' },
      { name: 'emergency_relation', label: 'Relation', type: 'select', options: ['Father', 'Mother', 'Guardian', 'Spouse', 'Sibling', 'Friend', 'Other'] },
      { name: 'vehicle_number', label: 'Vehicle number', type: 'text', section: 'Other' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  payments: {
    label: 'Payments',
    singular: 'Payment',
    display: 'period',
    fields: [
      { name: 'guest_id', label: 'Guest', type: 'ref', ref: 'guests', required: true, onDelete: 'CASCADE', list: true },
      { name: 'kind', label: 'For', type: 'select', options: ['Rent', 'Deposit', 'Electricity', 'Food', 'Other'], default: 'Rent', list: true },
      { name: 'period', label: 'Month (YYYY-MM)', type: 'month', required: true, list: true },
      { name: 'amount', label: 'Amount', type: 'money', required: true, min: 0, list: true },
      { name: 'paid_on', label: 'Paid on', type: 'date', required: true, list: true },
      { name: 'method', label: 'Method', type: 'select', options: ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Card', 'Other'], list: true },
      { name: 'reference', label: 'Reference / Txn ID', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  bills: {
    label: 'Expenses',
    singular: 'Expense',
    display: 'category',
    fields: [
      { name: 'pg_id', label: 'PG', type: 'ref', ref: 'pgs', required: true, onDelete: 'CASCADE', list: true },
      { name: 'category', label: 'Category', type: 'select', required: true, options: ['Electricity', 'Water', 'Gas', 'Internet', 'Groceries', 'Salary', 'Rent to owner', 'Maintenance', 'Repair', 'Other'], list: true },
      { name: 'provider', label: 'Paid to', type: 'text' },
      { name: 'amount', label: 'Amount', type: 'money', required: true, min: 0, list: true },
      { name: 'due_date', label: 'Due date', type: 'date', required: true, list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Unpaid', 'Paid'], default: 'Unpaid', list: true },
      { name: 'paid_on', label: 'Paid on', type: 'date' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  documents: {
    label: 'Documents',
    singular: 'Document',
    display: 'title',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, list: true },
      { name: 'doc_type', label: 'Document type', type: 'select', options: ['ID Proof', 'Address Proof', 'Police Verification', 'Rental Agreement', 'Photo', 'Licence', 'Bill', 'Other'], list: true },
      { name: 'guest_id', label: 'Guest', type: 'ref', ref: 'guests', onDelete: 'SET NULL', list: true },
      { name: 'pg_id', label: 'PG', type: 'ref', ref: 'pgs', onDelete: 'SET NULL' },
      { name: 'file', label: 'File', type: 'file', list: true },
      { name: 'verified', label: 'Verified', type: 'bool', default: 0, list: true },
      { name: 'verified_by', label: 'Verified by', type: 'text' },
      { name: 'verified_on', label: 'Verified on', type: 'date' },
      { name: 'expires_on', label: 'Expires on', type: 'date', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  contacts: {
    label: 'Staff & contacts',
    singular: 'Contact',
    display: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true },
      { name: 'category', label: 'Category', type: 'select', options: ['Owner', 'Warden', 'Cook', 'Cleaner', 'Security', 'Plumber', 'Electrician', 'Carpenter', 'Grocery', 'Agent', 'Other'], list: true },
      { name: 'phone', label: 'Phone', type: 'phone', list: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'available_hours', label: 'Available hours', type: 'text', placeholder: 'e.g. Mon-Sat 9am-6pm', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
};

// Kept for code shared with the Property Manager app (on its own branch): no field depends on a type.
function appliesTo() {
  return true;
}

module.exports = { resources, BED_HOLDING, appliesTo };
