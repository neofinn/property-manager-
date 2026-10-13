'use strict';

// Single source of truth for every CRM entity. The server builds tables and
// validates input from it; the browser renders lists and forms from it.
//
// Field types: text, textarea, email, phone, number, money, date, datetime,
// select, ref (foreign key to another resource), bool, file.

const resources = {
  properties: {
    label: 'Properties',
    singular: 'Property',
    display: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true },
      { name: 'type', label: 'Type', type: 'select', options: ['Apartment', 'House', 'Villa', 'Commercial', 'Office', 'Land', 'Other'], list: true },
      { name: 'address', label: 'Address', type: 'textarea', required: true },
      { name: 'city', label: 'City', type: 'text', list: true },
      { name: 'units', label: 'Units', type: 'number', min: 0 },
      { name: 'monthly_rent', label: 'Expected rent', type: 'money', min: 0, list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Vacant', 'Occupied', 'Under Maintenance'], default: 'Vacant', list: true },
      { name: 'owner_contact_id', label: 'Owner', type: 'ref', ref: 'contacts', onDelete: 'SET NULL' },
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
      { name: 'category', label: 'Category', type: 'select', options: ['Owner', 'Plumber', 'Electrician', 'Carpenter', 'Painter', 'Cleaner', 'Security', 'Agent', 'Lawyer', 'Society Office', 'Other'], list: true },
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

module.exports = { resources };
