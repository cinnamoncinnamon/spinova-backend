// Run this with: node generate_admin_password.mjs YourChosenPassword
// It prints a bcrypt hash you paste into spinova-backend/.env as ADMIN_PASSWORD_HASH.
// Run this INSIDE the spinova-backend folder (it needs bcrypt from node_modules).

import bcrypt from "bcrypt";

const password = process.argv[2];
if (!password) {
  console.error("Usage: node generate_admin_password.mjs YourChosenPassword");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Pick something longer than 8 characters — this protects your whole admin panel.");
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
console.log("\nAdd this line to spinova-backend/.env:\n");
console.log(`ADMIN_PASSWORD_HASH=${hash}`);
console.log("\n(and set ADMIN_USERNAME=whatever_you_want, plus a random ADMIN_JWT_SECRET)\n");
