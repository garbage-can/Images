import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEmployeeNo } from '../utils/employee-no.js';
import { claimsFromUserinfo } from '../services/sso.js';

test('normalizeEmployeeNo trims spaces and uppercases', () => {
  assert.equal(normalizeEmployeeNo(' YL0005 '), 'YL0005');
  assert.equal(normalizeEmployeeNo('yl-0474'), 'YL-0474');
  assert.equal(normalizeEmployeeNo(null), '');
});

test('SSO claims map ERP number to employeeNo', () => {
  const claims = claimsFromUserinfo({
    email: 'it4@8dt.com',
    name: '袁茂林',
    number: ' yl1085 '
  });
  assert.equal(claims.email, 'it4@8dt.com');
  assert.equal(claims.employeeNo, 'YL1085');
});
