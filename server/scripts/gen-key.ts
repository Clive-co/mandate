import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const key = generatePrivateKey();
console.log(`SIGNER_PRIVATE_KEY=${key}`);
console.log(`# signer address: ${privateKeyToAccount(key).address}`);
console.log('# Put the first line in server/.env. This key only signs decisions; it never needs funds.');
