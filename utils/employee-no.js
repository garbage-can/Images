export function normalizeEmployeeNo(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 32);
}
