'use strict';

// Single source of truth for every CRM entity. The server builds tables and
// validates input from it; the browser renders lists and forms from it.
//
// Field types: text, textarea, email, phone, number, money, date, datetime,
// select, ref (foreign key to another resource), bool, file, and pricelist
// (rows of { label, <extra>, price }, e.g. bed or floor prices, stored as JSON).
//
// A ref field with `dependsOn` only offers choices that belong to the record
// picked in that other field (e.g. beds of the chosen room).

// Property types that are let out room-wise / bed-wise.
const SHARED_TYPES = ['PG / Hostel', 'BnB'];
// Property types that are let out bed-wise (PG, hostel). They get a bed count
// and bed price instead of a whole-property rent and status.
const BED_TYPES = ['PG / Hostel'];

// A field with `showFor` is only used for those property types; `hideFor` is
// used for every other type. Values of fields that don't apply are cleared.

const resources = {
  properties: {
    label: 'Properties',
    singular: 'Property',
    display: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true },
      {
        name: 'type',
        label: 'Type',
        type: 'select',
        options: [
          'PG / Hostel', 'BnB', 'Independent House', 'Villa', 'Apartment', 'SOHO', 'Office', 'Office Cabin', 'Co-working',
          'Shop', 'Showroom', 'Warehouse / Godown', 'Commercial', 'Land', 'Other',
        ],
        list: true,
      },
      { name: 'address', label: 'Address', type: 'textarea', required: true },
      { name: 'city', label: 'City', type: 'text', list: true },
      { name: 'total_beds', label: 'Total beds', type: 'number', min: 0, max: 5000, showFor: BED_TYPES, hint: 'Beds you add under Rooms count too; the larger number is used' },
      { name: 'rent_per_bed', label: 'Bed price (per month)', type: 'money', min: 0, showFor: BED_TYPES, hint: 'Default price for new rooms and beds' },
      {
        name: 'bed_prices',
        label: 'Bed prices',
        type: 'pricelist',
        showFor: BED_TYPES,
        item: { label: 'Bed type / floor', placeholder: 'e.g. 2-sharing AC, 1st floor' },
        extra: { name: 'beds', label: 'Qty (beds)', unit: 'beds' },
        priceLabel: 'Rate / bed',
        amount: true,
        addLabel: '+ Add line',
        hint: 'When beds cost different amounts (sharing, AC, floor…). Total beds is filled from these if left empty',
      },
      { name: 'pg_for', label: 'PG / hostel for', type: 'select', options: ['Gents', 'Ladies', 'Co-living', 'Students', 'Working professionals', 'Family', 'Anyone'], showFor: BED_TYPES },
      { name: 'meals', label: 'Meals (mess)', type: 'select', options: ['No food', 'Breakfast only', 'Breakfast & dinner', 'All 3 meals'], showFor: BED_TYPES },
      { name: 'gate_timings', label: 'Gate / in-time', type: 'text', placeholder: 'e.g. Gate closes 10:30 pm', showFor: BED_TYPES },
      { name: 'visiting_hours', label: 'Visiting hours', type: 'text', placeholder: 'e.g. 10 am – 7 pm, visitors in common area only', showFor: BED_TYPES },
      { name: 'warden_contact_id', label: 'Warden / caretaker', type: 'ref', ref: 'contacts', onDelete: 'SET NULL', showFor: BED_TYPES },
      { name: 'units', label: 'Units / floors', type: 'number', min: 0, hideFor: BED_TYPES },
      { name: 'area_sqft', label: 'Area (sq ft)', type: 'number', min: 0, hideFor: BED_TYPES },
      { name: 'furnishing', label: 'Furnishing', type: 'select', options: ['Unfurnished', 'Semi-furnished', 'Fully furnished', 'Bare shell', 'Warm shell'], hideFor: BED_TYPES },
      { name: 'monthly_rent', label: 'Expected rent', type: 'money', min: 0, list: true, hideFor: BED_TYPES },
      {
        name: 'floor_prices',
        label: 'Floor / unit prices',
        type: 'pricelist',
        hideFor: BED_TYPES,
        item: { label: 'Floor / unit', placeholder: 'e.g. Ground floor, Unit 2A' },
        extra: { name: 'area', label: 'Area (sq ft)', unit: 'sq ft' },
        priceLabel: 'Rent / month',
        addLabel: '+ Add line',
        hint: 'When floors or units in the same building are let at different rents',
      },
      { name: 'status', label: 'Status', type: 'select', options: ['Vacant', 'Occupied', 'Under Maintenance'], default: 'Vacant', list: true, hideFor: BED_TYPES },
      { name: 'owner_contact_id', label: 'Owner', type: 'ref', ref: 'contacts', onDelete: 'SET NULL' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  rooms: {
    label: 'Rooms',
    singular: 'Room',
    display: 'room_number',
    fields: [
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', required: true, onDelete: 'CASCADE', list: true },
      { name: 'room_number', label: 'Room no.', type: 'text', required: true, list: true },
      { name: 'floor', label: 'Floor', type: 'text' },
      { name: 'sharing', label: 'Sharing', type: 'select', options: ['Single', 'Double', 'Triple', 'Four', 'Five+', 'Dormitory', 'Private room', 'Entire unit'], list: true },
      { name: 'total_beds', label: 'Beds', type: 'number', required: true, min: 0, max: 50, default: 1, hint: 'Beds are created automatically for a new room', list: true },
      { name: 'rent_per_bed', label: 'Rent per bed', type: 'money', min: 0, list: true },
      { name: 'rent_per_room', label: 'Rent / tariff per room', type: 'money', min: 0 },
      { name: 'ac', label: 'AC', type: 'bool', default: 0 },
      { name: 'attached_bath', label: 'Attached bathroom', type: 'bool', default: 0 },
      { name: 'status', label: 'Status', type: 'select', options: ['Available', 'Under Maintenance', 'Blocked'], default: 'Available', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  beds: {
    label: 'Beds',
    singular: 'Bed',
    display: 'bed_label',
    fields: [
      { name: 'room_id', label: 'Room', type: 'ref', ref: 'rooms', required: true, onDelete: 'CASCADE', list: true },
      { name: 'bed_label', label: 'Bed', type: 'text', required: true, placeholder: 'e.g. Bed 1, Upper, Window', list: true },
      { name: 'monthly_rent', label: 'Monthly rent', type: 'money', min: 0, list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Available', 'Reserved', 'Under Maintenance', 'Blocked'], default: 'Available', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  tenants: {
    label: 'Tenants',
    singular: 'Tenant',
    display: 'full_name',
    fields: [
      { name: 'full_name', label: 'Full name', type: 'text', required: true, list: true },
      { name: 'phone', label: 'Phone', type: 'phone', list: true },
      { name: 'email', label: 'Email', type: 'email', list: true },
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', onDelete: 'SET NULL', list: true },
      { name: 'room_id', label: 'Room (PG / hostel / BnB)', type: 'ref', ref: 'rooms', dependsOn: 'property_id', onDelete: 'SET NULL' },
      { name: 'bed_id', label: 'Bed (PG / hostel)', type: 'ref', ref: 'beds', dependsOn: 'room_id', onDelete: 'SET NULL', list: true },
      { name: 'unit', label: 'Unit / Flat no.', type: 'text' },
      { name: 'move_in', label: 'Move-in date', type: 'date' },
      { name: 'move_out', label: 'Move-out date', type: 'date' },
      { name: 'id_type', label: 'ID type', type: 'select', options: ['Aadhaar', 'PAN', 'Passport', 'Driving Licence', 'Voter ID', 'Other'] },
      { name: 'id_number', label: 'ID number', type: 'text' },
      { name: 'emergency_contact', label: 'Emergency contact', type: 'text' },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Prospective', 'Former'], default: 'Active', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  agreements: {
    label: 'Agreements',
    singular: 'Agreement',
    display: 'id',
    fields: [
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', required: true, onDelete: 'RESTRICT', list: true },
      { name: 'room_id', label: 'Room (PG / hostel / BnB)', type: 'ref', ref: 'rooms', dependsOn: 'property_id', onDelete: 'RESTRICT' },
      { name: 'bed_id', label: 'Bed (PG / hostel)', type: 'ref', ref: 'beds', dependsOn: 'room_id', onDelete: 'RESTRICT' },
      { name: 'tenant_id', label: 'Tenant', type: 'ref', ref: 'tenants', required: true, onDelete: 'RESTRICT', list: true },
      { name: 'start_date', label: 'Start date', type: 'date', required: true, list: true },
      { name: 'end_date', label: 'End date', type: 'date', required: true, list: true },
      { name: 'monthly_rent', label: 'Monthly rent', type: 'money', required: true, min: 0, list: true },
      { name: 'security_deposit', label: 'Security deposit', type: 'money', min: 0 },
      { name: 'rent_due_day', label: 'Rent due day (1-28)', type: 'number', required: true, min: 1, max: 28, default: 5 },
      { name: 'notice_period_days', label: 'Notice period (days)', type: 'number', min: 0, default: 30 },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Draft', 'Expired', 'Terminated'], default: 'Active', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  rent_payments: {
    label: 'Rent payments',
    singular: 'Rent payment',
    display: 'period',
    fields: [
      { name: 'agreement_id', label: 'Agreement', type: 'ref', ref: 'agreements', required: true, onDelete: 'CASCADE', list: true },
      { name: 'period', label: 'Rent month (YYYY-MM)', type: 'month', required: true, list: true },
      { name: 'amount', label: 'Amount', type: 'money', required: true, min: 0, list: true },
      { name: 'paid_on', label: 'Paid on', type: 'date', required: true, list: true },
      { name: 'method', label: 'Method', type: 'select', options: ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Card', 'Other'], list: true },
      { name: 'reference', label: 'Reference / Txn ID', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  bills: {
    label: 'Bills',
    singular: 'Bill',
    display: 'category',
    fields: [
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', required: true, onDelete: 'CASCADE', list: true },
      { name: 'category', label: 'Category', type: 'select', required: true, options: ['Electricity', 'Water', 'Gas', 'Internet', 'Maintenance', 'Property Tax', 'Insurance', 'Repair', 'Other'], list: true },
      { name: 'provider', label: 'Provider', type: 'text' },
      { name: 'amount', label: 'Amount', type: 'money', required: true, min: 0, list: true },
      { name: 'bill_date', label: 'Bill date', type: 'date' },
      { name: 'due_date', label: 'Due date', type: 'date', required: true, list: true },
      { name: 'payer', label: 'Paid by', type: 'select', options: ['Owner', 'Tenant'], default: 'Owner' },
      { name: 'status', label: 'Status', type: 'select', options: ['Unpaid', 'Paid'], default: 'Unpaid', list: true },
      { name: 'paid_on', label: 'Paid on', type: 'date' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  contacts: {
    label: 'Contacts',
    singular: 'Contact',
    display: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true },
      { name: 'category', label: 'Category', type: 'select', options: ['Owner', 'Plumber', 'Electrician', 'Carpenter', 'Painter', 'Cleaner', 'Security', 'Warden', 'Cook', 'Agent', 'Lawyer', 'Society Office', 'Other'], list: true },
      { name: 'phone', label: 'Phone', type: 'phone', list: true },
      { name: 'email', label: 'Email', type: 'email', list: true },
      { name: 'company', label: 'Company', type: 'text' },
      { name: 'available_hours', label: 'Available hours', type: 'text', placeholder: 'e.g. Mon-Sat 9am-6pm', list: true },
      { name: 'address', label: 'Address', type: 'textarea' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  documents: {
    label: 'Documents',
    singular: 'Document',
    display: 'title',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, list: true },
      { name: 'doc_type', label: 'Document type', type: 'select', options: ['ID Proof', 'Address Proof', 'Rent Agreement', 'Police Verification', 'Ownership Deed', 'Tax Receipt', 'Bill', 'NOC', 'Photo', 'Other'], list: true },
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', onDelete: 'SET NULL' },
      { name: 'tenant_id', label: 'Tenant', type: 'ref', ref: 'tenants', onDelete: 'SET NULL', list: true },
      { name: 'agreement_id', label: 'Agreement', type: 'ref', ref: 'agreements', onDelete: 'SET NULL' },
      { name: 'file', label: 'File', type: 'file', list: true },
      { name: 'verified', label: 'Verified', type: 'bool', default: 0, list: true },
      { name: 'verified_by', label: 'Verified by', type: 'text' },
      { name: 'verified_on', label: 'Verified on', type: 'date' },
      { name: 'expires_on', label: 'Expires on', type: 'date', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  schedules: {
    label: 'Timings',
    singular: 'Appointment',
    display: 'title',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, list: true },
      { name: 'kind', label: 'Kind', type: 'select', options: ['Property Visit', 'Maintenance', 'Inspection', 'Meeting', 'Rent Collection', 'Move-in', 'Move-out', 'Other'], list: true },
      { name: 'starts_at', label: 'Starts at', type: 'datetime', required: true, list: true },
      { name: 'ends_at', label: 'Ends at', type: 'datetime' },
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', onDelete: 'SET NULL', list: true },
      { name: 'tenant_id', label: 'Tenant', type: 'ref', ref: 'tenants', onDelete: 'SET NULL' },
      { name: 'contact_id', label: 'Contact', type: 'ref', ref: 'contacts', onDelete: 'SET NULL' },
      { name: 'status', label: 'Status', type: 'select', options: ['Scheduled', 'Done', 'Cancelled'], default: 'Scheduled', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
};

// Whether a property field is used for the given property type.
function appliesTo(field, type) {
  if (field.showFor) return field.showFor.includes(type);
  if (field.hideFor) return !field.hideFor.includes(type);
  return true;
}

module.exports = { resources, SHARED_TYPES, BED_TYPES, appliesTo };
