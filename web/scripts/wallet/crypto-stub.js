// here-wallet only needs random bytes from node:crypto; the browser has them.
export default {}; export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
