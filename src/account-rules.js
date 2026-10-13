'use strict';

// Sign-up validation shared by the server (src/accounts.js) and the browser demo.

// "+91 98765-43210" -> "+919876543210". A bare 10-digit number gets the default country code.
function normalizePhone(raw, defaultCountryCode) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  let digits = s.replace(/\D/g, '');
  if (!s.startsWith('+')) {
    digits = digits.replace(/^0+/, '');
    if (digits.length === 10 && defaultCountryCode) digits = `${defaultCountryCode}${digits}`;
  }
  return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

// Returns { values, errors }; `errors` is empty when the input is acceptable.
function validateSignup(input, { defaultCountryCode, inviteCode }) {
  const errors = {};
  const values = {
    company_name: cleanText(input.company_name, 120),
    manager_name: cleanText(input.manager_name, 120),
    phone: normalizePhone(input.phone, defaultCountryCode),
    password: typeof input.password === 'string' ? input.password : '',
  };
  if (values.company_name.length < 2) errors.company_name = 'Company name is required';
  if (values.manager_name.length < 2) errors.manager_name = 'Manager name is required';
  if (!values.phone) errors.phone = 'Enter a valid phone number';
  if (values.password.length < 8) errors.password = 'Password must be at least 8 characters';
  else if (values.password.length > 200) errors.password = 'Password is too long';
  if (inviteCode && cleanText(input.invite_code, 100) !== inviteCode) errors.invite_code = 'Invite code is not valid';
  return { values, errors };
}

module.exports = { normalizePhone, cleanText, validateSignup };
