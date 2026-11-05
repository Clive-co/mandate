import { KeyRing } from '../src/keys';

const keys = await KeyRing.generate();
console.log(`SIGNING_KEY_JWK='${JSON.stringify(keys.exportPrivateJwk())}'`);
console.log(`# kid: ${keys.kid}`);
console.log('# Put the first line in server/.env (or your host\'s secret store). It is a SECRET: it signs verdicts.');
console.log('# It never needs funds. The matching public key is served at /.well-known/jwks.json.');
